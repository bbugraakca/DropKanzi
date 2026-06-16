const ASIN_REGEX = /^[A-Z0-9]{10}$/;

/** Reject 10-letter English words mistaken as ASINs (eBay description noise). */
export function isPlausibleAsin(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const s = raw.trim().toUpperCase();
  if (!ASIN_REGEX.test(s)) return false;
  if (/^[A-Z]{10}$/.test(s)) return false;
  if (s === "0000000000" || s === "1111111111" || s === "9999999999") return false;
  return true;
}

/** ASIN, Amazon URL veya karisik metinden 10 haneli ASIN cikarir */
export function extractAsin(raw: string): string | null {
  const input = raw.trim();
  if (!input) return null;

  const patterns = [
    /\/dp\/([A-Z0-9]{10})/i,
    /\/gp\/product\/([A-Z0-9]{10})/i,
    /\/gp\/aw\/d\/([A-Z0-9]{10})/i,
    /[?&]asin=([A-Z0-9]{10})/i,
    /\b([A-Z0-9]{10})\b/i,
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match?.[1]) {
      const candidate = match[1].toUpperCase();
      if (isPlausibleAsin(candidate)) return candidate;
    }
  }

  const upper = input.toUpperCase();
  return isPlausibleAsin(upper) ? upper : null;
}

export function validateAsin(asin: string): string | null {
  return extractAsin(asin);
}
