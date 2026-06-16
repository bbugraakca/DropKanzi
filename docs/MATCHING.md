# Product Finder — Amazon Match Mantığı

Bu doküman Dropkanzi Product Finder’ın **eBay sold listing → Amazon ASIN** eşleştirme pipeline’ını açıklar. Kaynak kod: `scraper/amazon_matcher.py`, `scraper/amazon_search.py`, `scraper/ebay_scraper.py`, `scraper/match_cache.py`, `scraper/main.py`.

---

## 1. Genel akış

```
eBay sold scrape (N satır)
        ↓
Title temizleme + gruplama (unique title sayısı ≤ N)
        ↓
Her unique title için match pipeline (sırayla, ilk başarıda dur)
        ↓
Confidence ≥ 80% filtresi
        ↓
Sonuç tüm aynı title’lı satırlara kopyalanır
        ↓
Profit hesabı + Found’a kayıt
```

**Önemli:** UI’daki **“matched”** = Amazon ASIN bulundu **ve** güven skoru **≥ %80**.  
**“sold”** = eBay’den çekilen satış satırı sayısı.  
**“Amazon searches”** = proxy ile yapılan arama sayısı (match sayısı değil).

---

## 2. eBay tarafı — ne çekilir?

Dosya: `scraper/ebay_scraper.py`

| Alan | Kaynak |
|------|--------|
| `title` | Sold arama kartı |
| `sold_price` | Kart fiyatı |
| `sold_date` | Caption (“Sold May 14, 2025”) |
| `quantity_sold` | Attribute satırı |
| `listing_id` | `data-listingid` veya URL `/itm/{id}` |
| `image` | Thumbnail URL |
| `url` | eBay item linki |

**Varsayılan scrape sadece arama sonuç kartlarını okur.** Her ilanın tam açıklama sayfası otomatik indirilmez.  
`amazon_asin` başlangıçta `null` gelir.

Proxy: eBay için `EBAY_PROXY_MODE=on_challenge` (önce direct, block olursa proxy).

---

## 3. Gruplama — 225 sold ≠ 225 arama

Dosya: `scraper/amazon_matcher.py` → `match_listings_batch()`

1. Her listing’in title’ı `clean_query()` ile normalize edilir.
2. Aynı normalize title → **tek grup**.
3. Gruptan **en yeni sold_date**’li satır temsilci seçilir.
4. Match sonucu gruptaki **tüm index’lere** kopyalanır (`_copy_match_fields`).

Örnek:

| Sold satır | Title | Grup |
|------------|-------|------|
| 1 | iPhone 15 Case Black NEW | `iphone 15 case black` |
| 2 | iPhone 15 Case Black Fast Ship | `iphone 15 case black` |
| 3 | Samsung S24 Case | `samsung s24 case` |

225 sold → tipik olarak **120–200 unique title** aranır.

**Limit:** `FINDER_MAX_MATCH_GROUPS` (varsayılan 600) — en yeni title’lar önce, geri kalan `groups_skipped`.

---

## 4. Eşik değerleri (sabitler)

| Sabit | Değer | Anlam |
|-------|-------|-------|
| `MIN_MATCH_CONFIDENCE` | **0.80** | Altındaki eşleşmeler reddedilir (ASIN silinir) |
| `STOP_CONFIDENCE` | **0.86** | Bu üstü bulunca pipeline erken biter |
| `MIN_MATCH_CONFIDENCE` (frontend) | **0.80** | Found tab aynı barajı kullanır |
| `description` match_method | — | ASIN eBay açıklamasından geldiyse **%100 kabul** |

Frontend: `frontend/lib/productFinderMatch.ts` → `isAcceptedMatch()`.

---

## 5. Match pipeline — adım adım

Dosya: `scraper/amazon_matcher.py` → `_match_listing_inner()`

Her **unique title** için aşağıdaki sıra uygulanır. İlk **başarılı** (≥80%) adımda durulur.

### Adım 0 — Redis title cache

Dosya: `scraper/match_cache.py`

