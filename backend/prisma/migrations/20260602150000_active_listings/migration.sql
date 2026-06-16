-- AlterTable
ALTER TABLE "SellerAnalysis" ADD COLUMN IF NOT EXISTS "scanType" TEXT NOT NULL DEFAULT 'sold';

-- DropIndex (old index if exists)
DROP INDEX IF EXISTS "SellerAnalysis_seller_createdAt_idx";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SellerAnalysis_seller_scanType_createdAt_idx" ON "SellerAnalysis"("seller", "scanType", "createdAt" DESC);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ActiveListingProduct" (
    "listingKey" TEXT NOT NULL,
    "seller" TEXT,
    "payload" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActiveListingProduct_pkey" PRIMARY KEY ("listingKey")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ActiveListingProduct_seller_idx" ON "ActiveListingProduct"("seller");
CREATE INDEX IF NOT EXISTS "ActiveListingProduct_updatedAt_idx" ON "ActiveListingProduct"("updatedAt" DESC);
