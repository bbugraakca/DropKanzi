# Dropkanzi (PriceHawk) — Teknik Mimari Dokümantasyonu

Bu doküman, Dropkanzi platformunun uçtan uca teknik mimarisini, veri akışlarını, servis sınırlarını ve Product Finder ürün bulma pipeline'ını açıklar.

---

## İçindekiler

1. [Genel Bakış](#1-genel-bakış)
2. [Servis Topolojisi (Docker)](#2-servis-topolojisi-docker)
3. [Dizin Yapısı](#3-dizin-yapısı)
4. [Veritabanı Şeması](#4-veritabanı-şeması)
5. [Product Finder — Kavramlar](#5-product-finder--kavramlar)
6. [Sold Tarama Pipeline'ı (Found)](#6-sold-tarama-pipelineı-found)
7. [Live Tarama Pipeline'ı (Active)](#7-live-tarama-pipelineı-active)
8. [Amazon Eşleştirme Motoru](#8-amazon-eşleştirme-motoru)
9. [Kar Hesaplama](#9-kar-hesaplama)
10. [Backend API — Product Finder](#10-backend-api--product-finder)
11. [Frontend Mimarisi](#11-frontend-mimarisi)
12. [Kuyruk (Queue) Sistemi](#12-kuyruk-queue-sistemi)
13. [Kalıcılık ve Veri Güvenliği](#13-kalıcılık-ve-veri-güvenliği)
14. [Proxy ve Bant Genişliği](#14-proxy-ve-bant-genişliği)
15. [Bulk Modülü (ASIN Toplu Tarama)](#15-bulk-modülü-asin-toplu-tarama)
16. [Ortam Değişkenleri](#16-ortam-değişkenleri)
17. [Dağıtım ve Sağlık Kontrolleri](#17-dağıtım-ve-sağlık-kontrolleri)

---

## 1. Genel Bakış

Dropkanzi, **eBay satıcılarının listelerini tarayıp Amazon'da eşleştiren** ve **kar marjını hesaplayan** bir arbitraj/dropshipping araştırma platformudur.

Temel iş akışı:

```
eBay satıcı → listing listesi (sold veya active)
           → benzersiz başlık grupları
           → Amazon SERP + görsel/başlık skoru
           → ASIN + Amazon fiyat (AOD)
           → net kar / marj hesabı
           → PostgreSQL
           → Next.js UI (filtre, save, export)
```

Platform üç ana runtime'dan oluşur:

| Katman | Teknoloji | Rol |
|--------|-----------|-----|
| **Frontend** | Next.js 14, React, TypeScript | UI, queue, localStorage yedek |
| **Backend** | Node.js, Express, Prisma | REST API, iş mantığı, DB |
| **Scraper** | Python, FastAPI, curl_cffi | eBay/Amazon kazıma, eşleştirme |

Altyapı: **PostgreSQL** (kalıcı veri), **Redis** (bulk job kuyruğu), **DataImpulse residential proxy** (tüm dış istekler).

---

## 2. Servis Topolojisi (Docker)

`docker-compose.yml` ile orchestrate edilir:

```
┌─────────────┐     /api rewrite      ┌─────────────┐
│  Frontend   │ ────────────────────► │   Backend   │
│  :3000      │     (Next.js proxy)   │   :3001     │
└─────────────┘                       └──────┬──────┘
       │                                     │
       │ NEXT_PUBLIC_API_URL                 │ Prisma
       │ (uzun scan'ler doğrudan)            ▼
       └────────────────────────────► ┌─────────────┐
                                        │ PostgreSQL  │
┌─────────────┐     HTTP               │   :5432     │
│   Scraper   │ ◄──────────────────────└─────────────┘
│   :8001     │
└──────┬──────┘
       │ proxy
       ▼
┌─────────────┐     ┌─────────────┐
│ DataImpulse │     │    Redis    │ ◄── Worker (BullMQ)
│   Proxy     │     │   :6379     │
└─────────────┘     └─────────────┘
       │
       ▼
  eBay + Amazon
```

| Servis | Port | Bağımlılıklar |
|--------|------|---------------|
| `postgres` | 5432 | — |
| `redis` | 6379 | — |
| `scraper` | 8001 | redis (env) |
| `backend` | 3001 | postgres, redis, scraper |
| `worker` | — | postgres, redis, scraper, backend |
| `frontend` | 3000 | backend |

**Adresler (geliştirme):**

- Arayüz: `http://localhost:3000`
- API: `http://localhost:3001/api`
- API (proxy): `http://localhost:3000/api`
- Scraper: `http://localhost:8001`

---

## 3. Dizin Yapısı

```
Dropkanzi/
├── docker-compose.yml
├── .env                          # Ana ortam değişkenleri (Docker)
├── docs/
│   └── ARCHITECTURE.md           # Bu dosya
├── frontend/
│   ├── app/product-finder/       # Ana PF sayfası (page.tsx)
│   ├── components/product-finder/
│   │   ├── FoundProductsPanel.tsx
│   │   ├── ActiveListingsPanel.tsx
│   │   ├── SellersWatchlistPanel.tsx
│   │   ├── QueuePanel.tsx
│   │   ├── SavedProductsPanel.tsx
│   │   ├── ResultsTable.tsx
│   │   └── ExportButton.tsx
│   └── lib/
│       ├── api.ts                # Backend HTTP client
│       ├── productFinderProfit.ts
│       ├── productFinderStorage.ts
│       └── backendUrl.ts
├── backend/
│   ├── prisma/schema.prisma
│   ├── src/
│   │   ├── index.ts              # Express app
│   │   ├── routes/productFinder.ts
│   │   ├── services/
│   │   │   ├── foundList.ts
│   │   │   ├── activeList.ts
│   │   │   ├── libraryList.ts
│   │   │   ├── pfArchive.ts
│   │   │   └── foundProducts.ts
│   │   └── workers/scrapeWorker.ts
│   └── prisma/migrations/
└── scraper/
    ├── main.py                   # FastAPI entry
    ├── ebay_scraper.py
    ├── amazon_matcher.py
    ├── amazon_search.py
    ├── profit_calculator.py
    ├── match_cache.py
    └── proxy_meter.py
```

---

## 4. Veritabanı Şeması

Prisma ORM + PostgreSQL. Product Finder ile ilgili modeller:

### 4.1 `SellerAnalysis`

Tarama snapshot'ı (cache). Her analyze sonrası yazılır.

| Alan | Tip | Açıklama |
|------|-----|----------|
| `seller` | string | eBay satıcı adı |
| `daysBack` | int | Sold için gün penceresi (0 = live scan) |
| `scanType` | string | `"sold"` veya `"active"` |
| `listings` | JSON | Eşleşen listing dizisi |
| `summary` | JSON | İstatistikler, proxy maliyeti, match grupları |

Index: `(seller, scanType, createdAt DESC)`

### 4.2 `FoundProduct`

Tüm satıcıların birleştirilmiş **sold** eşleşmeleri. Found sekmesinin kaynağı.

| Alan | Tip | Açıklama |
|------|-----|----------|
| `listingKey` | string (PK) | `lid:{id}\|{sold_date}\|{price}\|{qty}` formatı |
| `seller` | string? | Kaynak satıcı |
| `daysBack` | int? | Tarama penceresi |
| `payload` | JSON | Tam listing objesi |

### 4.3 `ActiveListingProduct`

**Live** eBay listeleri. Sold'dan farklı key: satış olayı suffix'i yok.

| Alan | Tip | Açıklama |
|------|-----|----------|
| `listingKey` | string (PK) | `lid:{listing_id}` veya `url:{normalized_url}` |
| `seller` | string? | Kaynak satıcı |
| `payload` | JSON | Tam listing objesi |

### 4.4 `PfLibraryProduct`

Saved / Reserved listeleri (sunucu tarafı kalıcılık).

| Alan | Tip | Açıklama |
|------|-----|----------|
| `listingKey` | string (PK) | Found ile aynı key mantığı |
| `bucket` | string | `"saved"` veya `"reserved"` |
| `payload` | JSON | Listing |

### 4.5 `PfDataArchive`

Destructive clear işlemlerinden önce otomatik snapshot.

| Alan | Tip | Açıklama |
|------|-----|----------|
| `source` | string | `"found"`, `"saved"`, `"reserved"` |
| `listingKey` | string | Satır kimliği |
| `payload` | JSON | Yedek veri |
| `reason` | string | Clear nedeni |

### 4.6 Diğer modeller

- **`Product` / `PriceHistory`**: Bulk ASIN tarama sonuçları
- **`Store`**: eBay OAuth + fee/VAT ayarları
- **`ScrapeJob`**: Bulk job durumu
- **`Listing`**: eBay listeleme kayıtları (listing modülü)

---

## 5. Product Finder — Kavramlar

### 5.1 Sekmeler

| Sekme | Veri kaynağı | İçerik |
|-------|--------------|--------|
| **Queue** | In-memory + localStorage | Bekleyen/çalışan taramalar |
| **Sellers** | localStorage history + API counts | Watchlist, scan/import aksiyonları |
| **Found** | `FoundProduct` | Satılan eBay → Amazon eşleşmeleri |
| **Live** | `ActiveListingProduct` | Aktif eBay → Amazon eşleşmeleri |
| **Saved** | `PfLibraryProduct` bucket=saved | Kullanıcının seçtiği ürünler |
| **Reserved** | `PfLibraryProduct` bucket=reserved | Ayrılmış ürünler |

### 5.2 Listing Key Stratejileri

**Found (sold)** — `foundProducts.ts` / `productFinderStorage.ts`:

```
lid:{listing_id}|{sold_date}|{sold_price}|{quantity}
url:{normalized_url}|{sold_event}
asin:{asin}|{sold_event}
```

**Active (live)** — `activeListingKey()`:

```
lid:{listing_id}          (8+ digit)
url:{normalized_ebay_url}
asin:{asin}
title:{truncated_title}
```

Aynı eBay listing birden fazla satışta Found'da ayrı satır; Live'da tek satır.

### 5.3 Kabul Edilen Eşleşme

- `match_confidence >= 0.80` (MIN_MATCH_CONFIDENCE)
- veya `match_method === "description"` (açıklamada ASIN)

---

## 6. Sold Tarama Pipeline'ı (Found)

### 6.1 Sequence Diagram

```
User → Frontend → Backend POST /analyze
                    → Scraper POST /product-finder/analyze
                         1. resolve_ebay_seller_id()
                         2. scrape_seller_sold_listings(days_back)
                         3. match_listings_batch() — Amazon
                         4. fetch_finder_prices_batch() — AOD
                         5. calculate_batch() — profit
                    ← listings + summary
                 → SellerAnalysis.create (cache)
                 → mergeMatchedIntoFound()
              ← response (listings_omitted if >150)
Frontend → FoundProductsPanel reload
```

### 6.2 eBay Sold Scrape

**Dosya:** `scraper/ebay_scraper.py`

- URL pattern: `_ssn={seller}&LH_Sold=1&LH_Complete=1&_ipg=240&_pgn={page}`
- Sayfa başına 240 listing
- Max items: `MAX_FINDER_LISTINGS = 5000` (güvenlik limiti)
- Tek seferde bir satıcı (`asyncio.Semaphore(1)` — `_EBAY_GATE`)
- Proxy: `EBAY_PROXY_MODE=always`

Her listing alanları:

```python
{
  "listing_id", "title", "sold_price", "quantity_sold",
  "sold_date", "url", "image", "listing_type": "sold"
}
```

### 6.3 Backend Persist

**Dosya:** `backend/src/routes/productFinder.ts`

- `mergeMatchedIntoFound()`: batch upsert (500'lük chunk, transaction timeout önlemi)
- `SellerAnalysis`: 7 günlük cache (`cacheCutoff()`)
- `forceRefresh=false` ise cache'den döner, Found'a merge eder

### 6.4 Found Listeleme

**Dosya:** `backend/src/services/foundList.ts`

- Server-side pagination, filtre, sort
- SQL tabanlı profit filtreleri (`profitableWhereSql`, `minMarginWhereSql`)
- Stats cache (`getFoundStats`)

---

## 7. Live Tarama Pipeline'ı (Active)

### 7.1 Sold'dan Farklar

| Özellik | Sold (Found) | Live (Active) |
|---------|--------------|---------------|
| eBay filtresi | LH_Sold + LH_Complete | Aktif listeler (sold filtresi yok) |
| Fiyat alanı | `sold_price` | `list_price` (= sold_price parser'dan) |
| `sold_date` | Dolu | `null` |
| DB tablosu | `FoundProduct` | `ActiveListingProduct` |
| Match group limit | 600 (sold default) | 0 = limitsiz |
| Max listings | 5000 | 10000 |
| eBay pagination | Sıralı | Paralel (5 sayfa/dalga) |
| Scan Live | `scanType: "active"`, `daysBack: 0` | |

### 7.2 Scraper Endpoint

```
POST /product-finder/analyze-active
Body: { seller, store_settings, fetch_prices, force_refresh, max_items }
```

**Dosya:** `scraper/main.py` → `_product_finder_analyze_active_inner()`

### 7.3 Live UI Aksiyonları

- **Save** → `PfLibraryProduct` (saved) + `POST /active/remove` (Live'dan sil)
- **Delete selected** → `POST /active/remove`
- **Export all CSV** → `fetchAllActivePages()` (1000'erli sayfa, tüm filtre)
- **Save all filtered** → tüm sayfalar yüklenir, sonra save + remove

---

## 8. Amazon Eşleştirme Motoru

**Dosya:** `scraper/amazon_matcher.py`

### 8.1 Pipeline (sırayla, confidence >= 0.86'da dur)

1. Başlıkta / açıklamada ASIN (`description` method → confidence 1.0)
2. MPN / model numarası exact search
3. SigLIP görsel eşleştirme + SERP adayları
4. Claude title clean + multi-query (ANTHROPIC_API_KEY varsa)
5. Claude Vision + search
6. Multi-keyword content scoring fallback

### 8.2 Batch Eşleştirme

**Fonksiyon:** `match_listings_batch()`

- Listings benzersiz `clean_query(title)` ile gruplanır
- Her gruptan bir temsilci listing eşleştirilir
- Sonuç tüm grup üyelerine yayılır
- Paralellik: `FINDER_MATCH_CONCURRENCY` (default 20), max 24
- Sold cap: `FINDER_MAX_MATCH_GROUPS=600`
- Active cap: `FINDER_ACTIVE_MAX_MATCH_GROUPS=0` (limitsiz)

### 8.3 Önbellek

**Dosya:** `scraper/match_cache.py`

- Redis: başarılı eşleşmeler + miss cache
- `force_refresh=true` → miss cache temizlenir
- Tekrar taramada proxy tasarrufu

### 8.4 Amazon SERP

**Dosya:** `scraper/amazon_search.py`

- Proxy: `FINDER_SERP_USE_PROXY=true`
- ~300 KB/arama
- Captcha abort streak → batch durdurulur

### 8.5 Amazon Fiyat (AOD)

**Dosya:** `scraper/main.py` → `fetch_finder_prices_batch()`

- All Offers Display endpoint (~8–64 KB/ASIN)
- Paralellik: `FINDER_PRICE_CONCURRENCY=50`
- Max: `FINDER_PRICE_MAX_ASINS=1000` per analyze

---

## 9. Kar Hesaplama

### 9.1 Formül

**Frontend:** `frontend/lib/productFinderProfit.ts`  
**Scraper:** `scraper/profit_calculator.py`

```
revenue     = sold_price (veya list_price live için)
ebay_fee    = revenue × 13.25%
payment_fee = revenue × 3%
amazon_cost = amazon_price × (1 + vatRate) + additionalFee
net_profit  = revenue - ebay_fee - payment_fee - amazon_cost
margin_%    = (net_profit / revenue) × 100
is_profitable = net_profit > 0
```

### 9.2 Store Settings

`Store.settings` JSON:

```json
{
  "vatDetails": { "vatEnabled": true, "vatRatePercent": 7 },
  "additionalFee": { "fixedFee": 0 }
}
```

Backend SQL filtreleri (`productFinderProfit.ts`) ve frontend enrich aynı parametreleri kullanır: `vatRatePercent`, `additionalFee`.

---

## 10. Backend API — Product Finder

Base path: `/api/product-finder`

### 10.1 Analiz

| Method | Path | Açıklama |
|--------|------|----------|
| POST | `/analyze` | Sold tarama → scraper proxy |
| POST | `/analyze-active` | Live tarama (timeout 2 saat) |
| GET | `/history/:seller/:daysBack` | Cache'den son analiz |
| GET | `/history` | Son 200 analiz |
| GET | `/seller-info/:seller` | Scraper seller doğrulama |

### 10.2 Found

| Method | Path | Açıklama |
|--------|------|----------|
| GET | `/found` | Sayfalı liste + filtre |
| GET | `/found/stats` | Aggregate istatistik |
| GET | `/found/sellers` | Satıcı listesi |
| GET | `/found/seller-counts` | Satıcı başına satır sayısı |
| GET | `/found/missing-price-asins` | Fiyatsız ASIN'ler |
| POST | `/found/merge` | Listing merge |
| POST | `/found/remove` | Seçili satırları sil |
| DELETE | `/found` | Tümünü temizle (archive önce) |
| POST | `/found/dedupe` | Duplicate temizle |
| POST | `/found/import/:seller/:daysBack` | SellerAnalysis → Found |
| POST | `/found/import-all` | Tüm cache'leri import |

### 10.3 Active (Live)

| Method | Path | Açıklama |
|--------|------|----------|
| GET | `/active` | Sayfalı liste + filtre |
| GET | `/active/stats` | Aggregate istatistik |
| GET | `/active/sellers` | Satıcı listesi |
| GET | `/active/seller-counts` | Satıcı başına satır sayısı |
| POST | `/active/remove` | Seçili satırları sil |
| DELETE | `/active` | Temizle (`?seller=` opsiyonel) |

### 10.4 Library (Saved / Reserved)

| Method | Path | Açıklama |
|--------|------|----------|
| GET | `/library?bucket=saved\|reserved` | Listele |
| PUT | `/library` | Full sync (`force=true` gerekli wipe için) |
| POST | `/library/merge` | Upsert (200'lük chunk) |
| POST | `/library/remove` | Sil |
| POST | `/library/move` | saved ↔ reserved |
| POST | `/library/restore-to-found` | Library → Found atomik |
| DELETE | `/library?bucket=` | Clear (archive önce) |
| POST | `/library/dedupe?bucket=` | Duplicate temizle |

### 10.5 Archive & Fiyat

| Method | Path | Açıklama |
|--------|------|----------|
| GET | `/archive/status?source=` | Yedek var mı |
| POST | `/archive/restore` | Son yedeği geri yükle |
| POST | `/prices` | ASIN listesi için AOD fiyat güncelle |

---

## 11. Frontend Mimarisi

### 11.1 Ana Orkestrasyon

**Dosya:** `frontend/app/product-finder/page.tsx`

- Tab state: queue | sellers | found | active | saved | reserved
- Queue pump: `MAX_PARALLEL_SELLERS=1`, cooldown 400ms
- Save flow: `moveToSaved()` → persistSaved → mergeLibraryProducts
- Live save: `removeFromActive: true` → removeActiveProducts
- Found save: `removeFromFound: true` → removeFoundProducts
- ConfirmDialog: clear / restore archive

### 11.2 API Client

**Dosya:** `frontend/lib/api.ts`

| İstek tipi | Base URL |
|------------|----------|
| Normal API | `browserApiBase()` → `/api` veya `NEXT_PUBLIC_API_URL` |
| Uzun analyze | `browserDirectBackendBase()` → `127.0.0.1:3001/api` |
| Library CRUD | `browserLibraryApiBase()` → `/api` (proxy, stabil) |

Timeout'lar:
- Analyze sold: 30 dk
- Analyze active: 2 saat
- Found/Active page (500+ limit): 3 dk

### 11.3 Server-Side Pagination

**ResultsTable** (`serverMode=true`):

- Filtreler debounce 400ms → backend query
- Sayfa boyutu: 50–1000 (localStorage'da saklanır)
- Export / Save all: `fetchAllFoundPages()` / `fetchAllActivePages()` (1000'erli)

### 11.4 localStorage Keys

| Key | İçerik |
|-----|--------|
| `pf_saved_products` | Saved yedek |
| `pf_reserved_products` | Reserved yedek |
| `pf_deleted_found_keys` | Client-side found hide |
| `pf_queue` | Queue snapshot |
| `pf_seller_history` | Watchlist (max 250) |
| `pf_active_tab` | Son açık sekme |

---

## 12. Kuyruk (Queue) Sistemi

Queue tamamen **client-side** çalışır (sunucu queue yok).

```typescript
type QueueItem = {
  id: string;
  seller: string;
  sellerInput?: string;
  daysBack: number;
  scanMode?: "sold" | "active";
  status: "queued" | "running" | "done" | "failed";
  forceRefresh?: boolean;
  fetchPrices?: boolean;
};
```

Akış:

1. `enqueue` → `queueRef.current.push()`
2. `pump()` → `MAX_PARALLEL_SELLERS` kadar `runOne()`
3. `runOne()` → `analyzeSeller()` veya `analyzeActiveSeller()`
4. Bitince → `archiveAndRemoveQueueItem()`, `bumpFound()` / `bumpActive()`
5. Network retry: 3 deneme, 6s backoff

---

## 13. Kalıcılık ve Veri Güvenliği

### 13.1 Katmanlar

```
1. PostgreSQL (birincil)
2. localStorage (fallback + hızlı UI)
3. PfDataArchive (clear öncesi snapshot)
```

### 13.2 Merge Stratejisi

- **Found/Active merge**: 500'lük chunk + deleteMany + createMany (transaction timeout önlemi)
- **Library merge**: 200'lük chunk POST /library/merge
- **Sync wipe koruması**: PUT /library `force=true` olmadan boş liste kabul edilmez

### 13.3 Onay Diyalogları

Destructive aksiyonlar `ConfirmDialog` ile korunur:

- Clear Found / Saved / Reserved
- Return to Found (library → found)
- Restore archive

### 13.4 Dedupe

Grup key sırası (en yüksek net kar kalır):

1. ASIN
2. eBay listing_id
3. Normalized URL
4. Normalized title

---

## 14. Proxy ve Bant Genişliği

**Sağlayıcı:** DataImpulse residential  
**Dosya:** `scraper/proxy.py`, `scraper/proxy_meter.py`

| Aşama | Tipik boyut |
|-------|-------------|
| eBay search page | 200–500 KB |
| Amazon SERP | ~300 KB |
| Amazon AOD | 8–64 KB/ASIN |

Scraper her analyze için `proxy_meter.start()` ile sıfırlar. Summary'de:

- `proxy_bytes`, `proxy_cost_usd`
- `proxy_stages`: ebay_search, amazon_search, amazon_price
- SERP: `serp_lookups`, `serp_proxy`, `serp_direct`

---

## 15. Bulk Modülü (ASIN Toplu Tarama)

Product Finder'dan bağımsız pipeline:

```
Frontend → POST /api/bulk → Redis queue (BullMQ)
         → Worker (scrapeWorker.ts)
         → Scraper POST /scrape (batch)
         → Product + PriceHistory upsert
```

**Worker env:**

- `BULK_CONCURRENCY=20`
- `BULK_CHUNK_SIZE=100`
- `WORKER_CONCURRENCY=3`

Scraper tier stratejisi:

- **Tier 1 (AOD)**: ~8 KB — her istekte fiyat/stok
- **Tier 2 (full page)**: ~150–500 KB — title/images (24h'de bir)

---

## 16. Ortam Değişkenleri

### 16.1 Altyapı

| Değişken | Açıklama |
|----------|----------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection |
| `SCRAPER_URL` | Backend → scraper (Docker: `http://scraper:8001`) |
| `NEXT_PUBLIC_API_URL` | Browser direct API (opsiyonel) |
| `BACKEND_INTERNAL_URL` | Next.js → backend proxy |
| `FRONTEND_URL` | CORS origin |

### 16.2 Proxy

| Değişken | Açıklama |
|----------|----------|
| `PROXY_USER`, `PROXY_PASS`, `PROXY_HOST`, `PROXY_PORT` | DataImpulse |
| `PROXY_COUNTRY` | IP ülkesi (us) |
| `EBAY_PROXY_MODE` | `always` |
| `FINDER_SERP_USE_PROXY` | Amazon SERP proxy |

### 16.3 Product Finder Limits

| Değişken | Default | Açıklama |
|----------|---------|----------|
| `FINDER_MATCH_CONCURRENCY` | 20 | Paralel Amazon arama |
| `FINDER_MATCH_MAX_CONCURRENCY` | 24 | Hard cap |
| `FINDER_EBAY_PAGE_CONCURRENCY` | 5 | Live eBay paralel sayfa |
| `FINDER_ACTIVE_MAX_LISTINGS` | 10000 | Live max ürün |
| `FINDER_ACTIVE_MAX_MATCH_GROUPS` | 0 | 0=limitsiz başlık |
| `FINDER_MAX_MATCH_GROUPS` | 600 | Sold başlık limiti |
| `FINDER_PRICE_CONCURRENCY` | 50 | Paralel AOD |
| `FINDER_FETCH_PRICES_ON_ANALYZE` | true | Analyze'da fiyat çek |

### 16.4 Opsiyonel AI

| Değişken | Açıklama |
|----------|----------|
| `ANTHROPIC_API_KEY` | Claude title/vision matching |
| `ANTHROPIC_MODEL` | Default: claude-haiku-4-5 |

---

## 17. Dağıtım ve Sağlık Kontrolleri

### 17.1 Başlatma

```powershell
cd c:\Dropkanzi
docker compose up -d --build
docker compose exec backend npx prisma migrate deploy
```

### 17.2 Health Checks

| Servis | Endpoint |
|--------|----------|
| Backend | `GET /api/health` |
| Scraper | `GET /health` |
| Postgres | `pg_isready` |
| Redis | `redis-cli ping` |

### 17.3 Timeout Yapılandırması

Uzun taramalar için:

- Backend Express: `requestTimeout=0`, `keepAliveTimeout=7_200_000`
- Undici agent: `headersTimeout/bodyTimeout=7_200_000`
- Analyze-active: 2 saat abort controller

### 17.4 Log İnceleme

```powershell
docker compose logs backend --tail 100
docker compose logs scraper --tail 100
docker compose logs frontend --tail 50
```

---

## Ek: Tipik Kullanıcı Akışı

1. **Sellers** → satıcı ekle → **Scan Live** veya **7d sold**
2. **Queue** → tarama ilerlemesini izle
3. **Live** / **Found** → filtre (kar, marj, confidence, seller)
4. **Save** → Saved (+ Live/Found'dan otomatik sil)
5. **Export all CSV** veya **Fetch prices**
6. **Reserved**'a taşı (ileride listelemek için)
7. Clear yaparsan → **Restore backup** ile geri al

---

## Ek: Bilinen Limitler

| Limit | Değer | Not |
|-------|-------|-----|
| Sold scrape cap | 5000 listing | eBay'de daha fazlası varsa truncated |
| Live scrape cap | 10000 listing | |
| Sold match groups | 600 unique title | `.env` ile değişir |
| Live match groups | 0 (limitsiz) | Büyük mağaza = uzun tarama |
| Response listings omit | >150 matched | HTTP body küçültme |
| Library PUT body | 50 MB | Express limit |
| Parallel seller scans | 1 | `_EBAY_GATE` + queue |
| Seller watchlist | 250 | `SELLER_HISTORY_MAX` |

---

*Son güncelleme: Product Finder v2 — Live tab, archive, server-side pagination, batch merge.*