- Key: SHA256(normalize title) → `pf:m:{digest}`
- **Hit (ASIN + conf ≥ 80%):** cache’ten döner, Amazon’a gitmez.
- **Miss cache (`_miss: true`):** 48 saat boyunca tekrar aramaz (`FINDER_MISS_CACHE_TTL`, varsayılan 172800).
- **Fresh scan** (`force_refresh=true`): miss cache atlanır, Amazon tekrar denenir.

### Adım 1 — Pre-extracted ASIN

Listing’de zaten `amazon_asin` varsa → confidence **1.0**, method `pre_extracted`.

### Adım 2 — ASIN title içinde

Regex: `\b(B[A-Z0-9]{9})\b` (10 karakter, B ile başlayan Amazon ASIN)

Örnek title: `"Buy on Amazon B08N5WRWNW today"` → ASIN bulunur, confidence **0.99**.

### Adım 3 — eBay ilan sayfası (ebay_detail)

`get_listing_details(listing_id)` → `https://www.ebay.com/itm/{id}`

HTML’de aranır:

- `amazon.com/dp/{ASIN}` linkleri
- `\b(B[A-Z0-9]{9})\b` token

Proxy: eBay `on_challenge` modu (direct önce).

Bulunursa confidence **0.99**, method `ebay_detail`.

### Adım 4 — MPN / model / UPC araması

Title’dan çıkarılan identifier’lar:

| Tip | Örnek pattern |
|-----|----------------|
| Apple MPN | `MLA02LL/A` |
| Samsung | `SM-G991B` |
| Genel MPN | `ABC-1234-X` |
| UPC | 12–13 haneli sayı |

Her biri için Amazon SERP’te aranır (`search_by_mpn`):

- MPN Amazon title’da geçiyorsa → **0.98** (`mpn_exact`)
- İlk aday content score ≥ 80% → **0.82+** (`mpn_search`)

### Adım 5 — Claude title temizleme (opsiyonel)

Env: `FINDER_CLAUDE_MATCH=true` + `ANTHROPIC_API_KEY`

Kapalıysa (varsayılan): sadece `clean_query()` + `_search_queries()` kullanılır.

Açıksa Claude:

- Brand, clean title, arama sorguları üretir
- Görünür ASIN varsa çıkarır → **0.98** (`claude_asin_extract`)

### Adım 6 — Amazon SERP araması (ana yol)

Dosya: `scraper/amazon_search.py`

#### 6a. Arama sorgusu üretimi

`clean_query(title)`:

- Kaldırılır: `new`, `free ship`, `fast ship`, `lot of N`, vb.
- Noktalama temizlenir, max 120 karakter.

`_search_queries(title)` — en fazla 3 varyant:

1. Tam temiz title
2. Marka + model token’ları (rakam içeren kelimeler)
3. Kısa anchor (marka + en uzun model token)

`FINDER_MAX_SERP_QUERIES` (varsayılan **2**) kadar sorgu denenir.

#### 6b. SERP fetch

URL: `https://www.amazon.com/s?k={query}`

Dosya: `scraper/amazon_search.py` → `fetch_serp()`, `_fetch_serp_html()`, `_fetch_serp_html_full()`

**İki aşamalı indirme:**

1. **Stream fetch** — bant genişliği tasarrufu için parça parça okunur.
   - Cap: **128 KB** (`SERP_STREAM_MAX_BYTES`, varsayılan 131072)
   - Her **12 KB**’da bir parse denemesi (`SERP_PARSE_EVERY_BYTES`)
   - **≥3 aday** parse edilirse stream erken biter (eski `data-asin="B` sayacı kaldırıldı — yanıltıcıydı)

2. **Tam sayfa fallback** — stream’de **3’ten az aday** varsa non-streaming GET yapılır.
   - Cap: **1 MB** (`SERP_FULL_MAX_BYTES`, varsayılan 1048576)
   - Amazon SERP sayfası ~1 MB; ürün kartları ~50 KB sonrasında başlar ama **yarım HTML parse edilemez** — bu yüzden tam sayfa gerekli

**Proxy stratejisi:**

