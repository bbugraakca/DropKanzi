# Product Finder — Claude (Anthropic) Kullanımı

Bu doküman Dropkanzi Product Finder’da **Claude API’nin nerede, ne zaman ve ne kadar** kullanıldığını açıklar.

Claude bir “ana matcher” değildir. Ucuz yollar (regex, eBay detail, MPN/UPC, multi-signal skor) önce çalışır; Claude yalnızca **title temizleme** ve **son çare arbitration** için devreye girer.

**Kaynak kod:**

| Dosya | Rol |
|-------|-----|
| `scraper/amazon_matcher.py` | Match pipeline, title clean, lazy SERP akışı |
| `scraper/claude_arbitration.py` | Son çare tie-breaker, cache, bütçe, ASIN reuse guard |
| `scraper/match_cache.py` | Title clean Redis cache (`pf:tc:*`) |
| `scraper/main.py` | API summary: `claude_arbitration_calls`, `match_methods` |

Genel eşleştirme akışı için bkz. [`docs/MATCHING.md`](MATCHING.md).

---

## 1. Özet: Claude’un iki ayrı görevi

```
┌─────────────────────────────────────────────────────────────────┐
│  Her unique eBay title için match pipeline                       │
└────────────────────────────┬────────────────────────────────────┘
                             │
     ┌───────────────────────┼───────────────────────┐
     ▼                       ▼                       ▼
  Cache / ASIN          MPN / UPC              Amazon SERP
  eBay detail           multi-signal           (local queries)
  (API YOK)             (API YOK)              (API YOK)
                             │
                             │  SERP başarısız + lazy mode
                             ▼
                    ┌─────────────────┐
                    │ 1. TITLE CLEAN  │  ← Claude (opsiyonel, pahalı)
                    │    max_tokens≈180│
                    └────────┬────────┘
                             │  yeniden SERP
                             ▼
                    ┌─────────────────┐
                    │ Multi-signal    │  skor ≥ 80 → kabul
                    │ score ≥ 80?     │
                    └────────┬────────┘
                             │  hayır, skor 50–75 bandı
                             ▼
                    ┌─────────────────┐
                    │ 2. ARBITRATION  │  ← Claude (ucuz, max 20/scan)
                    │    max_tokens=20 │
                    └────────┬────────┘
                             │
                             ▼
                    text fallback / miss cache
```

| Görev | Env bayrağı | Tipik maliyet | Ne zaman |
|-------|-------------|---------------|----------|
| **Title clean** | `FINDER_CLAUDE_TITLE_CLEAN` | Orta–yüksek (title başına) | Local SERP eşleşmezse (`lazy`) veya her zaman (`always`) |
| **Arbitration** | `FINDER_CLAUDE_ARBITRATION` | Düşük (max 20 çağrı/scan) | Multi-signal skor 50–75, UPC/MPN yok, aday var |
| **Vision** | `FINDER_VISION_MATCH` | Çok yüksek (kapalı) | Varsayılan **kapalı** |

---

## 2. Ortam değişkenleri

`.env` örneği (önerilen — token dostu):

```env
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001

# Title clean: off | lazy | always
FINDER_CLAUDE_TITLE_CLEAN=lazy
FINDER_CLAUDE_TITLE_IMAGE=false

# Son çare tie-breaker (ucuz)
FINDER_CLAUDE_ARBITRATION=true
FINDER_CLAUDE_MAX_CALLS=20
FINDER_CLAUDE_SCORE_MIN=50
FINDER_CLAUDE_SCORE_MAX=75
FINDER_CLAUDE_GAP_SOFT=8
FINDER_CLAUDE_TIMEOUT_SEC=10
FINDER_CLAUDE_MAX_CONCURRENCY=4

# Legacy (artık title clean için kullanılmıyor; lazy fallback için)
FINDER_CLAUDE_MATCH=false

# Vision — varsayılan kapalı, token canavarı
FINDER_VISION_MATCH=false
```

### Bayrak açıklamaları

