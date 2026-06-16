$ErrorActionPreference = "Stop"
$baseApi = "http://127.0.0.1:3001/api"
$baseWeb = "http://127.0.0.1:3000"

function Test-Url($name, $url) {
  $code = curl.exe -s -o NUL -w "%{http_code}" --max-time 15 $url
  if ($code -match "^2") {
    Write-Host "[OK] $name -> $code"
  } else {
    Write-Host "[FAIL] $name -> $code"
    exit 1
  }
}

Write-Host "Smoke test Dropkanzi..."
Test-Url "backend health" "$baseApi/health"
Test-Url "stores list" "$baseApi/stores"
Test-Url "ebay oauth url" "$baseApi/auth/ebay/url"
Test-Url "frontend home" "$baseWeb/"
Test-Url "frontend bulk" "$baseWeb/bulk"
Test-Url "bulk jobs list" "$baseApi/jobs"
Test-Url "frontend stores" "$baseWeb/stores"
Test-Url "frontend orders" "$baseWeb/orders"
Test-Url "frontend oauth" "$baseWeb/stores/oauth"
Test-Url "frontend billing" "$baseWeb/billing"
Test-Url "frontend messages" "$baseWeb/messages"
Test-Url "scraper docs" "http://127.0.0.1:8001/docs"

$repricing = "$baseWeb/stores/clxxxxxxxxxxxxxxxxxxxxxx/settings/repricing/offer-selection"
$codeRepr = curl.exe -s -o NUL -w "%{http_code}" --max-time 15 $repricing
if ($codeRepr -match "^2") {
  Write-Host "[OK] repricing page -> $codeRepr"
} else {
  Write-Host "[FAIL] repricing page -> $codeRepr"
  exit 1
}

$saveAllBody = '{"enabled":true}'
$saveAll = Invoke-RestMethod -Uri "$baseApi/stores/settings/roundPrices" -Method POST -ContentType "application/json" -Body $saveAllBody
if ($saveAll.ok -ne $true) {
  Write-Host "[FAIL] save-all settings -> missing ok:true"
  exit 1
}
Write-Host "[OK] save-all settings -> ok"

$fake = "clxxxxxxxxxxxxxxxxxxxxxx"
$code404 = curl.exe -s -o NUL -w "%{http_code}" --max-time 15 "$baseApi/stores/$fake/settings"
if ($code404 -eq "404") {
  Write-Host "[OK] settings missing store -> 404"
} else {
  Write-Host "[FAIL] settings missing store -> $code404 (expected 404)"
  exit 1
}
Write-Host "All smoke checks passed."
