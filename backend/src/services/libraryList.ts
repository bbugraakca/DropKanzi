import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import {
  allRemoveKeys,
  listingKey,
  mergeListing,
  slimFinderListing,
  dedupeGroupKey,
  isBetterListing,
  type FinderListing,
} from "./foundProducts";
import { archiveLibraryBeforeClear } from "./pfArchive";

export type LibraryBucket = "saved" | "reserved";

function hasListingIdentity(l: FinderListing): boolean {
  return Boolean(l.amazon_asin) || Boolean(l.listing_id) || Boolean(l.url);
}

function normalizeBucket(raw: string): LibraryBucket | null {
  const b = raw.trim().toLowerCase();
  if (b === "saved" || b === "reserved") return b;
  return null;
}

function slimListings(listings: FinderListing[]): FinderListing[] {
  return listings.filter(hasListingIdentity).map((l) => slimFinderListing(l));
}

export async function listLibrary(bucket: LibraryBucket): Promise<FinderListing[]> {
  const rows = await prisma.pfLibraryProduct.findMany({
    where: { bucket },
    orderBy: { updatedAt: "desc" },
    take: 5000,
  });
  return rows.map((r) => r.payload as FinderListing);
}

/** Replace entire bucket with the given listings (deduped by listingKey). */
export async function syncLibrary(
  bucket: LibraryBucket,
  listings: FinderListing[],
  opts?: { force?: boolean }
): Promise<{ count: number }> {
  const slim = slimListings(listings);
  const existingCount = await prisma.pfLibraryProduct.count({ where: { bucket } });

  if (slim.length === 0 && existingCount > 0 && !opts?.force) {
    throw new Error(
      `Refusing to wipe ${existingCount} ${bucket} items without force=true — use DELETE /library to clear intentionally`
    );
  }

  const map = new Map<string, FinderListing>();
  for (const l of slim) {
    const key = listingKey(l);
    map.set(key, mergeListing(map.get(key), l));
  }
  const entries = Array.from(map.entries());

  await prisma.$transaction(async (tx) => {
    await tx.pfLibraryProduct.deleteMany({ where: { bucket } });
    if (entries.length === 0) return;
    await tx.pfLibraryProduct.createMany({
      data: entries.map(([key, payload]) => ({
        listingKey: key,
        bucket,
        payload: payload as Prisma.InputJsonValue,
      })),
    });
  });

  return { count: entries.length };
}

/** Upsert listings into a bucket without clearing others. */
export async function mergeLibrary(
  bucket: LibraryBucket,
  listings: FinderListing[]
): Promise<{ merged: number }> {
  const slim = slimListings(listings);
  let merged = 0;
  for (const raw of slim) {
    const key = listingKey(raw);
    const existing = await prisma.pfLibraryProduct.findUnique({ where: { listingKey: key } });
    const payload = mergeListing(existing?.payload as FinderListing | undefined, raw);
    await prisma.pfLibraryProduct.upsert({
      where: { listingKey: key },
      create: {
        listingKey: key,
        bucket,
        payload: payload as Prisma.InputJsonValue,
      },
      update: {
        bucket,
        payload: payload as Prisma.InputJsonValue,
      },
    });
    merged += 1;
  }
  return { merged };
}

export async function removeLibraryKeys(
  bucket: LibraryBucket,
  keys: string[],
  listings: FinderListing[] = []
): Promise<{ removed: number }> {
  const keySet = new Set(keys.map((k) => k.trim()).filter(Boolean));
  for (const item of listings) {
    for (const k of allRemoveKeys(item)) keySet.add(k);
  }
  const toDelete = Array.from(keySet);
  if (toDelete.length === 0) return { removed: 0 };

  const { count } = await prisma.pfLibraryProduct.deleteMany({
    where: {
      bucket,
      listingKey: { in: toDelete },
    },
  });
  return { removed: count };
}

export async function clearLibrary(bucket: LibraryBucket): Promise<{ cleared: number; archived: number }> {
  const archived = await archiveLibraryBeforeClear(bucket);
  const { count } = await prisma.pfLibraryProduct.deleteMany({ where: { bucket } });
  return { cleared: count, archived };
}

