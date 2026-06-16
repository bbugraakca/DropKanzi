import { prisma, currentTenantId } from "./db";
import { parseNumericFilter, parseSortColumn } from "./sqlFilter";
import { sqlTenantWhere } from "./sqlUtils";
import { mergeListing, dedupeGroupKey, isBetterListing, type FinderListing } from "./foundProducts";
import { Prisma } from "@prisma/client";
import { isPlausibleAsin } from "../utils/asin";
import {
  enrichListingProfit,
  ACCEPTED_MATCH_SQL,
  HAS_PRICE_SQL,
  minMarginWhereSql,
  minMatchConfidenceWhereSql,
  MISSING_PRICE_SQL,
  netProfitExprSql,
  profitableWhereSql,
  type ProfitQueryParams,
} from "./productFinderProfit";

export type FoundSortKey =
  | "profit"
  | "margin"
  | "sold_date"
  | "sold_price"
  | "quantity"
  | "match";

export type FoundPageQuery = {
  page?: number;
  limit?: number;
  seller?: string;
  q?: string;
  profitable?: boolean;
  missingPrice?: boolean;
  hasPrice?: boolean;
  minMatchConfidence?: number;
  minMargin?: number;
  minSoldPrice?: number;
  sort?: FoundSortKey;
  vatRate?: number;
  additionalFee?: number;
};

function profitParams(query: FoundPageQuery): ProfitQueryParams {
  return {
    vatRate: query.vatRate ?? 0,
    additionalFee: query.additionalFee ?? 0,
  };
}

const SORT_SQL: Record<FoundSortKey, string> = {
  profit: `NULLIF(payload->>'net_profit', '')::double precision DESC NULLS LAST`,
  margin: `NULLIF(payload->>'margin_percent', '')::double precision DESC NULLS LAST`,
  sold_date: `payload->>'sold_date' DESC NULLS LAST`,
  sold_price: `NULLIF(payload->>'sold_price', '')::double precision DESC NULLS LAST`,
  quantity: `NULLIF(payload->>'quantity_sold', '')::int DESC NULLS LAST`,
  match: `NULLIF(payload->>'match_confidence', '')::double precision DESC NULLS LAST`,
};

function buildWhere(query: FoundPageQuery, paramStart = 1): { sql: string; params: unknown[] } {
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
    const conf = parseNumericFilter(query.minMatchConfidence, { min: 0, exclusiveMin: true });
    if (conf !== undefined) {
      const match = minMatchConfidenceWhereSql(conf, i);
      parts.push(match.sql);
      params.push(...match.params);
      i += match.params.length;
    }
  }
  if (query.minMargin != null && query.minMargin > 0) {
    const marginVal = parseNumericFilter(query.minMargin, { min: 0, exclusiveMin: true });
    if (marginVal !== undefined) {
      const margin = minMarginWhereSql(marginVal, profitParams(query), i);
      parts.push(margin.sql);
      params.push(...margin.params);
      i += margin.params.length;
    }
  }
  const minSold = parseNumericFilter(query.minSoldPrice, { min: 0, exclusiveMin: true });
  if (minSold !== undefined) {
    parts.push(
      `(NULLIF(payload->>'sold_price', '')::double precision) >= $${i}::double precision`
    );
    params.push(minSold);
    i++;
  }

  return { sql: parts.join(" AND "), params };
}

export async function listFoundPage(query: FoundPageQuery): Promise<{
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
  const sortKey = parseSortColumn(
    query.sort,
    Object.keys(SORT_SQL) as FoundSortKey[],
    "profit"
  );
  const orderSql = SORT_SQL[sortKey];

  const countRows = await prisma.$queryRawUnsafe<{ c: bigint }[]>(
    `SELECT COUNT(*)::bigint AS c FROM "FoundProduct" WHERE ${whereWithTenant}`,
    ...params
  );
  const total = Number(countRows[0]?.c ?? 0);

  const limitIdx = params.length + 1;
  const offsetIdx = params.length + 2;
  const rows = await prisma.$queryRawUnsafe<{ payload: FinderListing; listingKey: string }[]>(
    `SELECT payload, "listingKey" FROM "FoundProduct" WHERE ${whereWithTenant} ORDER BY ${orderSql} LIMIT $${limitIdx}::int OFFSET $${offsetIdx}::int`,
    ...params,
    limit,
    offset
  );

  return {
    listings: rows.map((r) => ({
      ...r.payload,
      found_key: r.listingKey,
    })),
    total,
    page,
    limit,
  };
}