| Değişken | Varsayılan | Anlam |
|----------|------------|-------|
| `ANTHROPIC_API_KEY` | — | API anahtarı. Scraper container’da set olmalı. |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | Hızlı/ucuz model; arbitration + title clean için yeterli. |
| `FINDER_CLAUDE_TITLE_CLEAN` | `off` (veya legacy `MATCH=true` → `lazy`) | Title clean modu (aşağıda). |
| `FINDER_CLAUDE_TITLE_IMAGE` | `false` | `true` ise eBay görsel URL’si Claude’a gider → **çok pahalı** + rate limit. |
| `FINDER_CLAUDE_ARBITRATION` | `false` | Son çare arbitration açık/kapalı. |
| `FINDER_CLAUDE_MAX_CALLS` | `20` | Bir seller scan başına max arbitration API çağrısı. |
| `FINDER_CLAUDE_SCORE_MIN` / `MAX` | `50` / `75` | Arbitration skor bandı. |
| `FINDER_CLAUDE_GAP_SOFT` | `8` | Skor ≥70 iken top-2 farkı bu kadar ise arbitration atlanır. |
| `FINDER_CLAUDE_MAX_CONCURRENCY` | `4` | Tüm Claude çağrıları için paylaşılan semaphore (429 önleme). |
| `FINDER_CLAUDE_MATCH` | `false` | **Legacy.** `TITLE_CLEAN` set değilse ve `true` ise mod `lazy` olur. |
| `FINDER_VISION_MATCH` | `false` | Claude Vision + base64 görsel (ayrı, pahalı yol). |

---

## 3. Title clean (Görev 1)

### 3.1 Ne yapar?

eBay title’dan:

- `brand`
- `clean_title` (pazarlama gürültüsü temizlenmiş)
- `search_queries` (1–3 Amazon arama sorgusu)
- `asin_if_visible` (title’da ASIN varsa)

üretir ve Amazon SERP aramasını besler.

### 3.2 Üç mod: `off` / `lazy` / `always`

| Mod | Davranış | Token |
|-----|----------|-------|
| `off` | Claude hiç çağrılmaz; `_search_queries()` + `clean_query()` kullanılır | **Sıfır** |
| `lazy` | Önce **local** sorgularla SERP dener; eşleşme yoksa Claude title clean + ikinci SERP turu | **Düşük–orta** |
| `always` | Her title için önce Claude, sonra SERP (eski davranış) | **Çok yüksek** (~300k token/seller) |

**Önerilen:** `lazy` + `FINDER_CLAUDE_TITLE_IMAGE=false`

### 3.3 Lazy akış (kod)

`amazon_matcher.py` → `_match_listing_inner()`:

1. MPN/UPC / eBay detail / cache adımları biter.
2. `title_clean_mode != "always"` ise:
   - `local_queries = _search_queries(title)` ile SERP dener.
   - Başarılı eşleşme (≥80% confidence) → **Claude çağrılmaz**.
3. Hâlâ eşleşme yoksa ve mod `lazy` veya `always`:
   - `claude_clean_title()` çağrılır.
   - Claude’un `search_queries` ile SERP tekrarlanır.

### 3.4 Title clean API çağrısı

```
Model:     ANTHROPIC_MODEL (Haiku)
max_tokens: 180
Girdi:     kısa text prompt (+ opsiyonel görsel, varsayılan KAPALI)
Çıktı:     JSON { brand, clean_title, search_queries, asin_if_visible }
```

Örnek prompt (kısaltılmış):

```
eBay: "Samsung Galaxy S24 Case Black NEW Fast Ship"
JSON only: {"brand":null,"clean_title":"...","search_queries":["q1","q2"],"asin_if_visible":null}
```

### 3.5 Title clean cache

Redis key: `pf:tc:{sha256(title)[:24]}`  
TTL: **7 gün**

Aynı normalize title tekrar taranırsa API’ye gitmez.

### 3.6 `claude_asin_extract`

Title clean yanıtında `asin_if_visible` geçerli ASIN ise:

- `match_method`: `claude_asin_extract`
- `match_confidence`: **0.98**
- SERP atlanır (erken çıkış)

---

## 4. Arbitration (Görev 2) — son çare tie-breaker

### 4.1 Ne yapar?

