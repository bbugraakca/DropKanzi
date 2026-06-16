-- Persistent total download bytes per bulk job (accounting / bulk status UI)
ALTER TABLE "ScrapeJob" ADD COLUMN IF NOT EXISTS "totalBytesDownloaded" INTEGER NOT NULL DEFAULT 0;

-- Backfill from per-ASIN itemStats when already recorded
UPDATE "ScrapeJob" j
SET "totalBytesDownloaded" = sub.total
FROM (
  SELECT
    sj.id,
    COALESCE(
      SUM(
        GREATEST(
          COALESCE((e.value->>'bytesDownloaded')::int, 0),
          COALESCE((e.value->>'bytes_downloaded')::int, 0)
        )
      ),
      0
    )::int AS total
  FROM "ScrapeJob" sj
  LEFT JOIN LATERAL jsonb_each(sj."itemStats") AS e(key, value) ON sj."itemStats" IS NOT NULL
  GROUP BY sj.id
) sub
WHERE j.id = sub.id
  AND sub.total > 0
  AND j."totalBytesDownloaded" = 0;
