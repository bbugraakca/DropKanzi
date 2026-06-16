$ErrorActionPreference = "Stop"
$root = (Split-Path -Parent $MyInvocation.MyCommand.Path) | Split-Path -Parent
Set-Location $root

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "UYARI: .env olusturuldu - proxy bilgilerini kontrol edin." -ForegroundColor Yellow
}

Write-Host "Servisler baslatiliyor..." -ForegroundColor Cyan
docker compose up -d --build

Write-Host "Migration..." -ForegroundColor Cyan
docker compose exec backend npx prisma migrate deploy

Write-Host "Test..." -ForegroundColor Cyan
Start-Sleep 5
& "$root\scripts\test-all.ps1"
