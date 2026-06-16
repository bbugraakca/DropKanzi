import { Prisma } from "@prisma/client";
import { prisma, currentTenantId } from "./db";
import {
  listingKey,
  mergeListing,
  withSource,
  type FinderListing,
} from "./foundProducts";
import { invalidateFoundStatsCache } from "./foundList";

const FINDER_UPSERT_CHUNK = 50;

export async function mergeMatchedIntoFound(
  seller: string,
  daysBack: number,
  matched: FinderListing[],
  options?: { replaceWindow?: boolean; tenantId?: string }
): Promise<number> {
  if (matched.length === 0) return 0;
  const tenantId = options?.tenantId || currentTenantId();

  const byKey = new Map<string, FinderListing>();
  for (const raw of matched) {
    const payload = withSource(raw, seller, daysBack);
    const key = listingKey(payload);
    const prev = byKey.get(key);
    byKey.set(key, prev ? (mergeListing(prev, payload) as FinderListing) : payload);
  }
  const keys = [...byKey.keys()];

  const existing = await prisma.foundProduct.findMany({
    where: { tenantId, listingKey: { in: keys } },
  });
  for (const row of existing) {
    const incoming = byKey.get(row.listingKey);
    if (incoming) {
      byKey.set(
        row.listingKey,
        mergeListing(row.payload as FinderListing, incoming) as FinderListing
      );
    }
  }

  if (options?.replaceWindow) {
    await prisma.foundProduct.deleteMany({ where: { tenantId, seller, daysBack } });
  }

  const rows = keys.map((key) => ({
    listingKey: key,
    tenantId,
    seller,
    daysBack,
    payload: byKey.get(key) as unknown as Prisma.InputJsonValue,
  }));
  for (let i = 0; i < rows.length; i += FINDER_UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + FINDER_UPSERT_CHUNK);
    await prisma.$transaction([
      prisma.foundProduct.deleteMany({
        where: { tenantId, listingKey: { in: chunk.map((r) => r.listingKey) } },
      }),
      prisma.foundProduct.createMany({ data: chunk, skipDuplicates: true }),
    ]);
  }

  invalidateFoundStatsCache();
  return rows.length;
}
