-- Product Finder Saved / Reserved persistence
CREATE TABLE "PfLibraryProduct" (
    "listingKey" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PfLibraryProduct_pkey" PRIMARY KEY ("listingKey")
);

CREATE INDEX "PfLibraryProduct_bucket_updatedAt_idx" ON "PfLibraryProduct"("bucket", "updatedAt" DESC);
