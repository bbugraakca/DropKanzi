# PriceHawk - tum servisleri test eder
$ErrorActionPreference = "Continue"
$allOk = $true

function Test-Endpoint($name, [scriptblock]$Action) {
    try {
        & $Action
        Write-Host "[OK] $name" -ForegroundColor Green
    } catch {
        Write-Host "[FAIL] $name - $($_.Exception.Message)" -ForegroundColor Red
        $script:allOk = $false
    }
}

Test-Endpoint "Scraper health" { Invoke-RestMethod http://localhost:8001/health | Out-Null }
Test-Endpoint "Backend health" { Invoke-RestMethod http://localhost:3001/api/health | Out-Null }
Test-Endpoint "Frontend UI" {
    $r = Invoke-WebRequest http://localhost:3000 -UseBasicParsing -TimeoutSec 15
    if ($r.StatusCode -ne 200) { throw "status $($r.StatusCode)" }
}
Test-Endpoint "Product search" {
    $body = '{"asin":"B0D1XD1ZV3"}'
    $p = Invoke-RestMethod http://localhost:3001/api/product/search -Method POST -ContentType "application/json" -Body $body -TimeoutSec 180
    if (-not $p.asin) { throw "no asin" }
    if ($null -eq $p.price) { throw "no price" }
    Write-Host "       -> $($p.asin) price=$($p.price)" -ForegroundColor Gray
}

if ($allOk) {
    Write-Host ""
    Write-Host "Tum testler gecti. Tarayicida ac: http://localhost:3000" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "Hata var. Calistir: docker compose logs -f" -ForegroundColor Red
    exit 1
}