- **Önce proxy’siz** (2 sn rate limit, `FINDER_NO_PROXY_SERP_INTERVAL_SEC`)
- Sonuç yoksa veya yetersizse **proxy ile** tekrar
- Boş SERP sonucu Redis’e **yazılmaz** (proxy fallback’i engellememek için)
- Proxy concurrency: `FINDER_PROXY_CONCURRENCY` (varsayılan 2)

**Captcha / bot:**

- `_serp_is_blocked()` — captcha, “automated access”, robot mesajları
- Streak sayacı; limit aşılırsa kalan title’lar `captcha_abort`
- Shell sayfa uyarısı: HTML büyük ama `s-result-item` / `data-asin` yok

**Header:** `Referer: https://www.amazon.com/`, `Accept-Language: en-US`

#### 6c. Aday çıkarma

`_parse_serp_candidates()` — sırayla dener:

| Katman | Yöntem |
|--------|--------|
| 1 | CSS: `div.s-result-item[data-asin]`, `s-search-result`, `role=listitem`, `article`, `[data-asin]` |
| 2 | JSON embed: `"title"` + `"asin"` çiftleri (script blokları) |
| 3 | Regex: `data-asin="B…"` + yakın HTML’den title çıkarma |
| 4 | Fallback: `/dp/{ASIN}` linkleri (HTML > 5 KB) |

Her adaydan: `asin`, `title`, `image`, `price` (SERP kartı).

Max aday: `FINDER_SERP_CANDIDATES` (varsayılan **8**).

**Tanı:** `scraper/debug_serp.py` — stream vs tam sayfa karşılaştırması.

#### 6d. Skorlama — `_content_score()`

eBay referans title vs Amazon aday title:

| Bileşen | Ağırlık |
|---------|---------|
| F1 (precision/recall kelime örtüşmesi) | 40% |
| Recall (eBay kelimelerinin Amazon’da bulunma oranı) | 25% |
| Model token hit (1tb, sm-g991 vb.) | 20% |
| Bigram overlap | 15% |

**Cezalar:**

- Amazon title “case for / compatible with” ama eBay değil → ×0.45
- eBay marka kelimesi Amazon’da yok → ×0.62
- Amazon title’da çok fazla ekstra kelime → ×0.72
- Model token eBay’de var Amazon’da yok → ×0.35

En yüksek skorlu aday `text_best` olur.

#### 6e. Görsel doğrulama — SigLIP (semantik)

Dosya: `scraper/image_match.py`

**dHash kaldırıldı** → **SigLIP** (`google/siglip-base-patch16-224`, CPU inference ~150ms/görsel).

Koşul: eBay `image` URL var + text skoru `IMAGE_CHECK_MIN_TEXT`–`IMAGE_CHECK_MAX_TEXT` aralığında (varsayılan **0.45–0.81**)

1. eBay görseli indirilir (**proxy yok**, CDN direct)
2. İlk **3** adayın görselleri indirilir (`FINDER_IMAGE_CANDIDATES`)
3. SigLIP embedding cosine similarity → `image_score`

Kabul eşikleri (`amazon_matcher.py` / `amazon_search.py`):

- combined = 0.45×content + 0.55×image
- `image_score` ≥ 0.75 → confidence boost (≥80% barajını geçmek için)
- Zayıf text + güçlü görsel kombinasyonları kurtarılabilir

Method: `image_siglip`

Text skoru zaten yüksekse (≥ `IMAGE_CHECK_MAX_TEXT`) görsel indirilmez (maliyet tasarrufu).

Model startup’ta warmup: `scraper/main.py` lifespan → `siglip_warmup()` (~5–6 sn ilk açılış).

#### 6f. Sorgu erken çıkış

Amazon sonuç döndürdü ama hiçbiri ≥80% geçmedi → **alternatif sorgu varyantları denenmez** (proxy tasarrufu).

Sadece SERP tamamen boşsa bir sonraki sorgu denenir.

### Adım 7 — Claude Vision (opsiyonel)

Env: `FINDER_VISION_MATCH=true` + API key

SERP + vision birleşik skor. Varsayılan **kapalı**.

### Adım 8 — Miss cache yaz

Hiçbir adım ≥80% veremediyse:

