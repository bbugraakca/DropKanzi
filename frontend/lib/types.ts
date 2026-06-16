export interface PriceHistoryEntry {
  price: number | null;
  scrapedAt: string;
  stock?: string | null;
  isInStock?: boolean;
  buyBoxSeller?: string | null;
}

export interface Product {
  id: string;
  asin: string;
  title: string | null;
  description: string | null;
  aboutText?: string | null;
  bulletPoints?: string[];
  attributes?: Record<string, string> | null;
  dimensions?: string | null;
  brand?: string | null;
  images: string[];
  rating: number | null;
  reviewsCount: number | null;
  price: number | null;
  stock: string | null;
  isInStock: boolean;
  buyBoxSeller: string | null;
  isAmazonFulfilled: boolean;
  isPrime?: boolean;
  isPrimePantry?: boolean;
  updatedAt: string;
  priceHistory?: PriceHistoryEntry[];
}

export interface ItemScrapeStat {
  bytesDownloaded: number;
  fetchType?: string;
}

export interface ScrapeJob {
  id: string;
  status: string;
  total: number;
  done: number;
  failed: number;
  percent?: number;
  asins?: string[];
  itemNotes?: Record<string, string>;
  itemStats?: Record<string, ItemScrapeStat>;
  totalBytesDownloaded?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProductsResponse {
  products: Product[];
  total: number;
  page: number;
  pages: number;
}

export interface Store {
  id: string;
  ebayUsername: string;
  country: string;
  createdAt: string;
  expiresAt: string;
  settings?: Record<string, any> | null;
}

export interface PriceBreakdown {
  sourcePrice: number;
  marginPercent: number;
  marginFixed: number;
  addonsMargin: number;
  minProfit: number;
  profit: number;
  easyncAoFee: number;
  ebayFeePercent: number;
  paypalFeePercent: number;
  fixedPaypalFee: number;
  fixedFee: number;
  priceBeforeVat: number;
  vatPercent: number;
  vatAmount: number;
  priceBeforeRounding: number;
  priceAfterRounding: number;
}

export interface ListingCalculateResult {
  asin: string;
  title: string;
  description: string;
  price: number;
  quantity: number;
  condition: string;
  categoryId?: string;
  amazonPrice: number | null;
  breakdown: PriceBreakdown;
  settingsApplied: string[];
}

export interface ListingCreateResult {
  listing: Listing;
  publishError?: string;
  settingsApplied?: string[];
  priceBreakdown?: PriceBreakdown;
  applied?: {
    title: string;
    price: number;
    quantity: number;
    condition: string;
  };
}

export interface Listing {
  id: string;
  storeId: string;
  asin: string;
  ebayListingId?: string | null;
  title: string;
  price: number;
  quantity: number;
  condition: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  product?: Product;
}

export interface OrderRow {
  id: string;
  storeId: string;
  ebayOrderId: string;
  lineItemId?: string | null;
  asin?: string | null;
  title: string;
  image?: string | null;
  status: string;
  notes?: string | null;
  targetUrl?: string | null;
  buyer?: string | null;
  qty: number;
  paidAmount?: number | null;
  sourceUrl?: string | null;
  amazonPrice?: number | null;
  price?: number | null;
  profit?: number | null;
  sourceOrderUrl?: string | null;
  carrier?: string | null;
  tracking?: string | null;
  createdAt: string;
  updatedAt: string;
}
