-- Safety: create Order if an older DB volume missed 20260602072119_orders
CREATE TABLE IF NOT EXISTS "Order" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "ebayOrderId" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "asin" TEXT,
    "title" TEXT NOT NULL,
    "image" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received_not_ordered',
    "notes" TEXT,
    "targetUrl" TEXT,
    "buyer" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "paidAmount" DOUBLE PRECISION,
    "sourceUrl" TEXT,
    "amazonPrice" DOUBLE PRECISION,
    "price" DOUBLE PRECISION,
    "profit" DOUBLE PRECISION,
    "sourceOrderUrl" TEXT,
    "carrier" TEXT,
    "tracking" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Order_storeId_updatedAt_idx" ON "Order"("storeId", "updatedAt" DESC);
CREATE INDEX IF NOT EXISTS "Order_ebayOrderId_idx" ON "Order"("ebayOrderId");
CREATE UNIQUE INDEX IF NOT EXISTS "Order_storeId_ebayOrderId_lineItemId_key" ON "Order"("storeId", "ebayOrderId", "lineItemId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Order_storeId_fkey'
  ) THEN
    ALTER TABLE "Order" ADD CONSTRAINT "Order_storeId_fkey"
      FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