- `match_cache.set_miss(clean_title)` — 48 saat Amazon’a gitme
- Listing: `amazon_asin: null`, `match_confidence: 0`

---

## 6. Son backend filtresi

Dosya: `scraper/main.py` → analyze endpoint

Match pipeline sonrası **ikinci kez** filtre:

```python
if float(conf) < MIN_MATCH_CONFIDENCE:  # 0.80
    l["amazon_asin"] = None
```

**İstisna:** `match_method == "description"` → her zaman kalır.

API yanıtında sadece **kabul edilen** listing’ler döner (`matched` listesi).

Summary:

- `total_listings` = eBay sold satır sayısı
- `matched_to_amazon` = ≥80% confidence sayısı
- `match_groups_total` = unique title grubu
- `match_groups_attempted` = aranan grup
- `match_groups_skipped` = limit nedeniyle atlanan

---

## 7. Proxy maliyeti nereden gelir?

Dosya: `scraper/proxy_meter.py`

| Stage | Ne sayılır |
|-------|------------|
| `ebay_search` | eBay sold sayfa fetch (proxy kullanıldıysa) |
| `ebay_detail` | eBay item sayfası (proxy kullanıldıysa) |
| `amazon_search` | Amazon SERP stream (proxy ile yapılanlar) |
| `amazon_price` | AOD fiyat fetch (match sonrası) |

**Sayılmaz:** eBay/Amazon CDN görsel indirmeleri (SigLIP).

Tipik SERP maliyeti:

| Senaryo | Yaklaşık boyut |
|---------|----------------|
| Stream başarılı (erken çıkış) | 12–128 KB |
| Tam sayfa fallback | ~0.5–1 MB |
| No-proxy deneme | Proxy sayacına girmez |

@ $1/GB residential: tam sayfa fallback ≈ $0.001/arama.

**0 match + düşük MB** genelde şu demek:

- Çoğu title **cached_miss** (tekrar aranmadı)
- veya az unique title gerçekten Amazon’a gitti
- veya no-proxy denemeleri başarılı/başarısız ama proxy’siz

**0 match + yüksek MB** genelde:

- Çok unique title × SERP sorgusu
- Fresh scan, miss cache yok
- Her title için proxy SERP denendi

---

## 8. Frontend — Found tab ile uyum

Dosya: `frontend/lib/productFinderMatch.ts`

```typescript
export const MIN_MATCH_CONFIDENCE = 0.8;

export function isAcceptedMatch(listing) {
  if (!listing.amazon_asin) return false;
  if (listing.match_method === "description") return true;
  return effectiveMatchConfidence(listing.match_confidence) >= 0.8;
}
```

Found tab badge (global total) seller filtresinden bağımsız; stat kartları aktif filtreye göre hesaplanır.

---

## 9. Match method referansı

| `match_method` | Confidence | Açıklama |
|----------------|------------|----------|
| `pre_extracted` | 1.0 | Zaten ASIN vardı |
| `description` | 1.0 | eBay açıklamasında ASIN (legacy path) |
| `asin_in_title` | 0.99 | Title’da ASIN regex |
| `ebay_detail` | 0.99 | eBay item HTML’de ASIN |
| `mpn_exact` | 0.98 | MPN Amazon title’da birebir |
| `claude_asin_extract` | 0.98 | Claude ASIN çıkardı |
| `mpn_search` | 0.82+ | MPN SERP + content score |
| `search` / `search_query_N` / `search_best` | değişken | SERP text score |
| `image_siglip` | değişken | Text + SigLIP görsel skoru |
| `image_vision` | değişken | Claude Vision (kapalı) |
| `cached_miss` | 0 | Daha önce denendi, bulunamadı |
| `captcha_abort` | 0 | Amazon captcha limiti |
| `no_match` | 0 | Timeout / hata / eşik altı |

---

## 10. Sık senaryolar — neden 0 match?