Amazon SERP’ten adaylar geldi, multi-signal skorlama **80 eşiğini geçemedi** ama skor **50–75** arasında kaldı. Claude’a en fazla **3 aday** gönderilir; doğru ASIN veya `NONE` döner.

**Claude burada matcher değil** — skorlama zaten yapıldı; Claude yalnızca belirsiz bandda karar verir.

### 4.2 Ne zaman çağrılır? (eligibility)

Tümü sağlanmalı:

| # | Koşul |
|---|--------|
| 1 | `FINDER_CLAUDE_ARBITRATION=true` |
| 2 | `ANTHROPIC_API_KEY` set |
| 3 | En az 1 ranked aday |
| 4 | En iyi skor **50 ≤ score < 75** |
| 5 | En iyi adayda **UPC veya MPN sinyali yok** (ucuz yol yeterli olmalı) |
| 6 | Bu scan’de `claude_calls < FINDER_CLAUDE_MAX_CALLS` |
| 7 | **Soft gap:** skor ≥70 **ve** (top1 − top2) ≥ `GAP_SOFT` → atlanır (üst bantta net ayrışma var) |

Skor 50–69 arasında gap kontrolü **yok** — recall korunur.

### 4.3 Ne zaman çağrılmaz?

- SERP `candidates=0` (Amazon bot duvarı) → arbitration’a gidecek aday yok
- Skor ≥80 (zaten `score_match` ile kabul)
- Skor <50 veya ≥75
- UPC/MPN sinyali var
- Bütçe doldu (`MAX_CALLS`)
- Redis cache’te taze MATCH veya NONE var

### 4.4 Prompt

**System:**
```
You match an eBay product to the correct Amazon ASIN.
Reply ONLY with the matching ASIN (10 chars) or NONE. No explanation.
```

**User:**
```
EBAY_TITLE: <normalize edilmiş title>
CANDIDATES:
1. ASIN: B0XXXXXXXX | TITLE: ...
2. ASIN: B0XXXXXXXX | TITLE: ...
3. ASIN: B0XXXXXXXX | TITLE: ...
```

```
Model:        ANTHROPIC_MODEL
max_tokens:   20
temperature:  0
timeout:      FINDER_CLAUDE_TIMEOUT_SEC (10s)
```

### 4.5 Yanıt işleme

| Yanıt | Sonuç |
|-------|--------|
| `NONE` | Eşleşme yok; NONE cache 24h |
| Geçerli ASIN **aday listesinde** | `match_method: claude_arbitration`, confidence **0.82–0.88** |
| ASIN adaylarda yok | Red (hallucination guard) |
| API hatası | `no_match`, scan devam eder (fail-safe) |

**Confidence formülü:**

```
conf = clamp(0.80 + (best_score - 50) / 250, 0.82, 0.88)
```

Referans sıralama: UPC ≈ 0.99, MPN ≈ 0.92, Claude arbitration 0.82–0.88, düşük text skoru daha düşük.

### 4.6 Arbitration cache (Redis)

Bileşik key (yanlış cache hit önleme):

```
sha1(normalized_title | brand | mpn | seller_id) → claude_match:{digest}
```

| Sonuç | TTL |
|-------|-----|
| MATCH | 7 gün |
| NONE | 24 saat |

### 4.7 ASIN reuse guard (yalnızca arbitration)

**Run-scoped:** Her `match_listings_batch()` başında sıfırlanır.

Aynı ASIN aynı scan’de **3. kez** atanmaya çalışılırsa reddedilir (`asin_reuse_rejected`). Bu koruma **yalnızca `claude_arbitration`** eşleşmelerine uygulanır; normal `search` / `score_match` eşleşmelerini etkilemez.

Batch sonunda ek kontrol: aynı ASIN **5+** listing’de `claude_arbitration` ile görünürse o eşleşmeler silinir.

### 4.8 Bütçe ve loglar

Her arbitration çağrısında:

```
claude_call title='...' score=65 gap=12 candidates=['B0...'] n=3
```

`n` = bu scan’deki kaçıncı Claude arbitration çağrısı.

Bütçe dolunca:

```
Claude call budget reached n=20
```

API summary’de: `claude_arbitration_calls`

---

## 5. Claude Vision (kapalı — Görev 3)