let statsCache: {
  at: number;
  key: string;
  data: {
    total: number;
    matched: number;
    with_price: number;
    missing_prices: number;
    profitable: number;
    total_profit: number;
    avg_margin: number;
    total_revenue: number;
  };
} | null = null;
const STATS_CACHE_MS = 45_000;

function statsCacheKey(params: ProfitQueryParams): string {
  return `${params.vatRate ?? 0}:${params.additionalFee ?? 0}`;
}

export function invalidateFoundStatsCache(): void {
  statsCache = null;
}

type FoundStatsRow = {
  total: number;
  matched: number;
  with_price: number;
  missing_prices: number;
  profitable: number;
  total_profit: number;
  avg_margin: number;
  total_revenue: number;
};

async function computeFoundStats(query: FoundPageQuery = {}): Promise<FoundStatsRow> {
  const tenantId = currentTenantId();
  const { sql: whereSql, params: whereParams } = buildWhere(query);
  const whereWithTenant = `(${sqlTenantWhere(tenantId)}) AND (${whereSql})`;
  const pq = profitParams(query);
  const i = whereParams.length + 1;
  const profitable = profitableWhereSql(pq, i);
  const sold = `(NULLIF(payload->>'sold_price', '')::double precision)`;
  const net = netProfitExprSql(i, i + 1);
  const marginExpr = `CASE WHEN ${sold} > 0 THEN (${net} / ${sold} * 100) ELSE NULL END`;
  const qty = `COALESCE(NULLIF(payload->>'quantity_sold', '')::int, 1)`;
  const rows = await prisma.$queryRawUnsafe<
    {
      total: bigint;
      matched: bigint;
      with_price: bigint;
      missing_prices: bigint;
      profitable: bigint;
      total_profit: number | null;
      avg_margin: number | null;
      total_revenue: number | null;
    }[]
  >(
    `SELECT
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE ${ACCEPTED_MATCH_SQL})::bigint AS matched,
      COUNT(*) FILTER (WHERE ${HAS_PRICE_SQL})::bigint AS with_price,
      COUNT(*) FILTER (
        WHERE payload->>'amazon_asin' IS NOT NULL
          AND (payload->>'amazon_price' IS NULL OR payload->>'amazon_price' = '')
      )::bigint AS missing_prices,
      COUNT(*) FILTER (WHERE ${profitable.sql})::bigint AS profitable,
      COALESCE(SUM((${net})) FILTER (WHERE ${profitable.sql}), 0)::double precision AS total_profit,
      COALESCE(AVG((${marginExpr})) FILTER (WHERE ${profitable.sql}), 0)::double precision AS avg_margin,
      COALESCE(SUM((${sold}) * ${qty}), 0)::double precision AS total_revenue
    FROM "FoundProduct"
    WHERE ${whereWithTenant}`,
    ...whereParams,
    ...profitable.params
  );
  const row = rows[0];
  return {
    total: Number(row?.total ?? 0),
    matched: Number(row?.matched ?? 0),
    with_price: Number(row?.with_price ?? 0),
    missing_prices: Number(row?.missing_prices ?? 0),
    profitable: Number(row?.profitable ?? 0),
    total_profit: Math.round(Number(row?.total_profit ?? 0) * 100) / 100,
    avg_margin: Math.round(Number(row?.avg_margin ?? 0) * 10) / 10,
    total_revenue: Math.round(Number(row?.total_revenue ?? 0) * 100) / 100,
  };
}

/** Global Found stats (tab badge, no row filters). */
export async function getFoundStats(
  force = false,
  profitQuery: ProfitQueryParams = {}
): Promise<FoundStatsRow> {
  const now = Date.now();
  const key = statsCacheKey(profitQuery);
  if (!force && statsCache && statsCache.key === key && now - statsCache.at < STATS_CACHE_MS) {
    return statsCache.data;
  }
  const data = await computeFoundStats({
    vatRate: profitQuery.vatRate,
    additionalFee: profitQuery.additionalFee,
  });
  statsCache = { at: now, key, data };
  return data;
}