| Senaryo | Ne olur |
|---------|---------|
| Generic title (“Women Dress Size M”) | SERP’te çok aday, en iyisi %60–75 → red |
| Aksesuar (“Case for iPhone 15”) | Accessory penalty, yanlış ürün riski → red |
| Marka Amazon US’te yok | Düşük content score → red |
| Daha önce taranmış seller | cached_miss → Amazon’a gitmez, 0 match, düşük proxy |
| Amazon captcha | Toast’ta `Amazon captcha/block` |
| Title’da ASIN / eBay link yok | Adım 2–3 atlanır, sadece SERP kalır |
| 30 gün pencerede 0 match | 7 gün pencere genelde çözmez; asıl mesele title/skor |

---

## 11. Ortam değişkenleri (tuning)

| Env | Varsayılan | Etki |
|-----|------------|------|
| `FINDER_MAX_MATCH_GROUPS` | 600 | Max unique title araması |
| `FINDER_MAX_SERP_QUERIES` | 2 | Title başına max SERP sorgusu |
| `FINDER_SERP_CANDIDATES` | 8 | SERP’ten max aday |
| `FINDER_SERP_CONCURRENCY` | 8 | Paralel SERP isteği |
| `FINDER_PROXY_CONCURRENCY` | 2 | Paralel proxy SERP |
| `FINDER_IMAGE_CANDIDATES` | 3 | SigLIP için max görsel aday |
| `IMAGE_CHECK_MIN_TEXT` | 0.45 | Görsel gate alt sınır |
| `IMAGE_CHECK_MAX_TEXT` | 0.81 | Görsel gate üst sınır (üstü skip) |
| `FINDER_MATCH_CONCURRENCY` | 6 | Paralel match |
| `FINDER_CLAUDE_MATCH` | false | Claude title |
| `FINDER_VISION_MATCH` | false | Claude Vision |
| `FINDER_MISS_CACHE_TTL` | 172800 (48h) | Miss cache süresi |
| `SERP_STREAM_MAX_BYTES` | 131072 (128 KB) | SERP stream cap |
| `SERP_FULL_MAX_BYTES` | 1048576 (1 MB) | Tam sayfa fallback cap |
| `SERP_PARSE_EVERY_BYTES` | 12000 | Stream parse aralığı |
| `FINDER_NO_PROXY_SERP_INTERVAL_SEC` | 2 | No-proxy SERP rate limit |
| `FINDER_CAPTCHA_ABORT_AFTER` | 10 | Captcha streak limiti |
| `SIGLIP_MODEL` | google/siglip-base-patch16-224 | Görsel model |
| `ANTHROPIC_API_KEY` | — | Claude için gerekli |

---

## 12. Fresh scan vs cache scan

| | Normal scan | Fresh scan |
|---|-------------|------------|
| eBay | 7 gün DB cache kullanılabilir | Yeniden scrape |
| Match miss cache | Kullanılır (48h) | Atlanır (`skip_miss_cache` + `clear_miss_cache`) |
| Seller analysis cache | 7 gün | Bypass |

Fresh scan: SellerSearch → “Fresh scan” checkbox.

---

## 13. Diyagram

```
┌─────────────────────────────────────────────────────────────┐
│                    eBay Sold Scrape                          │
│              225 rows (title, price, image, id)              │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Group by clean_query(title)                     │
│         ~150 unique titles (newest first, cap 600)           │
└──────────────────────────┬──────────────────────────────────┘
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
     [Redis cache]   [Free: ASIN in     [Paid: Amazon SERP
      hit / miss]     title / eBay       + score ≥ 80%]
                      detail page]
          │                │                │
          └────────────────┴────────────────┘
                           │
                           ▼
              confidence ≥ 0.80 ? ──No──→ ASIN = null (0 match)
                           │
                          Yes
                           ▼
              Copy to all rows with same title
                           ▼
              Optional: AOD price fetch per ASIN
                           ▼
                    Found / Profit UI
```

---

## 14. İlgili dosyalar

