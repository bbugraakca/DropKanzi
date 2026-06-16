const ASIN_REGEX = /^[A-Z0-9]{10}$/;

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
      if (ASIN_REGEX.test(candidate)) return candidate;
    }
  }

  const upper = input.toUpperCase();
  return ASIN_REGEX.test(upper) ? upper : null;
}

export function parseAsinsFromText(text: string): string[] {
  const parts = text.split(/[\s,\n]+/).map((s) => s.trim()).filter(Boolean);
  const asins: string[] = [];
  for (const part of parts) {
    const asin = extractAsin(part);
    if (asin) asins.push(asin);
  }
  return Array.from(new Set(asins));
}
