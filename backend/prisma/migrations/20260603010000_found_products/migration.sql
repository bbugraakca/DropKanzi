-- Accumulated Product Finder matches (survives refresh; merges 7d + 30d scans).
CREATE TABLE "FoundProduct" (
    "listingKey" TEXT NOT NULL,
    "seller" TEXT,
    "daysBack" INTEGER,
    "payload" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FoundProduct_pkey" PRIMARY KEY ("listingKey")
);

CREATE INDEX "FoundProduct_seller_idx" ON "FoundProduct"("seller");
CREATE INDEX "FoundProduct_updatedAt_idx" ON "FoundProduct"("updatedAt" DESC);