| Dosya | Rol |
|-------|-----|
| `scraper/amazon_matcher.py` | Match pipeline v3 |
| `scraper/amazon_search.py` | SERP fetch + content score |
| `scraper/ebay_scraper.py` | eBay sold + detail ASIN |
| `scraper/match_cache.py` | Redis title cache |
| `scraper/image_match.py` | SigLIP görsel benzerliği |
| `scraper/debug_serp.py` | SERP stream vs tam sayfa tanı aracı |
| `scraper/main.py` | `/product-finder/analyze` orchestration |
| `scraper/proxy_meter.py` | Bandwidth / cost tracking |
| `frontend/lib/productFinderMatch.ts` | UI acceptance rules |

---

## 15. Son değişiklikler (Haziran 2026)

### Amaç

**%100 match hedefi değil** — %80 güven eşiği korunur. Amaç: SERP’ten gerçek ürünlerin kaybolmaması (önceden `data-asin count: 0` ile çoğu title eleniyordu).

### SERP düzeltmeleri (`amazon_search.py`)

| Sorun | Çözüm |
|-------|-------|
| 40 KB stream cap ürün kartlarından önce kesiyordu | Varsayılan **128 KB** stream |
| `data-asin="B` sayısına göre erken çıkış yanıltıcıydı | Kaldırıldı; sadece **≥3 parse edilmiş aday** ile erken çıkış |
| 262 KB tam sayfa yeterli değildi (~1 MB HTML gerekli) | `SERP_FULL_MAX_BYTES` → **1 MB** |
| Stream’de 1–2 aday bulununca tam sayfa atlanıyordu | **<3 aday** → otomatik tam sayfa fallback |
| Boş SERP Redis’e yazılıyordu, proxy hiç denenmiyordu | Sadece **dolu** sonuç cache’lenir |
| Tek CSS selector Amazon markup değişince kırılıyordu | JSON embed + regex + `/dp/` fallback katmanları |
| Bot/captcha sayfa ayrımı yoktu | `_serp_is_blocked()` + shell sayfa logu |

### Görsel eşleştirme (`image_match.py`)

- **dHash → SigLIP** (`google/siglip-base-patch16-224`)
- Docker build’de model önceden indirilir (warmup ~5–6 sn)
- `image_siglip` match method; image ≥0.75 ise confidence boost

### Maliyet optimizasyonları

- `FINDER_MAX_SERP_QUERIES`: 4 → **2**
- `FINDER_SERP_CANDIDATES`: 12 → **8**
- `FINDER_IMAGE_CANDIDATES`: **3**
- Proxy yalnızca no-proxy boş/yetersiz olduğunda
- Miss cache: 8h → **48h** (172800)

### Bug fix’ler

| Bug | Fix |
|-----|-----|
| `match_cache` import eksik → tüm match’ler fail | `amazon_matcher.py` import eklendi |
| Boş SERP cache proxy fallback’i blokluyordu | Sadece non-empty cache write |
| Scraper rebuild sırasında `ENOTFOUND scraper` | Backend `fetchScraper()` 3× retry + healthcheck |
| SigLIP Docker deps | `sentencepiece`, `protobuf`, `numpy<2`, torch CPU |

### Tanı logları (`amazon_matcher.py`)

- `total_listings`, `unique_titles`, `clean_query_sample`
- Per-title SERP: `use_proxy`, `status`, `candidates`, `html_len`
- `match_method_distribution` özet

### Deploy

```powershell
docker compose up -d --build scraper backend frontend
```

Seller için **Fresh scan** (Ctrl+F5) — eski miss cache ve DB cache bypass.

`.env` güncellemesi (eski değerler varsa):

```env
SERP_STREAM_MAX_BYTES=131072
SERP_FULL_MAX_BYTES=1048576
SERP_PARSE_EVERY_BYTES=12000
FINDER_MISS_CACHE_TTL=172800
FINDER_MAX_SERP_QUERIES=2
FINDER_SERP_CANDIDATES=8
FINDER_IMAGE_CANDIDATES=3
IMAGE_CHECK_MIN_TEXT=0.45
IMAGE_CHECK_MAX_TEXT=0.81
```

### Test

```powershell
docker compose exec scraper python debug_serp.py
```

Beklenen (Amazon 200 döndüğünde): tam sayfa **6 aday**, stream+fallback **≥3 aday**.

---

*Son güncelleme: Haziran 2026 — SERP full-fetch fallback + SigLIP.*
