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

#### 6e. Multi-signal skorlama (varsayılan) — UPC / MPN / marka / pHash / title

Dosyalar: `scraper/match_score.py`, `scraper/image_match.py` (router)

**Varsayılan:** `FINDER_VISION_MATCH=false` → SigLIP kapalı, **puan tabanlı** eşleştirme açık.

Text skoru `IMAGE_CHECK_MAX_TEXT` (varsayılan **0.81**) altındaysa SERP adayları `score_candidates()` ile puanlanır:

| Sinyal | Puan | Koşul |
|--------|------|--------|
| UPC eşleşmesi | +100 | eBay title ↔ Amazon listing |
| MPN eşleşmesi | +80 | regex ile çıkarılan model/parça no |
| Marka | +20 | eBay brand Amazon title’da |
| Marka + title bonus | +40 | marka + title similarity > 0.85 |
| pHash | +30 | **yalnızca marka eşleşirse**; görsel indirme hatası → sinyal yok sayılır (red değil) |
| Title similarity | +20 | similarity > 0.80 |

**Kabul:** `match_score >= FINDER_MATCH_SCORE_THRESHOLD` (varsayılan **80** — MPN tek başına yeterli).

**Belirsizlik reddi:** İlk iki aday arası fark `< FINDER_MATCH_MIN_GAP` (varsayılan **10**) → eşleşme yok — **ancak** top skor `> FINDER_MATCH_GAP_BYPASS_SCORE` (120) ise gap kontrolü atlanır.

**Title normalization:** SERP ve similarity öncesi `normalize_ebay_title()` — LOT OF, FREE SHIPPING, NEW SEALED vb. silinir; MPN/marka korunur (`ebay_title_normalize.py`).

**SERP bullet/snippet:** MPN/marka eşleşmesi Amazon title + SERP kartındaki secondary metinde aranır (ek HTTP yok).

**Miss cache:** Varsayılan `FINDER_MISS_CACHE_TTL=21600` (6 saat).

**MPN filtresi:** “Pack of”, “x2” gibi paket ifadeleri MPN sayılmaz.

**Confidence (UI / backend filtresi):** `score_to_confidence(score)` — eşik üstü skorlar **0.80–0.99** aralığına map edilir (`MIN_MATCH_CONFIDENCE` ile uyumlu).

Method: `score_match` (veya alt method: `upc`, `mpn`, `phash`, vb.)

**Legacy rollback:** `FINDER_VISION_MATCH=true` → eski **SigLIP** yolu (`scraper/image_match_siglip.py`, `image_siglip` method).

Text skoru zaten yüksekse (≥ `IMAGE_CHECK_MAX_TEXT`) multi-signal görsel adımı atlanır.

#### 6f. Claude arbitration (opsiyonel, son çare)

Dosya: `scraper/claude_arbitration.py` — `_best_from_candidates()` içinde multi-signal skorlama **başarısız** olduktan sonra, text-only fallback’ten **önce**.

**Amaç:** Skor bandı 50–75 arasında kalan belirsiz eşleşmelerde Claude’a en fazla 3 SERP adayını gönderip tie-break yapmak. Ucuz sinyaller (UPC/MPN/pHash) Claude’u **ezmez**.

**Bayraklar:**

| Env | Varsayılan | Anlam |
|-----|------------|-------|
| `FINDER_CLAUDE_ARBITRATION` | false | Açıkken arbitration aktif |
| (yoksa) `FINDER_CLAUDE_MATCH` | false | Legacy fallback — arbitration bayrağı set değilse title-clean bayrağına bakılır |
| `FINDER_CLAUDE_MAX_CALLS` | 20 | Tarama başına max API çağrısı |
| `FINDER_CLAUDE_SCORE_MIN` / `MAX` | 50 / 75 | Sadece bu bandda çağrılır |
| `FINDER_CLAUDE_GAP_SOFT` | 8 | Üst bantta (≥70) top-2 farkı bu kadar ise Claude atlanır |
| `FINDER_CLAUDE_TIMEOUT_SEC` | 10 | API timeout |

**Eligibility (sırayla):**

1. `score_candidates()` ≥80 ile kabul etmediyse devam.
2. UPC veya MPN sinyali varsa → **Claude çağrılmaz** (ucuz yol yeterli olmalı).
3. En iyi skor `< 50` veya `≥ 75` → Claude yok.
4. Aday yok veya tarama bütçesi doldu → Claude yok.
5. **Soft gap:** skor ≥70 **ve** (top1 − top2) ≥ `FINDER_CLAUDE_GAP_SOFT` → Claude atlanır (üst bantta net ayrışma). Düşük skorda (50–69) gap kontrolü **yok** — recall korunur.

**Çağrı:** En fazla 3 aday (title 120 karakter), temperature 0, yanıt yalnızca ASIN veya `NONE`.

**Güven:** `0.82–0.88` (`0.80 + (best_score − 50) / 250`, clamp). UPC (~0.99) ve MPN (~0.92) ile aynı seviyede değil.

