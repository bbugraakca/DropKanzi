import { prisma, currentTenantId } from "./db";
import { sqlTenantWhere } from "./sqlUtils";
import { mergeListing, activeListingKey, type FinderListing } from "./foundProducts";
import { Prisma } from "@prisma/client";
import {
  enrichListingProfit,
  HAS_PRICE_SQL,
  minMarginWhereSql,
  minMatchConfidenceWhereSql,
  MISSING_PRICE_SQL,
  netProfitExprSql,
  profitableWhereSql,
  type ProfitQueryParams,
} from "./productFinderProfit";

export type ActiveSortKey =
  | "profit"
  | "margin"
  | "sold_price"
  | "match";

export type ActivePageQuery = {
  page?: number;
  limit?: number;
  seller?: string;
  q?: string;
  profitable?: boolean;
  missingPrice?: boolean;
  hasPrice?: boolean;
  minMatchConfidence?: number;
  minMargin?: number;
  minListPrice?: number;
  sort?: ActiveSortKey;
  vatRate?: number;
  additionalFee?: number;
};

function profitParams(query: ActivePageQuery): ProfitQueryParams {
  return {
    vatRate: query.vatRate ?? 0,
    additionalFee: query.additionalFee ?? 0,
  };
}

const SORT_SQL: Record<ActiveSortKey, string> = {
  profit: `(payload->>'net_profit')::double precision DESC NULLS LAST`,
  margin: `(payload->>'margin_percent')::double precision DESC NULLS LAST`,
  sold_price: `(payload->>'sold_price')::double precision DESC NULLS LAST`,
  match: `(payload->>'match_confidence')::double precision DESC NULLS LAST`,
};

function buildWhere(query: ActivePageQuery, paramStart = 1): { sql: string; params: unknown[] } {
  const parts: string[] = ["1=1"];
  const params: unknown[] = [];
  let i = paramStart;

  if (query.seller?.trim()) {
    const seller = query.seller.trim();
    parts.push(
      `(LOWER(seller) = LOWER($${i}) OR LOWER(COALESCE(payload->>'source_seller', '')) = LOWER($${i}))`
    );
    params.push(seller);
    i++;
  }
  if (query.q?.trim()) {
    const like = `%${query.q.trim().replace(/%/g, "\\%")}%`;
    parts.push(
      `(payload->>'title' ILIKE $${i} OR payload->>'amazon_asin' ILIKE $${i})`
    );
    params.push(like);
    i++;
  }
  if (query.profitable) {
    const profitable = profitableWhereSql(profitParams(query), i);
    parts.push(profitable.sql);
    params.push(...profitable.params);
    i += profitable.params.length;
  }
  if (query.hasPrice) {
    parts.push(HAS_PRICE_SQL);
  }
  if (query.missingPrice) {
    parts.push(MISSING_PRICE_SQL);
  }
  if (query.minMatchConfidence != null && query.minMatchConfidence > 0) {
    const match = minMatchConfidenceWhereSql(query.minMatchConfidence, i);
    parts.push(match.sql);
    params.push(...match.params);
    i += match.params.length;
  }
  if (query.minMargin != null && query.minMargin > 0) {
    const margin = minMarginWhereSql(query.minMargin, profitParams(query), i);
    parts.push(margin.sql);
    params.push(...margin.params);
    i += margin.params.length;
  }
  if (query.minListPrice != null && query.minListPrice > 0) {
    parts.push(
      `(NULLIF(payload->>'sold_price', '')::double precision) >= $${i}::double precision`
    );
    params.push(Number(query.minListPrice));
    i++;
  }

  return { sql: parts.join(" AND "), params };
}

