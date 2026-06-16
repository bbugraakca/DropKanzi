/** Parse eBay seller queue input: username, store name, or full search/store URL. */
export function parseEbaySellerInput(raw: string): {
  seller: string;
  /** Full string to send to the analyze API (preserves URL params). */
  apiInput: string;
  ebaySsnHint?: string;
  storeNameHint?: string;
  fromUrl: boolean;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { seller: "", apiInput: "", fromUrl: false };
  }

  if (!/ebay\./i.test(trimmed)) {
    const seller = trimmed.replace(/^@/, "");
    return { seller, apiInput: seller, fromUrl: false };
  }

  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    const ssn = url.searchParams.get("_ssn")?.trim();
    const storeName = url.searchParams.get("store_name")?.trim();
    const pathMatch = url.pathname.match(/\/(?:usr|str)\/([^/?#]+)/i);
    const pathName = pathMatch ? decodeURIComponent(pathMatch[1]).trim() : undefined;
    const seller = storeName || pathName || ssn || trimmed.replace(/^@/, "");
    return {
      seller,
      apiInput: trimmed,
      ebaySsnHint: ssn || undefined,
      storeNameHint: storeName || pathName || undefined,
      fromUrl: true,
    };
  } catch {
    const seller = trimmed.replace(/^@/, "");
    return { seller, apiInput: seller, fromUrl: false };
  }
}
