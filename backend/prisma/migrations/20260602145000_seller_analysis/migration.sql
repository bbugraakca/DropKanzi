-- Product Finder: cache eBay seller analysis results
CREATE TABLE IF NOT EXISTS "SellerAnalysis" (
    "id" TEXT NOT NULL,
    "seller" TEXT NOT NULL,
    "daysBack" INTEGER NOT NULL,
    "listings" JSONB NOT NULL,
    "summary" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SellerAnalysis_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SellerAnalysis_seller_createdAt_idx"
    ON "SellerAnalysis" ("seller", "createdAt" DESC);