export async function listActivePage(query: ActivePageQuery): Promise<{
  listings: FinderListing[];
  total: number;
  page: number;
  limit: number;
}> {
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(1000, Math.max(1, query.limit ?? 50));
  const offset = (page - 1) * limit;
  const tenantId = currentTenantId();
  const { sql: whereSql, params } = buildWhere(query);
  const whereWithTenant = `(${sqlTenantWhere(tenantId)}) AND (${whereSql})`;
  const sortKey = query.sort && SORT_SQL[query.sort] ? query.sort : "profit";
  const orderSql = SORT_SQL[sortKey];

  const countRows = await prisma.$queryRawUnsafe<{ c: bigint }[]>(
    `SELECT COUNT(*)::bigint AS c FROM "ActiveListingProduct" WHERE ${whereWithTenant}`,
    ...params
  );
  const total = Number(countRows[0]?.c ?? 0);

  const limitIdx = params.length + 1;
  const offsetIdx = params.length + 2;
  const rows = await prisma.$queryRawUnsafe<{ payload: FinderListing; listingKey: string }[]>(
    `SELECT payload, "listingKey" FROM "ActiveListingProduct" WHERE ${whereWithTenant} ORDER BY ${orderSql} LIMIT $${limitIdx}::int OFFSET $${offsetIdx}::int`,
    ...params,
    limit,
    offset
  );

  return {
    listings: rows.map((r) => ({
      ...r.payload,
      found_key: r.listingKey,
      listing_type: "active",
    })),
    total,
    page,
    limit,
  };
}

export async function getActiveStats(query: ActivePageQuery = {}): Promise<{
  total: number;
  missing_prices: number;
  profitable: number;
  total_profit: number;
  avg_margin: number;
  total_revenue: number;
}> {
  const tenantId = currentTenantId();
  const { sql: whereSql, params: whereParams } = buildWhere(query);
  const whereWithTenant = `(${sqlTenantWhere(tenantId)}) AND (${whereSql})`;
  const pq = profitParams(query);
  const i = whereParams.length + 1;
  const profitable = profitableWhereSql(pq, i);
  const listPrice = `(NULLIF(payload->>'sold_price', '')::double precision)`;
  const net = netProfitExprSql(i, i + 1);
  const marginExpr = `CASE WHEN ${listPrice} > 0 THEN (${net} / ${listPrice} * 100) ELSE NULL END`;

  const rows = await prisma.$queryRawUnsafe<
    {
      total: bigint;
      missing_prices: bigint;
      profitable: bigint;
      total_profit: number | null;
      avg_margin: number | null;
      total_revenue: number | null;
    }[]
  >(
    `SELECT
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (
        WHERE payload->>'amazon_asin' IS NOT NULL
          AND (payload->>'amazon_price' IS NULL OR payload->>'amazon_price' = '')
      )::bigint AS missing_prices,
      COUNT(*) FILTER (WHERE ${profitable.sql})::bigint AS profitable,
      COALESCE(SUM((${net})) FILTER (WHERE ${profitable.sql}), 0)::double precision AS total_profit,
      COALESCE(AVG((${marginExpr})) FILTER (WHERE ${profitable.sql}), 0)::double precision AS avg_margin,
      COALESCE(SUM((${listPrice})), 0)::double precision AS total_revenue
    FROM "ActiveListingProduct"
    WHERE ${whereWithTenant}`,
    ...whereParams,
    ...profitable.params
  );
  const row = rows[0];
  return {
    total: Number(row?.total ?? 0),
    missing_prices: Number(row?.missing_prices ?? 0),
    profitable: Number(row?.profitable ?? 0),
    total_profit: Math.round(Number(row?.total_profit ?? 0) * 100) / 100,
    avg_margin: Math.round(Number(row?.avg_margin ?? 0) * 10) / 10,
    total_revenue: Math.round(Number(row?.total_revenue ?? 0) * 100) / 100,
  };
}

export async function listActiveSellers(): Promise<string[]> {
  const tenantId = currentTenantId();
  const rows = await prisma.$queryRaw<{ seller: string }[]>`
    SELECT DISTINCT seller FROM "ActiveListingProduct"
    WHERE "tenantId" = ${tenantId} AND seller IS NOT NULL AND seller <> ''
    ORDER BY seller ASC
  `;
  return rows.map((r) => r.seller);
}

export async function countActiveBySeller(): Promise<Record<string, number>> {
  const tenantId = currentTenantId();
  const rows = await prisma.$queryRaw<{ seller: string; count: bigint }[]>`
    SELECT seller, COUNT(*)::bigint AS count
    FROM "ActiveListingProduct"
    WHERE "tenantId" = ${tenantId} AND seller IS NOT NULL AND seller <> ''
    GROUP BY seller
  `;
  const out: Record<string, number> = {};
  for (const r of rows) {
    out[r.seller.toLowerCase()] = Number(r.count);
  }
  return out;
}