/** Move listings from Saved/Reserved back to Found (atomic). */
export async function restoreLibraryToFound(
  bucket: LibraryBucket,
  listings: FinderListing[]
): Promise<{ restored: number }> {
  const slim = slimListings(listings);
  if (slim.length === 0) return { restored: 0 };

  // Batched (no per-row queries inside one transaction — 5s timeout risk).
  const payloads = new Map<string, FinderListing>();
  for (const raw of slim) {
    const key = listingKey(raw);
    const prev = payloads.get(key);
    payloads.set(key, prev ? (mergeListing(prev, raw) as FinderListing) : raw);
  }
  const keys = [...payloads.keys()];

  const [existingLib, existingFound] = await Promise.all([
    prisma.pfLibraryProduct.findMany({ where: { listingKey: { in: keys } } }),
    prisma.foundProduct.findMany({ where: { listingKey: { in: keys } } }),
  ]);
  for (const row of existingLib) {
    const incoming = payloads.get(row.listingKey);
    if (incoming) {
      payloads.set(
        row.listingKey,
        mergeListing(row.payload as FinderListing, incoming) as FinderListing
      );
    }
  }
  for (const row of existingFound) {
    const incoming = payloads.get(row.listingKey);
    if (incoming) {
      payloads.set(
        row.listingKey,
        mergeListing(row.payload as FinderListing, incoming) as FinderListing
      );
    }
  }

  const rows = keys.map((key) => {
    const payload = payloads.get(key) as FinderListing;
    return {
      listingKey: key,
      seller: (payload.source_seller as string | undefined) ?? null,
      daysBack: payload.source_days_back != null ? Number(payload.source_days_back) : null,
      payload: payload as unknown as Prisma.InputJsonValue,
    };
  });
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const chunkKeys = chunk.map((r) => r.listingKey);
    await prisma.$transaction([
      prisma.pfLibraryProduct.deleteMany({
        where: { bucket, listingKey: { in: chunkKeys } },
      }),
      prisma.foundProduct.deleteMany({ where: { listingKey: { in: chunkKeys } } }),
      prisma.foundProduct.createMany({ data: chunk, skipDuplicates: true }),
    ]);
  }

  return { restored: keys.length };
}

/** Move listings from one bucket to another (atomic). */
export async function moveLibrary(
  from: LibraryBucket,
  to: LibraryBucket,
  listings: FinderListing[]
): Promise<{ moved: number }> {
  const slim = slimListings(listings);
  if (slim.length === 0) return { moved: 0 };

  // Batched (no per-row queries inside one transaction — 5s timeout risk).
  const payloads = new Map<string, FinderListing>();
  for (const raw of slim) {
    const key = listingKey(raw);
    const prev = payloads.get(key);
    payloads.set(key, prev ? (mergeListing(prev, raw) as FinderListing) : raw);
  }
  const keys = [...payloads.keys()];

  const existing = await prisma.pfLibraryProduct.findMany({
    where: { listingKey: { in: keys } },
  });
  for (const row of existing) {
    const incoming = payloads.get(row.listingKey);
    if (incoming) {
      payloads.set(
        row.listingKey,
        mergeListing(row.payload as FinderListing, incoming) as FinderListing
      );
    }
  }

  const rows = keys.map((key) => ({
    listingKey: key,
    bucket: to,
    payload: payloads.get(key) as unknown as Prisma.InputJsonValue,
  }));
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const chunkKeys = chunk.map((r) => r.listingKey);
    await prisma.$transaction([
      prisma.pfLibraryProduct.deleteMany({ where: { listingKey: { in: chunkKeys } } }),
      prisma.pfLibraryProduct.createMany({ data: chunk, skipDuplicates: true }),
    ]);
  }

  return { moved: keys.length };
}

export function parseLibraryBucket(raw: unknown): LibraryBucket | null {
  if (typeof raw !== "string") return null;
  return normalizeBucket(raw);
}

/** Remove duplicate Saved/Reserved rows — same rules as Found dedupe. */
export async function dedupeLibrary(
  bucket: LibraryBucket
): Promise<{ removed: number; total: number }> {
  const rows = await prisma.pfLibraryProduct.findMany({
    where: { bucket },
    select: { listingKey: true, payload: true },
  });

  const groups = new Map<string, Array<{ listingKey: string; payload: FinderListing }>>();
  for (const row of rows) {
    const payload = row.payload as FinderListing;
    const gk = dedupeGroupKey(payload);
    if (!gk) continue;
    const list = groups.get(gk) ?? [];
    list.push({ listingKey: row.listingKey, payload });
    groups.set(gk, list);
  }

  const toDelete = new Set<string>();
  for (const members of groups.values()) {
    if (members.length <= 1) continue;
    let best = members[0];
    for (let i = 1; i < members.length; i++) {
      const cur = members[i];
      if (isBetterListing(cur.payload, best.payload)) {
        toDelete.add(best.listingKey);
        best = cur;
      } else {
        toDelete.add(cur.listingKey);
      }
    }
  }

  if (toDelete.size === 0) {
    return { removed: 0, total: rows.length };
  }

  await prisma.pfLibraryProduct.deleteMany({
    where: { listingKey: { in: Array.from(toDelete) } },
  });
  return { removed: toDelete.size, total: rows.length - toDelete.size };
}
