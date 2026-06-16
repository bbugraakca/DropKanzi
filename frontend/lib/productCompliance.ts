import type { Product } from "@/lib/types";

export type VeroBlacklistSettings = {
  enabled?: boolean;
  highlightConflicts?: boolean;
  validateDescription?: boolean;
  shop?: string;
  brandBlacklist?: string;
  keywordBlacklist?: string;
  asinBlacklist?: string;
};

export type OfferSelectionSettings = {
  allowPrimeOnly?: boolean;
  allowPrimePantry?: boolean;
};

export type ComplianceIssue = {
  kind: "vero" | "prime";
  message: string;
};

export type ProductComplianceResult = {
  issues: ComplianceIssue[];
  blocked: boolean;
  summary: string;
  veroHit: boolean;
  primeBlocked: boolean;
};

/** Amazon placeholder / junk brand values — never treat as a real brand for VeRO. */
const PLACEHOLDER_BRANDS = new Set([
  "",
  "na",
  "n/a",
  "n.a.",
  "unknown",
  "generic",
  "unbranded",
  "does not apply",
  "not applicable",
  "-",
  "—",
]);

const JUNK_BLACKLIST_TERMS = new Set([
  "na",
  "n/a",
  "n.a.",
  "-",
  "—",
  "none",
  "unknown",
]);

export function parseBlacklistLines(
  text: string | undefined,
  opts?: { minLength?: number; allowShort?: boolean }
): string[] {
  const minLength = opts?.minLength ?? 2;
  const allowShort = opts?.allowShort ?? false;
  return (text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((line) => {
      if (!line) return false;
      const low = line.toLowerCase();
      if (JUNK_BLACKLIST_TERMS.has(low)) return false;
      if (!allowShort && line.length < minLength) return false;
      return true;
    });
}

function normalizeProductBrand(brand: string | null | undefined): string | null {
  const b = brand?.trim();
  if (!b) return null;
  if (PLACEHOLDER_BRANDS.has(b.toLowerCase())) return null;
  return b;
}

/** Text scanned for keywords only (brand field excluded — avoids false hits). */
function productKeywordText(product: Product, includeDescription: boolean): string {
  const parts: (string | null | undefined)[] = [
    product.title,
    ...(product.bulletPoints || []),
    product.aboutText,
  ];
  if (includeDescription) parts.push(product.description);
  return parts.filter(Boolean).join(" ");
}

/** Whole-word match only (keywords). */
function matchesKeyword(haystack: string, term: string): boolean {
  const t = term.trim();
  if (!t || !haystack) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
}

export function resolveProductPrimeFlags(product: Product): {
  isPrime: boolean;
  isPrimePantry: boolean;
} {
  if (product.isPrime || product.isPrimePantry) {
    return {
      isPrime: !!product.isPrime,
      isPrimePantry: !!product.isPrimePantry,
    };
  }
  const blob = [
    product.title,
    product.stock,
    product.description,
    product.aboutText,
    ...(product.bulletPoints || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const isPrimePantry = blob.includes("prime pantry");
  const isPrime =
    isPrimePantry ||
    /\bprime\b/.test(blob) ||
    blob.includes("prime member") ||
    blob.includes("with prime");
  return { isPrime, isPrimePantry };
}

export function checkVeroCompliance(
  product: Product,
  vero: VeroBlacklistSettings | undefined
): ComplianceIssue[] {
  if (!vero?.enabled) return [];

  const asin = product.asin.toUpperCase();
  for (const blocked of parseBlacklistLines(vero.asinBlacklist, { minLength: 10 })) {
    if (blocked.toUpperCase() === asin) {
      return [{ kind: "vero", message: `ASIN blacklisted: ${asin}` }];
    }
  }

  const issues: ComplianceIssue[] = [];

  // Brand list: exact match on Amazon brand field only (not full title/description).
  const productBrand = normalizeProductBrand(product.brand);
  if (productBrand) {
    const brandList = parseBlacklistLines(vero.brandBlacklist, {
      minLength: 2,
      allowShort: true,
    });
    for (const blocked of brandList) {
      if (productBrand.toLowerCase() === blocked.toLowerCase()) {
        issues.push({
          kind: "vero",
          message: `Blacklisted brand: "${blocked}"`,
        });
        break;
      }
    }
  }

  // Keyword list: whole words in title / bullets / description only.
  const includeDescription = vero.validateDescription !== false;
  const keywordText = productKeywordText(product, includeDescription);
  if (keywordText.trim()) {
    const keywords = parseBlacklistLines(vero.keywordBlacklist, { minLength: 3 });
    for (const kw of keywords) {
      if (matchesKeyword(keywordText, kw)) {
        issues.push({
          kind: "vero",
          message: `Blacklisted keyword: "${kw}"`,
        });
      }
    }
  }

  const seen = new Set<string>();
  return issues.filter((i) => {
    if (seen.has(i.message)) return false;
    seen.add(i.message);
    return true;
  });
}

export function checkPrimeCompliance(
  product: Product,
  offer: OfferSelectionSettings | undefined
): ComplianceIssue[] {
  const allowPrimeOnly = offer?.allowPrimeOnly !== false;
  const allowPrimePantry = offer?.allowPrimePantry !== false;
  const { isPrime, isPrimePantry } = resolveProductPrimeFlags(product);

  const issues: ComplianceIssue[] = [];
  if (isPrimePantry && !allowPrimePantry) {
    issues.push({
      kind: "prime",
      message: "Prime Pantry offer — disabled in Offer Selection",
    });
  }
  if (isPrime && !allowPrimeOnly) {
    issues.push({
      kind: "prime",
      message: "Prime offer — 'Allow Prime Only' is off in Offer Selection",
    });
  }
  return issues;
}

export function runProductCompliance(
  product: Product,
  storeSettings: Record<string, unknown> | null | undefined
): ProductComplianceResult {
  const vero = storeSettings?.veroBlacklist as VeroBlacklistSettings | undefined;
  const offer = storeSettings?.offerSelection as OfferSelectionSettings | undefined;

  const issues = [
    ...checkVeroCompliance(product, vero),
    ...checkPrimeCompliance(product, offer),
  ];

  const veroHit = issues.some((i) => i.kind === "vero");
  const primeBlocked = issues.some((i) => i.kind === "prime");
  const blocked = issues.length > 0;

  const summary = issues.map((i) => i.message).join(" · ");

  return {
    issues,
    blocked,
    summary,
    veroHit,
    primeBlocked,
  };
}

export function formatComplianceNote(result: ProductComplianceResult): string {
  if (!result.blocked) return "";
  const parts: string[] = [];
  if (result.veroHit) parts.push("VeRO list");
  if (result.primeBlocked) parts.push("Prime blocked");
  return `${parts.join(" + ")}: ${result.summary}`;
}
