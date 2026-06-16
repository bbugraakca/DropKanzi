import { Prisma } from "@prisma/client";
import { enqueuePfScanJob, getPfScanQueue } from "./queue";
import { prisma, currentTenantId } from "./db";
import { publishCancel } from "./pfScanProgress";

export type PfScanType = "sold" | "active";

export type CreatePfScanInput = {
  seller: string;
  scanType: PfScanType;
  daysBack: number;
  forceRefresh: boolean;
  fetchPrices?: boolean;
  storeSettings?: Record<string, unknown>;
};

export function buildPfScanJobId(input: CreatePfScanInput, tenantId = currentTenantId()): string {
  return `${input.scanType}:${tenantId}:${input.seller}:${input.daysBack}:${input.forceRefresh ? "fresh" : "cache"}`;
}

export async function createPfScanJob(input: CreatePfScanInput): Promise<{ jobId: string; created: boolean }> {
  const tenantId = currentTenantId();
  const jobId = buildPfScanJobId(input, tenantId);
  const existing = await prisma.pfScanJob.findUnique({ where: { id: jobId } });
  if (existing && (existing.status === "queued" || existing.status === "active")) {
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

  await enqueuePfScanJob(jobId, {
    tenantId,
    seller: input.seller,
    scanType: input.scanType,
    daysBack: input.daysBack,
    forceRefresh: input.forceRefresh,
    fetchPrices: input.fetchPrices !== false,
    storeSettings: input.storeSettings ?? {},
  });
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
