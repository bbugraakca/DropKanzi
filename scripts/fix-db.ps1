# Repairs missing tables (e.g. Order) when migrations were marked applied but DDL did not run.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$migration = Join-Path $root "backend\prisma\migrations\20260602140000_ensure_order_table\migration.sql"

if (-not (Test-Path $migration)) {
  Write-Error "Migration file not found: $migration"
}

Write-Host "Applying ensure_order_table migration..."
Get-Content $migration | docker compose -f (Join-Path $root "docker-compose.yml") exec -T postgres psql -U admin -d pricehawk

Write-Host "Running prisma migrate deploy in backend..."
docker compose -f (Join-Path $root "docker-compose.yml") exec backend npx prisma migrate deploy

Write-Host "Done."
