-- Tenant + PF scan foundational schema
ALTER TABLE "SellerAnalysis" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "FoundProduct" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "PfLibraryProduct" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "PfDataArchive" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "ActiveListingProduct" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';

CREATE TABLE IF NOT EXISTS "Tenant" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "settings" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PfScanJob" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'default',
  "seller" TEXT NOT NULL,
  "scanType" TEXT NOT NULL,
  "daysBack" INTEGER NOT NULL,
  "forceRefresh" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "stage" TEXT,
  "progress" JSONB,
  "error" TEXT,
  "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PfScanJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MatchFeedback" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'default',
  "titleHash" TEXT NOT NULL,
  "suggestedAsin" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "correctedAsin" TEXT,
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MatchFeedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SellerAnalysis_tenantId_createdAt_idx" ON "SellerAnalysis"("tenantId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "FoundProduct_tenantId_updatedAt_idx" ON "FoundProduct"("tenantId", "updatedAt" DESC);
CREATE INDEX IF NOT EXISTS "PfLibraryProduct_tenantId_bucket_updatedAt_idx" ON "PfLibraryProduct"("tenantId", "bucket", "updatedAt" DESC);
CREATE INDEX IF NOT EXISTS "PfDataArchive_tenantId_source_createdAt_idx" ON "PfDataArchive"("tenantId", "source", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "ActiveListingProduct_tenantId_updatedAt_idx" ON "ActiveListingProduct"("tenantId", "updatedAt" DESC);
CREATE INDEX IF NOT EXISTS "Tenant_createdAt_idx" ON "Tenant"("createdAt" DESC);
CREATE INDEX IF NOT EXISTS "PfScanJob_tenantId_status_createdAt_idx" ON "PfScanJob"("tenantId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "MatchFeedback_tenantId_createdAt_idx" ON "MatchFeedback"("tenantId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "MatchFeedback_titleHash_suggestedAsin_idx" ON "MatchFeedback"("titleHash", "suggestedAsin");

INSERT INTO "Tenant" ("id", "name")
VALUES ('default', 'Default')
ON CONFLICT ("id") DO NOTHING;