export async function mergeActiveListings(
  seller: string,
  matched: FinderListing[],
  options?: { replaceSeller?: boolean; tenantId?: string }
): Promise<number> {
  if (matched.length === 0 && !options?.replaceSeller) return 0;
  const tenantId = options?.tenantId || currentTenantId();

  // Batched merge — thousands of per-row upserts inside one interactive
  // transaction blow Prisma's 5s transaction timeout and abort everything.
  const byKey = new Map<string, FinderListing>();
  for (const raw of matched) {
    const payload = enrichListingProfit({
      ...raw,
      listing_type: "active",
      source_seller: seller,
    });
    const key = activeListingKey(payload);
    const prev = byKey.get(key);
    byKey.set(key, prev ? (mergeListing(prev, payload) as FinderListing) : payload);
  }
  const keys = [...byKey.keys()];

  // Pull existing payloads in one query and merge in memory (keeps previously
  // fetched Amazon prices etc.).
  if (keys.length > 0) {
    const existing = await prisma.activeListingProduct.findMany({
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
  }

  if (options?.replaceSeller) {
    await prisma.activeListingProduct.deleteMany({ where: { tenantId, seller } });
  }

  const rows = keys.map((key) => ({
    listingKey: key,
    tenantId,
    seller,
    payload: byKey.get(key) as unknown as Prisma.InputJsonValue,
  }));
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await prisma.$transaction([
      prisma.activeListingProduct.deleteMany({
        where: { tenantId, listingKey: { in: chunk.map((r) => r.listingKey) } },
      }),
      prisma.activeListingProduct.createMany({ data: chunk, skipDuplicates: true }),
    ]);
  }

  return rows.length;
}

export async function clearActiveForSeller(seller: string): Promise<number> {
  const tenantId = currentTenantId();
  const { count } = await prisma.activeListingProduct.deleteMany({ where: { tenantId, seller } });
  return count;
}

export async function removeActiveListings(keys: string[]): Promise<{ removed: number; total: number }> {
  const tenantId = currentTenantId();
  const unique = Array.from(new Set(keys.map((k) => k.trim()).filter(Boolean)));
  if (unique.length === 0) {
    return { removed: 0, total: await prisma.activeListingProduct.count({ where: { tenantId } }) };
  }
  const CHUNK = 500;
  let removed = 0;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const { count } = await prisma.activeListingProduct.deleteMany({
      where: { tenantId, listingKey: { in: chunk } },
    });
    removed += count;
  }
  return { removed, total: await prisma.activeListingProduct.count({ where: { tenantId } }) };
}

export async function clearAllActiveListings(): Promise<number> {
  const tenantId = currentTenantId();
  const { count } = await prisma.activeListingProduct.deleteMany({ where: { tenantId } });
  return count;
}

export async function getActiveGlobalCount(): Promise<number> {
  const tenantId = currentTenantId();
  return prisma.activeListingProduct.count({ where: { tenantId } });
}

export type ActivePricePatch = {
  price: number | null;
  stock?: string | null;
};

export async function applyActivePricesByAsin(
  prices: Record<string, ActivePricePatch>
): Promise<number> {
  const tenantId = currentTenantId();
  const entries = Object.entries(prices).filter(
    ([, data]) => data.price != null && Number.isFinite(data.price)
  );
  if (entries.length === 0) return 0;

  const priceMap = new Map<string, ActivePricePatch>();
  for (const [rawAsin, data] of entries) {
    const asin = rawAsin.trim().toUpperCase();
    if (asin.length === 10) priceMap.set(asin, data);
  }
  if (priceMap.size === 0) return 0;

  const asinList = Array.from(priceMap.keys());
  const rows = await prisma.$queryRaw<{ listingKey: string; payload: FinderListing }[]>`
    SELECT "listingKey", payload FROM "ActiveListingProduct"
    WHERE "tenantId" = ${tenantId} AND upper(payload->>'amazon_asin') = ANY(${asinList}::text[])
  `;

  let updated = 0;
  for (const row of rows) {
    const asin = String(row.payload?.amazon_asin ?? "")
      .trim()
      .toUpperCase();
    const data = priceMap.get(asin);
    if (!data?.price) continue;
    const merged = enrichListingProfit(
      mergeListing(row.payload, {
        ...row.payload,
        amazon_price: data.price,
        price_source: "aod",
        ...(data.stock ? { amazon_stock: data.stock } : {}),
      })
    );
    await prisma.activeListingProduct.update({
      where: { listingKey: row.listingKey },
      data: { payload: merged as Prisma.InputJsonValue },
    });
    updated += 1;
  }
  return updated;
}