/** Stats for the same filters as listFoundPage (seller, search, profitable, etc.). */
export async function getFoundStatsForQuery(query: FoundPageQuery): Promise<FoundStatsRow> {
  return computeFoundStats(query);
}

export async function listMissingPriceAsins(limit = 1000): Promise<string[]> {
  const tenantId = currentTenantId();
  const cap = Math.min(1000, Math.max(1, limit));
  const rows = await prisma.$queryRaw<{ asin: string }[]>`
    SELECT DISTINCT payload->>'amazon_asin' AS asin
    FROM "FoundProduct"
    WHERE "tenantId" = ${tenantId} AND payload->>'amazon_asin' IS NOT NULL
      AND (payload->>'amazon_price' IS NULL OR payload->>'amazon_price' = '')
      AND payload->>'amazon_asin' ~ '[0-9]'
    LIMIT ${cap * 2}
  `;
  return rows.map((r) => r.asin).filter((a) => isPlausibleAsin(a)).slice(0, cap);
}

export async function listFoundSellers(): Promise<string[]> {
  const tenantId = currentTenantId();
  const rows = await prisma.$queryRaw<{ name: string }[]>`
    SELECT DISTINCT name FROM (
      SELECT seller AS name FROM "FoundProduct"
      WHERE "tenantId" = ${tenantId} AND seller IS NOT NULL AND seller <> ''
      UNION
      SELECT payload->>'source_seller' AS name FROM "FoundProduct"
      WHERE "tenantId" = ${tenantId} AND payload->>'source_seller' IS NOT NULL AND payload->>'source_seller' <> ''
    ) s
    ORDER BY name ASC
    LIMIT 500
  `;
  return rows.map((r) => r.name).filter(Boolean);
}

/** How many Found rows exist per source seller (for watchlist UI). */
export async function countFoundBySeller(): Promise<Record<string, number>> {
  const tenantId = currentTenantId();
  const rows = await prisma.$queryRaw<{ seller: string; count: bigint }[]>`
    SELECT seller, COUNT(*)::bigint AS count
    FROM "FoundProduct"
    WHERE "tenantId" = ${tenantId} AND seller IS NOT NULL AND seller <> ''
    GROUP BY seller
  `;
  const out: Record<string, number> = {};
  for (const r of rows) {
    out[r.seller.toLowerCase()] = Number(r.count);
  }
  return out;
}

export type FoundPricePatch = {
  price: number | null;
  stock?: string | null;
};

/** Write fetched Amazon prices onto every Found row with matching ASIN. */
export async function applyFoundPricesByAsin(
  prices: Record<string, FoundPricePatch>
): Promise<number> {
  const tenantId = currentTenantId();
  const entries = Object.entries(prices).filter(
    ([, data]) => data.price != null && Number.isFinite(data.price)
  );
  if (entries.length === 0) return 0;

  const priceMap = new Map<string, FoundPricePatch>();
  for (const [rawAsin, data] of entries) {
    const asin = rawAsin.trim().toUpperCase();
    if (isPlausibleAsin(asin)) priceMap.set(asin, data);
  }
  if (priceMap.size === 0) return 0;

  const asinList = Array.from(priceMap.keys());
  const rows = await prisma.$queryRaw<{ listingKey: string; payload: FinderListing }[]>`
    SELECT "listingKey", payload FROM "FoundProduct"
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
    await prisma.foundProduct.update({
      where: { listingKey: row.listingKey },
      data: { payload: merged as Prisma.InputJsonValue },
    });
    updated += 1;
  }
  return updated;
}

/** Remove duplicate Found rows (same ASIN, eBay listing, or title). Keeps best profit row. */
export async function dedupeFoundProducts(): Promise<{ removed: number; total: number }> {
  const tenantId = currentTenantId();
  const rows = await prisma.foundProduct.findMany({
    where: { tenantId },
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

  await prisma.foundProduct.deleteMany({
    where: { tenantId, listingKey: { in: Array.from(toDelete) } },
  });
  invalidateFoundStatsCache();
  const total = await prisma.foundProduct.count({ where: { tenantId } });
  return { removed: toDelete.size, total };
}
