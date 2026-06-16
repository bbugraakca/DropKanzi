import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { mergeListing, type FinderListing } from "./foundProducts";
import { invalidateFoundStatsCache } from "./foundList";
import type { LibraryBucket } from "./libraryList";

export type PfArchiveSource = "found" | "saved" | "reserved";

function isLibrarySource(source: PfArchiveSource): source is LibraryBucket {
  return source === "saved" || source === "reserved";
}

export async function archiveRows(
  source: PfArchiveSource,
  rows: Array<{ listingKey: string; payload: FinderListing }>,
  reason: string
): Promise<number> {
  if (rows.length === 0) return 0;
  const CHUNK = 500;
  let archived = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await prisma.pfDataArchive.createMany({
      data: slice.map((r) => ({
        source,
        listingKey: r.listingKey,
        payload: r.payload as Prisma.InputJsonValue,
        reason,
      })),
    });
    archived += slice.length;
  }
  return archived;
}

export async function archiveFoundBeforeClear(): Promise<number> {
  const rows = await prisma.foundProduct.findMany({
    select: { listingKey: true, payload: true },
  });
  return archiveRows(
    "found",
    rows.map((r) => ({
      listingKey: r.listingKey,
      payload: r.payload as FinderListing,
    })),
    "clear"
  );
}

export async function archiveLibraryBeforeClear(bucket: LibraryBucket): Promise<number> {
  const rows = await prisma.pfLibraryProduct.findMany({
    where: { bucket },
    select: { listingKey: true, payload: true },
  });
  return archiveRows(
    bucket,
    rows.map((r) => ({
      listingKey: r.listingKey,
      payload: r.payload as FinderListing,
    })),
    "clear"
  );
}

export async function getArchiveStatus(source: PfArchiveSource): Promise<{
  count: number;
  archivedAt: string | null;
}> {
  const latest = await prisma.pfDataArchive.findFirst({
    where: { source },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!latest) return { count: 0, archivedAt: null };

  const count = await prisma.pfDataArchive.count({
    where: { source, createdAt: latest.createdAt },
  });
  return { count, archivedAt: latest.createdAt.toISOString() };
}

export async function restoreLatestArchive(
  source: PfArchiveSource
): Promise<{ restored: number }> {
  const latest = await prisma.pfDataArchive.findFirst({
    where: { source },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!latest) return { restored: 0 };

  const rows = await prisma.pfDataArchive.findMany({
    where: { source, createdAt: latest.createdAt },
    select: { listingKey: true, payload: true },
  });
  if (rows.length === 0) return { restored: 0 };

  if (source === "found") {
    for (const row of rows) {
      const payload = row.payload as FinderListing;
      const existing = await prisma.foundProduct.findUnique({
        where: { listingKey: row.listingKey },
      });
      const merged = mergeListing(existing?.payload as FinderListing | undefined, payload);
      await prisma.foundProduct.upsert({
        where: { listingKey: row.listingKey },
        create: {
          listingKey: row.listingKey,
          seller: (payload.source_seller as string | undefined) ?? null,
          daysBack:
            payload.source_days_back != null ? Number(payload.source_days_back) : null,
          payload: merged as Prisma.InputJsonValue,
        },
        update: { payload: merged as Prisma.InputJsonValue },
      });
    }
    invalidateFoundStatsCache();
    return { restored: rows.length };
  }

  if (!isLibrarySource(source)) return { restored: 0 };

  for (const row of rows) {
    const payload = row.payload as FinderListing;
    const existing = await prisma.pfLibraryProduct.findUnique({
      where: { listingKey: row.listingKey },
    });
    const merged = mergeListing(existing?.payload as FinderListing | undefined, payload);
    await prisma.pfLibraryProduct.upsert({
      where: { listingKey: row.listingKey },
      create: {
        listingKey: row.listingKey,
        bucket: source,
        payload: merged as Prisma.InputJsonValue,
      },
      update: {
        bucket: source,
        payload: merged as Prisma.InputJsonValue,
      },
    });
  }
  return { restored: rows.length };
}
