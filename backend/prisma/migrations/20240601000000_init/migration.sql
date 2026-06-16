-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "images" TEXT[],
    "rating" DOUBLE PRECISION,
    "reviewsCount" INTEGER,
    "price" DOUBLE PRECISION,
    "stock" TEXT,
    "isInStock" BOOLEAN NOT NULL DEFAULT false,
    "buyBoxSeller" TEXT,
    "isAmazonFulfilled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "fullFetchAt" TIMESTAMP(3),

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceHistory" (
    "id" SERIAL NOT NULL,
    "asin" TEXT NOT NULL,
    "price" DOUBLE PRECISION,
    "stock" TEXT,
    "isInStock" BOOLEAN NOT NULL,
    "buyBoxSeller" TEXT,
    "scrapedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScrapeJob" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "total" INTEGER NOT NULL,
    "done" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "asins" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScrapeJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_asin_key" ON "Product"("asin");

-- CreateIndex
CREATE INDEX "PriceHistory_asin_scrapedAt_idx" ON "PriceHistory"("asin", "scrapedAt" DESC);

-- AddForeignKey
ALTER TABLE "PriceHistory" ADD CONSTRAINT "PriceHistory_asin_fkey" FOREIGN KEY ("asin") REFERENCES "Product"("asin") ON DELETE RESTRICT ON UPDATE CASCADE;