**Hallucination guard:** Dönen ASIN 10 karakter olmalı ve aday listesinde bulunmalı.

**Cache (Redis):** Bileşik key `sha1(normalized_title|brand|mpn|seller_id)` → `claude_match:{digest}`

| Sonuç | TTL |
|-------|-----|
| MATCH | 7 gün |
| NONE | 24 saat |

**Run-scoped ASIN reuse:** Her `match_listings_batch()` başında sıfırlanır. Aynı ASIN aynı taramada 3+ farklı ürüne atanmaya çalışılırsa reddedilir (`asin_reuse_rejected`) — tek ASIN’in herkese yapışması bug’ına karşı.

**Fail-safe:** API hatası → `no_match`, tarama devam eder.

Method: `claude_arbitration`

#### 6g. Sorgu erken çıkış

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

**Sayılmaz:** eBay/Amazon CDN görsel indirmeleri (pHash / legacy SigLIP).

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
| `score_match` | 0.80+ | Multi-signal skor (UPC/MPN/brand/pHash/title) |
| `claude_arbitration` | 0.82–0.88 | Claude tie-break (skor bandı 50–75, UPC/MPN yok) |
| `asin_reuse_rejected` | değişken | Aynı ASIN 3+ kez atandı (run-scoped red) |
| `image_siglip` | değişken | Legacy SigLIP (`FINDER_VISION_MATCH=true`) |
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
| `FINDER_IMAGE_CANDIDATES` | 3 | pHash / legacy görsel aday sayısı |
| `FINDER_MATCH_SCORE_THRESHOLD` | 80 | Multi-signal kabul eşiği (MPN=80 tek başına yeterli) |
| `FINDER_MATCH_MIN_GAP` | 10 | Top-2 skor farkı (belirsizlik reddi) |
| `FINDER_VISION_MATCH` | false | true → SigLIP legacy |
| `IMAGE_CHECK_MIN_TEXT` | 0.45 | Görsel gate alt sınır |
| `IMAGE_CHECK_MAX_TEXT` | 0.81 | Görsel gate üst sınır (üstü skip) |
| `FINDER_MATCH_CONCURRENCY` | 6 | Paralel match |
| `FINDER_CLAUDE_MATCH` | false | Claude title clean + (legacy) arbitration fallback |
| `FINDER_CLAUDE_ARBITRATION` | false | Claude son-çare tie-break (multi-signal sonrası) |
| `FINDER_CLAUDE_MAX_CALLS` | 20 | Tarama başına Claude arbitration bütçesi |
| `FINDER_CLAUDE_SCORE_MIN` / `MAX` | 50 / 75 | Arbitration skor bandı |
| `FINDER_CLAUDE_GAP_SOFT` | 8 | Üst bant soft gap (skor ≥70) |
| `FINDER_MISS_CACHE_TTL` | 172800 (48h) | Miss cache süresi (önerilen: 21600 / 6h) |
| `SERP_STREAM_MAX_BYTES` | 131072 (128 KB) | SERP stream cap |
| `SERP_FULL_MAX_BYTES` | 1048576 (1 MB) | Tam sayfa fallback cap |
| `SERP_PARSE_EVERY_BYTES` | 12000 | Stream parse aralığı |
| `FINDER_NO_PROXY_SERP_INTERVAL_SEC` | 2 | No-proxy SERP rate limit |
| `FINDER_CAPTCHA_ABORT_AFTER` | 10 | Captcha streak limiti |
| `SIGLIP_MODEL` | google/siglip-base-patch16-224 | Yalnızca `FINDER_VISION_MATCH=true` |
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
| `scraper/match_score.py` | Multi-signal skorlama (UPC/MPN/brand/pHash/title) |
| `scraper/claude_arbitration.py` | Claude son-çare arbitration + cache + ASIN reuse guard |
| `scraper/image_match.py` | Router: scoring (default) veya SigLIP legacy |
| `scraper/image_match_siglip.py` | Legacy SigLIP (`FINDER_VISION_MATCH=true`) |
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

### Multi-signal skorlama (`match_score.py`) — varsayılan

- **SigLIP varsayılan kapalı** (`FINDER_VISION_MATCH=false`)
- UPC (+100), MPN (+80), marka (+20), marka+title bonus (+40), pHash (+30, marka şart), title (+20)
- Eşik: `FINDER_MATCH_SCORE_THRESHOLD` (100); top-2 gap reddi: `FINDER_MATCH_MIN_GAP` (10)
- pHash görsel hatası → sinyal atlanır (aday reddedilmez)
- `score_to_confidence`: kabul edilen skorlar **≥0.80** confidence üretir

### Legacy görsel (`image_match_siglip.py`)

- `FINDER_VISION_MATCH=true` ile SigLIP geri alınabilir
- `image_siglip` match method; torch opsiyonel (`requirements-siglip.txt`)

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

*Son güncelleme: Haziran 2026 — Claude arbitration layer + multi-signal scoring (default).*
