-- Per-ASIN scrape bandwidth (bytes + fetch_type) for bulk status UI
ALTER TABLE "ScrapeJob" ADD COLUMN IF NOT EXISTS "itemStats" JSONB;