`FINDER_VISION_MATCH=true` + API key ile:

1. eBay görseli indirilir → base64
2. Claude’a görsel + title gönderilir (`max_tokens=220`)
3. Dönen `amazon_search_query` ile SERP denenir

**Varsayılan kapalı.** Token maliyeti çok yüksek; SigLIP legacy yolu ayrı (`FINDER_VISION_MATCH` + `image_match_siglip.py`).

---

## 6. Pipeline sırası (Claude dahil tam resim)

Her **unique eBay title** için (`amazon_matcher.py` → `_match_listing_inner`):

| Sıra | Adım | Claude? |
|------|------|---------|
| 0 | Redis match / miss cache | Hayır |
| 1 | Pre-extracted ASIN | Hayır |
| 2 | ASIN title regex | Hayır |
| 3 | eBay item detail sayfası | Hayır |
| 4 | MPN / UPC Amazon araması | Hayır |
| 5a | Local `_search_queries` → SERP → multi-signal | Hayır |
| 5b | Title clean (`lazy`/`always`) → SERP → multi-signal | **Evet (5b title)** |
| 6 | Skor ≥80 → kabul | Hayır |
| 7 | Skor 50–75 → **arbitration** | **Evet (7)** |
| 8 | Text-only fallback (≥0.79) | Hayır |
| 9 | Vision (kapalı) | Evet (opsiyonel) |
| 10 | Miss cache yaz | Hayır |

`_best_from_candidates()` içinde multi-signal sonrası:

```python
score_candidates()           # ≥80 → return
score_candidates_ranked()    # arbitration için sıralı liste
try_claude_arbitration()     # band 50–75
text_best if score ≥ 0.79    # son çare
```

---

## 7. Token maliyeti — ne pahalı, ne ucuz?

### Pahalı (kaçının)

| Davranış | Tahmini etki |
|----------|----------------|
| `FINDER_CLAUDE_TITLE_CLEAN=always` | Her unique title → 1 API çağrısı (~500–2000 token/girdi) |
| `FINDER_CLAUDE_TITLE_IMAGE=true` | Anthropic eBay görselini fetch eder → **URL Content Fetching** + devasa girdi token |
| `FINDER_VISION_MATCH=true` | Base64 görsel her title |
| Yüksek `FINDER_MATCH_CONCURRENCY` + title clean | Paralel API → 429 rate limit |

### Ucuz (önerilen profil)

```env
FINDER_CLAUDE_TITLE_CLEAN=lazy      # çoğu title local SERP ile biter
FINDER_CLAUDE_TITLE_IMAGE=false     # görsel asla gitmez
FINDER_CLAUDE_ARBITRATION=true      # max 20 × ~100 token
FINDER_CLAUDE_MAX_CONCURRENCY=4
FINDER_VISION_MATCH=false
```

**Kabaca bir seller scan (173 unique title):**

| Profil | Tahmini Claude çağrısı | Tahmini token |
|--------|------------------------|---------------|
| `always` + görsel | ~173 title clean | **200k–500k+** |
| `lazy` (önerilen) | ~20–60 title clean (SERP fail olanlar) + ≤20 arbitration | **5k–40k** |
| `off` + arbitration only | ≤20 arbitration | **<2k** |

Title clean Redis cache tekrar taramalarda maliyeti sıfıra yaklaştırır.

---

## 8. UI / API’de Claude görünür mü?

**Hayır** — Stage breakdown yalnızca **proxy bandwidth** (eBay, Amazon SERP, fiyat) gösterir. Claude API çağrıları proxy sayacına girmez.

Claude etkisini görmek için:

| Kaynak | Alan |
|--------|------|
| Analyze API `summary` | `claude_arbitration_calls`, `match_methods.claude_arbitration` |
| Scraper log | `claude_call`, `Claude title clean failed`, `claude_failed` |
| Listing | `match_method: claude_arbitration` veya `claude_asin_extract` |

---

## 9. `match_method` değerleri (Claude ile ilgili)

