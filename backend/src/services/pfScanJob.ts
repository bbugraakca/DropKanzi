import { Prisma } from "@prisma/client";
import { enqueuePfScanJob, getPfScanQueue } from "./queue";
import { prisma, currentTenantId } from "./db";
import { publishCancel, clearCancel } from "./pfScanProgress";

export type PfScanType = "sold" | "active";

export type CreatePfScanInput = {
  seller: string;
  scanType: PfScanType;
  daysBack: number;
  forceRefresh: boolean;
  fetchPrices?: boolean;
  storeSettings?: Record<string, unknown>;
};

function slugJobIdPart(value: string): string {
  return (
    String(value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

export function buildPfScanJobId(input: CreatePfScanInput, tenantId = currentTenantId()): string {
  const scanType = slugJobIdPart(input.scanType);
  const tenant = slugJobIdPart(tenantId);
  const seller = slugJobIdPart(input.seller);
  const daysBack = Number.isFinite(input.daysBack) ? Math.round(input.daysBack) : 30;
  const refresh = input.forceRefresh ? "fresh" : "cache";
  return `${scanType}-${tenant}-${seller}-${daysBack}-${refresh}`;
}

async function clearStalePfScanQueueJob(jobId: string): Promise<"busy" | "cleared" | "missing"> {
  const job = await getPfScanQueue().getJob(jobId);
  if (!job) return "missing";
  const state = await job.getState();
  if (state === "active" || state === "waiting" || state === "delayed") {
    return "busy";
  }
  await job.remove();
  return "cleared";
}

export async function createPfScanJob(input: CreatePfScanInput): Promise<{ jobId: string; created: boolean }> {
  const tenantId = currentTenantId();
  const jobId = buildPfScanJobId(input, tenantId);
  const existing = await prisma.pfScanJob.findUnique({ where: { id: jobId } });
  if (existing && (existing.status === "queued" || existing.status === "active")) {
    return { jobId, created: false };
  }

  const queueSlot = await clearStalePfScanQueueJob(jobId);
  if (queueSlot === "busy") {
    return { jobId, created: false };
  }

  await prisma.pfScanJob.upsert({
    where: { id: jobId },
    create: {
      id: jobId,
      tenantId,
      seller: input.seller,
      scanType: input.scanType,
      daysBack: input.daysBack,
      forceRefresh: input.forceRefresh,
      status: "queued",
    },
    update: {
      tenantId,
      seller: input.seller,
      scanType: input.scanType,
      daysBack: input.daysBack,
      forceRefresh: input.forceRefresh,
      status: "queued",
      stage: null,
      progress: Prisma.JsonNull,
      error: null,
      result: Prisma.JsonNull,
    },
  });

  await clearCancel(jobId);

  try {
    await enqueuePfScanJob(jobId, {
      tenantId,
      seller: input.seller,
      scanType: input.scanType,
      daysBack: input.daysBack,
      forceRefresh: input.forceRefresh,
      fetchPrices: input.fetchPrices !== false,
      storeSettings: input.storeSettings ?? {},
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/already exists/i.test(msg)) {
      await clearStalePfScanQueueJob(jobId);
      await enqueuePfScanJob(jobId, {
        tenantId,
        seller: input.seller,
        scanType: input.scanType,
        daysBack: input.daysBack,
        forceRefresh: input.forceRefresh,
        fetchPrices: input.fetchPrices !== false,
        storeSettings: input.storeSettings ?? {},
      });
    } else {
      throw err;
    }
  }
  return { jobId, created: true };
}

export async function listPfScanJobs(status?: string) {
  const tenantId = currentTenantId();
  return prisma.pfScanJob.findMany({
    where: {
      tenantId,
      ...(status ? { status } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

export async function getPfScanJobById(jobId: string) {
  const tenantId = currentTenantId();
  return prisma.pfScanJob.findFirst({ where: { id: jobId, tenantId } });
}

export async function updatePfScanJob(
  jobId: string,
  patch: {
    status?: string;
    stage?: string | null;
    progress?: Prisma.InputJsonValue | null;
    error?: string | null;
    result?: Prisma.InputJsonValue | null;
  }
) {
  return prisma.pfScanJob.update({
    where: { id: jobId },
    data: {
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.stage !== undefined ? { stage: patch.stage } : {}),
      ...(patch.progress !== undefined ? { progress: patch.progress ?? Prisma.JsonNull } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.result !== undefined ? { result: patch.result ?? Prisma.JsonNull } : {}),
    },
  });
}

export async function cancelPfScan(jobId: string): Promise<{ cancelled: boolean; status: string }> {
  const row = await prisma.pfScanJob.findUnique({ where: { id: jobId } });
  if (!row) return { cancelled: false, status: "missing" };
  if (row.status === "done" || row.status === "failed" || row.status === "canceled") {
    return { cancelled: false, status: row.status };
  }
  const job = await getPfScanQueue().getJob(jobId);
  if (job) {
    const state = await job.getState();
    if (state === "waiting" || state === "delayed") {
      await job.remove();
    }
  }
  await prisma.pfScanJob.update({
    where: { id: jobId },
    data: { status: "canceled", stage: null, error: "Canceled by user" },
  });
  await publishCancel(jobId);
  return { cancelled: true, status: "canceled" };
}

/** Remove job from BullMQ (if idle) and delete DB row — for completed/canceled queue cleanup. */
export async function removePfScanJob(jobId: string): Promise<{ removed: boolean }> {
  const row = await prisma.pfScanJob.findUnique({ where: { id: jobId } });
  if (!row) return { removed: false };

  if (row.status === "active" || row.status === "queued") {
    await cancelPfScan(jobId);
  }

  const job = await getPfScanQueue().getJob(jobId);
  if (job) {
    const state = await job.getState();
    if (state !== "active") {
      await job.remove();
    }
  }

  await prisma.pfScanJob.delete({ where: { id: jobId } });
  return { removed: true };
}

/** Delete all scan jobs for a seller (e.g. smoke-test cleanup). */
export async function removePfScanJobsBySeller(seller: string): Promise<number> {
  const tenantId = currentTenantId();
  const needle = seller.trim().toLowerCase();
  if (!needle) return 0;

  const rows = await prisma.pfScanJob.findMany({
    where: {
      tenantId,
      OR: [
        { seller: { equals: seller, mode: "insensitive" } },
        { id: { contains: slugJobIdPart(seller), mode: "insensitive" } },
      ],
    },
    select: { id: true },
  });

  let removed = 0;
  for (const row of rows) {
    const out = await removePfScanJob(row.id);
    if (out.removed) removed += 1;
  }
  return removed;
}
