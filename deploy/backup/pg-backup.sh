#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required"
  exit 1
fi
if [[ -z "${S3_BACKUP_BUCKET:-}" ]]; then
  echo "S3_BACKUP_BUCKET is required"
  exit 1
fi

NOW="$(date -u +%Y%m%d-%H%M%S)"
KEY="postgres/pricehawk-${NOW}.sql.gz"

pg_dump "${DATABASE_URL}" | gzip | aws s3 cp - "s3://${S3_BACKUP_BUCKET}/${KEY}"
echo "Uploaded backup to s3://${S3_BACKUP_BUCKET}/${KEY}"