| `match_method` | Confidence | Açıklama |
|----------------|------------|----------|
| `claude_asin_extract` | 0.98 | Title clean ASIN çıkardı |
| `claude_arbitration` | 0.82–0.88 | Son çare tie-break |
| `asin_reuse_rejected` | — | Arbitration ASIN’i run guard tarafından reddedildi |
| `image_vision` | değişken | Vision açıksa |

---

## 10. Sık sorunlar

### “Claude çalışmıyor gibi”

1. **SERP candidates=0** → arbitration için aday yok (Amazon `bm-verify` bot duvarı). Önce SERP/proxy sorununu çöz.
2. **`FINDER_CLAUDE_ARBITRATION=false`** → arbitration kapalı.
3. **Skor bandı dışı** → 80+ zaten kabul; <50 veya ≥75 arbitration yok.
4. **UPC/MPN sinyali** → arbitration bilerek atlanır.

### “Token çok gidiyor”

1. `FINDER_CLAUDE_TITLE_CLEAN=always` mı? → `lazy` veya `off` yap.
2. `FINDER_CLAUDE_TITLE_IMAGE=true` mı? → **false** yap.
3. Eski `FINDER_CLAUDE_MATCH=true` + görsel URL → rate limit + 300k+ token/scan.
4. Anthropic Console’da “URL Content Fetching” yüksekse → görsel URL title clean’e gidiyordur.

### “429 rate limit”

- `FINDER_CLAUDE_MAX_CONCURRENCY=4` (veya daha düşük)
- `FINDER_MATCH_CONCURRENCY` çok yüksekse title clean paralel patlar → düşür veya `TITLE_CLEAN=off`

---

## 11. Deploy / doğrulama

```powershell
docker compose up -d scraper --force-recreate
```

Container içinde:

```powershell
docker compose exec scraper printenv FINDER_CLAUDE_TITLE_CLEAN FINDER_CLAUDE_ARBITRATION FINDER_CLAUDE_TITLE_IMAGE
```

Fresh scan sonrası log:

```powershell
docker compose logs scraper --tail 100 | Select-String "claude_call|title clean|match_method_distribution"
```

Beklenen (lazy + arbitration):

- Çoğu title için **hiç** `Claude title clean` yok (local SERP yeterli)
- Belirsiz bandda birkaç `claude_call ... n=1..20`
- `match_method_distribution` içinde `claude_arbitration` > 0 (koşullar uygunsa)

---

## 12. Önerilen production profili

```env
FINDER_CLAUDE_TITLE_CLEAN=lazy
FINDER_CLAUDE_TITLE_IMAGE=false
FINDER_CLAUDE_ARBITRATION=true
FINDER_CLAUDE_MAX_CALLS=20
FINDER_CLAUDE_MAX_CONCURRENCY=4
FINDER_VISION_MATCH=false
FINDER_CLAUDE_MATCH=false
```

Bu profil: **iyi eşleşme + düşük token**. Title clean yalnızca local SERP yetmediğinde; arbitration yalnızca gri bantta; görsel hiçbir zaman Claude’a gitmez.

---

## 12. Merkezi API kapısı (`send_to_claude`)

**Kural:** Tüm Anthropic çağrıları yalnızca `scraper/claude_client.py` → `send_to_claude()` üzerinden geçer.  
Doğrudan `client.messages.create()` veya `Anthropic()` kullanımı yasaktır.

Bu kapı şunları garanti eder:

- `FINDER_CLAUDE_MAX_CONCURRENCY` semaphore (429 önleme)
- Vision guard: `FINDER_VISION_MATCH` / `FINDER_CLAUDE_TITLE_IMAGE` kapalıysa görsel bloklanır
- `purpose`: `title_clean` | `arbitration` | `vision`

### `title_clean_success`

Title clean yanıtında `search_queries` boş liste ise başarı **sayılmaz** (`title_clean_success=false`).  
Lazy modda ikinci SERP turunda başarılı title clean varsa arbitration atlanır; boş query ile arbitration şansı korunur.

### Tek aday gap düzeltmesi

Tek SERP adayında `top2 = top1` → `gap = 0`. Üst bantta yanlış “net ayrışma” skip’i olmaz.

---

*Son güncelleme: Haziran 2026 — hardening v3 (send_to_claude gateway, title_clean_success, gap fix).*
