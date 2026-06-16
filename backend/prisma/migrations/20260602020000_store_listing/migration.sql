-- CreateTable
CREATE TABLE IF NOT EXISTS "Store" (
  "id" TEXT NOT NULL,
  "ebayUsername" TEXT NOT NULL,
  "accessToken" TEXT NOT NULL,
  "refreshToken" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "country" TEXT NOT NULL DEFAULT 'US',
  "settings" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Listing" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "asin" TEXT NOT NULL,
  "ebayListingId" TEXT,
  "title" TEXT NOT NULL,
  "price" DOUBLE PRECISION NOT NULL,
  "quantity" INTEGER NOT NULL,
  "condition" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "paymentPolicyId" TEXT,
  "returnPolicyId" TEXT,
  "fulfillmentPolicyId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Listing_storeId_idx" ON "Listing"("storeId");
CREATE INDEX IF NOT EXISTS "Listing_asin_idx" ON "Listing"("asin");

-- AddForeignKey
ALTER TABLE "Listing"
  ADD CONSTRAINT "Listing_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Listing"
  ADD CONSTRAINT "Listing_asin_fkey"
  FOREIGN KEY ("asin") REFERENCES "Product"("asin")
  ON DELETE RESTRICT ON UPDATE CASCADE;

