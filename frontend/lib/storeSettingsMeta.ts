export type SettingGroup = "repricing" | "listing" | "compliance";

export type StoreSettingMeta = {
  href: string;
  label: string;
  group: SettingGroup;
  settingsKey: string;
  summary: string;
  fields: string[];
};

/** Full Store Settings catalog (sidebar + hub). */
export const STORE_SETTINGS_CATALOG: StoreSettingMeta[] = [
  {
    href: "repricing-settings",
    label: "Repricing Settings",
    group: "repricing",
    settingsKey: "repricingSettings",
    summary:
      "Master switch and global rules for automatic price updates from Amazon (or other sources) to your eBay listings.",
    fields: [
      "Enable / disable repricing for this store",
      "Default quantity in stock shown on listings",
      "Handling / shipping time (days)",
      "Check duplicates across all connected stores",
      "Walmart: add $5.99 shipping on orders under $35",
      "Allow out-of-stock (OOS) listings",
      "Apply seller discounts from source price",
      "Auto-delist cold (slow-selling) products",
      "Auto-delist failed listings",
      "Min profit ($) — floor for profit calculation",
      "Addons margin ($) — added to profit",
    ],
  },
  {
    href: "offer-selection",
    label: "Offer Selection",
    group: "repricing",
    settingsKey: "offerSelection",
    summary:
      "Which Amazon offer to use as the source price when repricing (shipping, FBA, Prime, condition).",
    fields: [
      "Source tabs: Amazon (active), Walmart & AliExpress (coming soon)",
      "Shipping method: Free, Standard, Expedited, Overnight",
      "Maximum handling days",
      "Allow third-party FBA offers + FBA margin ($)",
      "Allow Prime-only offers",
      "Allow Prime Pantry",
      "Allow merchant-fulfilled third-party offers",
      "Condition: New, Used, Refurbished, Any",
    ],
  },
  {
    href: "range-repricing",
    label: "Range Repricing",
    group: "repricing",
    settingsKey: "rangeRepricing",
    summary:
      "Profit rules by source price range — percent margin plus fixed dollar profit per band.",
    fields: [
      "Table: From ($), To ($), Margin %, Margin fixed ($)",
      "Add / remove rows",
      "Ranges must chain (each From = previous To)",
      "Used by price calculator and listing publish",
    ],
  },
  {
    href: "additional-fee",
    label: "Additional Fee",
    group: "repricing",
    settingsKey: "additionalFee",
    summary: "Extra cost added on top of the calculated eBay price for every product.",
    fields: [
      "Fixed Fee ($) — added at end of price formula",
      "eBay fee % + PayPal fee % — denominator (1 − fees × 0.01)",
      "Fixed PayPal fee ($), Easync AO fee ($)",
      "Apply to: all products or specific categories",
    ],
  },
  {
    href: "round-prices",
    label: "Round Prices",
    group: "repricing",
    settingsKey: "roundPrices",
    summary: "Psychological pricing — round final eBay price to .99, .95, .49, or whole dollars.",
    fields: [
      "Enable round prices",
      "Round to: $0.99, $0.95, $0.49, or whole number",
      "Live preview (sample price → rounded)",
    ],
  },
  {
    href: "sales-count",
    label: "Sales Count",
    group: "repricing",
    settingsKey: "salesCount",
    summary:
      "Only reprice / list products whose Amazon sales velocity is within your min–max window (last 30 days).",
    fields: [
      "Enable sales count filter",
      "Minimum sales (last 30 days)",
      "Maximum sales (last 30 days)",
    ],
  },
  {
    href: "location-settings",
    label: "Location Settings",
    group: "listing",
    settingsKey: "locationSettings",
    summary: "Item location on eBay listings (country, city, postal code) for shipping and compliance.",
    fields: ["Country", "City / location", "Postal / ZIP code"],
  },
  {
    href: "vat-details",
    label: "VAT Details",
    group: "listing",
    settingsKey: "vatDetails",
    summary: "Value-added tax added to calculated sell price (EU / UK sellers).",
    fields: ["Enable VAT", "VAT rate (%)"],
  },
  {
    href: "tracking-settings",
    label: "Tracking Settings",
    group: "listing",
    settingsKey: "trackingSettings",
    summary:
      "When fulfilling eBay orders, replace or normalize tracking numbers from source marketplaces.",
    fields: [
      "Enable tracking automation",
      "Replace tracking carrier",
      "Carrier mode: Amazon only vs all trackers",
      "Instant replace on upload",
      "Supported source markets (comma-separated codes)",
    ],
  },
  {
    href: "vero-blacklist",
    label: "VeRO Blacklist",
    group: "compliance",
    settingsKey: "veroBlacklist",
    summary:
      "Brand, keyword, and ASIN blocklists. Add Product and bulk jobs flag matches automatically.",
    fields: [
      "Enable VeRO checks",
      "Highlight conflicts in tables",
      "Validate full description text",
      "Brand / keyword / ASIN lists (one entry per line)",
    ],
  },
  {
    href: "listing-template",
    label: "eBay Listing Template",
    group: "listing",
    settingsKey: "listingTemplate",
    summary:
      "Default title prefix/suffix, HTML description, category, and condition note when publishing to eBay.",
    fields: [
      "eBay category ID",
      "Title prefix & suffix",
      "Description HTML with placeholders: {{title}}, {{description}}, {{bullet_points}}, {{asin}}",
      "Condition note",
    ],
  },
];

export function getStoreSettingMeta(href: string): StoreSettingMeta | undefined {
  return STORE_SETTINGS_CATALOG.find((s) => s.href === href);
}

export const STORE_SETTINGS_GROUPS: { id: SettingGroup; title: string }[] = [
  { id: "repricing", title: "Repricing" },
  { id: "listing", title: "Listing & fulfillment" },
  { id: "compliance", title: "Compliance" },
];
