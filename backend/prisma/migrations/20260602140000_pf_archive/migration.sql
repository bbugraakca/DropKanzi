-- CreateTable
CREATE TABLE "PfDataArchive" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "listingKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PfDataArchive_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PfDataArchive_source_createdAt_idx" ON "PfDataArchive"("source", "createdAt" DESC);
