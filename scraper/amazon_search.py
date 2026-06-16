"""
Match an eBay listing to an Amazon ASIN WITHOUT any LLM.

Strategy:
  1. If the listing already has an ASIN (from the eBay description/content), keep it
     (confidence 1.0).
  2. Otherwise search Amazon for a cleaned title, pull several candidate results and
     score each by title word-overlap AND product-image similarity (perceptual dHash).
     The best combined score wins; weak matches are dropped to keep result quality high.

Amazon search needs the existing DataImpulse proxy (same as the AOD scraper).
Image downloads (eBay/Amazon CDNs) go direct, no proxy needed.
"""

import asyncio
import contextvars
import json
import logging
import os
import re
import time

from curl_cffi.requests import AsyncSession
from parsel import Selector

from proxy import get_proxy_url
from image_match import image_match as siglip_match
from asin_util import is_plausible_asin
import proxy_meter
import match_cache

logger = logging.getLogger("pricehawk.amazon_search")

# Scoring weights / thresholds for the staged pipeline:
MIN_MATCH_CONFIDENCE = 0.80   # reject and hide anything below 80%
_MIN_MATCH_CONFIDENCE = MIN_MATCH_CONFIDENCE
_CONTENT_WEIGHT = 0.45
_IMG_WEIGHT = 0.55
_MIN_CONTENT = 0.35       # gate before image scoring
_STRONG_CONTENT = 0.76      # text-only acceptance floor (no image)
_MIN_COMBINED = _MIN_MATCH_CONFIDENCE
_MIN_IMAGE_ALONE = 0.62     # weak text needs decent visual match
_MIN_IMAGE_WITH_TEXT = 0.48 # reject obvious wrong-product photos
_MAX_CANDIDATES = int(os.getenv("FINDER_SERP_CANDIDATES", "8"))
FINDER_MAX_SERP_QUERIES = int(os.getenv("FINDER_MAX_SERP_QUERIES", "2"))
_SERP_TIMEOUT = 18
_SERP_STREAM_MAX_BYTES = int(os.environ.get("SERP_STREAM_MAX_BYTES", "307200"))
_SERP_FULL_FALLBACK_MIN_HTML = 280000
_SERP_FULL_MAX_BYTES = int(os.getenv("SERP_FULL_MAX_BYTES", "1048576"))
_SERP_PARSE_EVERY = int(os.getenv("SERP_PARSE_EVERY_BYTES", "12000"))
_CAPTCHA_ABORT_AFTER = int(os.getenv("FINDER_CAPTCHA_ABORT_AFTER", "10"))
_captcha_streak = 0
_AMAZON_SERP_GATE = asyncio.Semaphore(int(os.getenv("FINDER_SERP_CONCURRENCY", "8")))
_PROXY_SEMAPHORE = asyncio.Semaphore(int(os.environ.get("FINDER_PROXY_CONCURRENCY", "2")))
_NO_PROXY_SERP_LOCK = asyncio.Lock()
_NO_PROXY_STATE = {"last_at": 0.0}
_NO_PROXY_SERP_INTERVAL = float(os.getenv("FINDER_NO_PROXY_SERP_INTERVAL_SEC", "2"))
# false = Amazon SERP always via residential proxy (never host IP)
_SERP_USE_PROXY = os.getenv("FINDER_SERP_USE_PROXY", "true").lower() in ("1", "true", "yes")

_serp_meter: contextvars.ContextVar[dict | None] = contextvars.ContextVar(
    "serp_meter", default=None
)


def reset_serp_meter() -> None:
    _serp_meter.set(
        {
            "lookups": 0,
            "http_requests": 0,
            "proxy_requests": 0,
            "direct_requests": 0,
            "direct_bytes": 0,
        }
    )


def summarize_serp_meter() -> dict:
    meter = _serp_meter.get()
    if not meter:
        meter = {
            "lookups": 0,
            "http_requests": 0,
            "proxy_requests": 0,
            "direct_requests": 0,
            "direct_bytes": 0,
        }
    return {
        "serp_lookups": meter["lookups"],
        "serp_http_requests": meter["http_requests"],
        "serp_proxy_requests": meter["proxy_requests"],
        "serp_direct_requests": meter["direct_requests"],
        "serp_direct_bytes": meter["direct_bytes"],
    }


def _note_serp_http(use_proxy: bool, nbytes: int) -> None:
    meter = _serp_meter.get()
    if not meter:
        return
    meter["http_requests"] += 1
    if use_proxy:
        meter["proxy_requests"] += 1
    else:
        meter["direct_requests"] += 1
        meter["direct_bytes"] += max(0, int(nbytes))


def _note_serp_lookup() -> None:
    meter = _serp_meter.get()
    if meter:
        meter["lookups"] += 1


def reset_captcha_streak() -> None:
    global _captcha_streak
    _captcha_streak = 0


def captcha_abort() -> bool:
    return _captcha_streak >= _CAPTCHA_ABORT_AFTER


def _note_captcha() -> int:
    global _captcha_streak
    _captcha_streak += 1
    return _captcha_streak


def _note_serp_ok() -> None:
    global _captcha_streak
    _captcha_streak = 0


_PER_PRODUCT_TIMEOUT = 28

_STOPWORDS = {
    "the", "a", "an", "for", "with", "and", "or", "of", "to", "in", "on", "by",
    "new", "set", "pack", "lot", "pcs", "pc", "piece", "pieces", "size", "color",
    "colour", "free", "shipping", "us", "uk", "genuine", "oem", "original",
}

AMAZON_SEARCH_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.amazon.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
}

_JUNK_RE = re.compile(
    r"\b(new|brand new|free ship(?:ping)?|fast(?: ship(?:ping)?)?|us seller|"
    r"oem|authentic|sealed|open box|ships? free|same day|free returns)\b",
    re.IGNORECASE,
)
_QTY_RE = re.compile(r"\b(?:lot|set|pack) of \d+\b", re.IGNORECASE)
_ASIN_RE = re.compile(r'data-asin="([A-Z0-9]{10})"')
_ACCESSORY_RE = re.compile(
    r"\b(case for|cover for|compatible with|replacement for|fits for|skin for)\b",
    re.IGNORECASE,
)
_PRICE_NUM_RE = re.compile(r"([\d,]+\.?\d*)")


def _parse_serp_price(node) -> float | None:
    """Buy-box style price from an Amazon search result card (same page as title/image)."""
    for sel in (
        "span.a-price span.a-offscreen::text",
        "span.a-price .a-offscreen::text",
        "span.a-color-price::text",
    ):
        raw = (node.css(sel).get() or "").strip()
        if not raw:
            continue
        m = _PRICE_NUM_RE.search(raw.replace(",", "").replace("$", ""))
        if m:
            try:
                val = float(m.group(1))
                if 0.5 < val < 50_000:
                    return round(val, 2)
            except ValueError:
                pass
    whole = (node.css("span.a-price-whole::text").get() or "").strip().replace(",", "")
    frac = (node.css("span.a-price-fraction::text").get() or "").strip()
    if whole:
        try:
            val = float(f"{whole}.{frac}" if frac else whole)
            if 0.5 < val < 50_000:
                return round(val, 2)
        except ValueError:
            pass
    return None


def clean_query(title: str, brand: str | None = None) -> str:
    query = f"{brand} {title}" if brand else title
    query = _QTY_RE.sub(" ", query)
    query = _JUNK_RE.sub(" ", query)
    query = re.sub(r"[^\w\s-]", " ", query)
    return " ".join(query.split())[:120]


def _search_queries(title: str) -> list[str]:
    """Build up to 3 Amazon search strings: full title, model-focused, short anchor."""
    primary = clean_query(title)
    if not primary:
        return []

    tokens = _tokens(primary)
    if len(tokens) <= 3:
        return [primary]

    queries: list[str] = [primary]
    seen = {primary.lower()}

    # Model / size tokens (e.g. "1tb", "b450", "15pro", "64oz") anchor the product.
    modelish = [t for t in tokens if any(c.isdigit() for c in t)]
    head = tokens[:2]
    if modelish:
        focused = " ".join(dict.fromkeys(head + modelish))[:80]
        if focused.lower() not in seen and len(focused.split()) >= 2:
            queries.append(focused)
            seen.add(focused.lower())
        short = " ".join(dict.fromkeys(head + [max(modelish, key=len)]))[:60]
        if short.lower() not in seen and len(short.split()) >= 2:
            queries.append(short)
            seen.add(short.lower())

    return queries[:3]


def _proxies() -> dict | None:
    url = get_proxy_url()
    return {"http": url, "https": url} if url else None


def _serp_is_blocked(text: str) -> bool:
    low = text.lower()
    return (
        "captcha" in low
        or "automated access" in low
        or "type the characters you see" in low
        or "sorry, we just need to make sure you're not a robot" in low
    )


def _serp_has_parseable_html(text: str) -> bool:
    if len(text) < 6000:
        return False
    if _serp_is_blocked(text):
        return False
    low = text.lower()
    return (
        'data-asin="' in text
        or "data-asin='" in text
        or "s-result-item" in low
        or '"/dp/' in text
        or '"asin":"' in text
    )


async def _fetch_serp_html(
    session: AsyncSession,
    params: dict,
    *,
    max_bytes: int | None = None,
    use_proxy: bool = True,
    target_candidates: int | None = None,
) -> tuple[str | None, int, int]:
    """Stream Amazon SERP; count proxy bytes only when use_proxy=True."""
    cap = max_bytes if max_bytes is not None else _SERP_STREAM_MAX_BYTES
    target = target_candidates if target_candidates is not None else _MAX_CANDIDATES
    buf = bytearray()
    bytes_read = 0
    last_parse_at = 0
    status_code = 0
    proxies = _proxies() if use_proxy else None

    try:
        resp = await session.get(
            "https://www.amazon.com/s",
            params=params,
            headers=AMAZON_SEARCH_HEADERS,
            proxies=proxies,
            timeout=_SERP_TIMEOUT,
            impersonate="chrome120",
            stream=True,
        )
        status_code = int(resp.status_code or 0)
        try:
            if status_code >= 400:
                return None, bytes_read, status_code

            async for chunk in resp.aiter_content(chunk_size=4096):
                if not chunk:
                    continue
                bytes_read += len(chunk)
                buf.extend(chunk)

                text = bytes(buf).decode("utf-8", errors="ignore")

                if bytes_read - last_parse_at >= _SERP_PARSE_EVERY:
                    last_parse_at = bytes_read
                    if _serp_has_parseable_html(text):
                        parsed = _parse_serp_candidates(text, target)
                        if len(parsed) >= min(3, target):
                            if use_proxy:
                                proxy_meter.add(bytes_read)
                            logger.info("[SERP HTML PREVIEW] %s", text[:800])
                            _note_serp_http(use_proxy, bytes_read)
                            return text, bytes_read, status_code

                if bytes_read >= cap:
                    break
        finally:
            try:
                await resp.aclose()
            except Exception:
                pass

        if not buf:
            return None, bytes_read, status_code

        text = bytes(buf).decode("utf-8", errors="ignore")
        if use_proxy:
            proxy_meter.add(bytes_read)
        if text:
            logger.info("[SERP HTML PREVIEW] %s", text[:800])
        _note_serp_http(use_proxy, bytes_read)
        return text, bytes_read, status_code
    except Exception as exc:  # noqa: BLE001
        logger.warning("SERP stream failed (proxy=%s): %s", use_proxy, exc)
        if use_proxy and bytes_read > 0:
            proxy_meter.add(bytes_read)
        return None, bytes_read, status_code


async def _fetch_serp_html_full(
    session: AsyncSession,
    params: dict,
    *,
    use_proxy: bool = True,
) -> tuple[str | None, int, int]:
    """Non-streaming SERP fetch when the stream cap cuts before product cards."""
    proxies = _proxies() if use_proxy else None
    bytes_read = 0
    status_code = 0
    try:
        resp = await session.get(
            "https://www.amazon.com/s",
            params=params,
            headers=AMAZON_SEARCH_HEADERS,
            proxies=proxies,
            timeout=max(_SERP_TIMEOUT, 25),
            impersonate="chrome120",
            stream=False,
        )
        status_code = int(resp.status_code or 0)
        if status_code >= 400:
            return None, 0, status_code
        raw = (resp.text or "").encode("utf-8", errors="ignore")
        if len(raw) > _SERP_FULL_MAX_BYTES:
            raw = raw[:_SERP_FULL_MAX_BYTES]
        bytes_read = len(raw)
        if use_proxy:
            proxy_meter.add(bytes_read)
        html = raw.decode("utf-8", errors="ignore")
        first_asin_pos = html.find('data-asin="B')
        logger.info(
            "[SERP POSITION] html_len=%d first_asin_pos=%d",
            len(html),
            first_asin_pos,
        )
        _note_serp_http(use_proxy, bytes_read)
        return html, bytes_read, status_code
    except Exception as exc:  # noqa: BLE001
        logger.warning("SERP full fetch failed (proxy=%s): %s", use_proxy, exc)
        if use_proxy and bytes_read > 0:
            proxy_meter.add(bytes_read)
        return None, bytes_read, status_code


def _extract_title_near_asin(html: str, asin: str) -> str:
    best = ""
    needle = f'data-asin="{asin}"'
    pos = 0
    while True:
        idx = html.find(needle, pos)
        if idx < 0:
            idx = html.find(f"data-asin='{asin}'", pos)
        if idx < 0:
            break
        window = html[idx : idx + 4500]
        for pat in (
            r"<h2[^>]*>.*?<span[^>]*>([^<]{8,})</span>",
            r"<span[^>]*class=\"[^\"]*a-text-normal[^\"]*\"[^>]*>([^<]{8,})</span>",
            r'alt="([^"]{10,200})"',
        ):
            m = re.search(pat, window, re.DOTALL | re.IGNORECASE)
            if m:
                title = re.sub(r"\s+", " ", m.group(1)).strip()
                if len(title) > len(best):
                    best = title
        pos = idx + len(needle)
    return best


def _parse_serp_json_candidates(text: str, max_candidates: int, seen: set[str]) -> list[dict]:
    candidates: list[dict] = []
    patterns = (
        r'"title"\s*:\s*"(?P<title>(?:\\.|[^"\\]){8,240})"\s*,\s*"asin"\s*:\s*"(?P<asin>B[A-Z0-9]{9})"',
        r'"asin"\s*:\s*"(?P<asin>B[A-Z0-9]{9})"\s*,\s*"title"\s*:\s*"(?P<title>(?:\\.|[^"\\]){8,240})"',
    )
    for pat in patterns:
        for m in re.finditer(pat, text):
            asin = m.group("asin")
            if asin in seen or not is_plausible_asin(asin):
                continue
            try:
                title = json.loads(f'"{m.group("title")}"')
            except json.JSONDecodeError:
                title = m.group("title")
            title = re.sub(r"\s+", " ", title).strip()
            if len(title) < 8:
                continue
            seen.add(asin)
            candidates.append({"asin": asin, "title": title, "image": "", "price": None})
            if len(candidates) >= max_candidates:
                return candidates
    return candidates


def _parse_serp_regex_candidates(text: str, max_candidates: int, seen: set[str]) -> list[dict]:
    candidates: list[dict] = []
    for pat in (
        r'data-asin="(B[A-Z0-9]{9})"',
        r"data-asin='(B[A-Z0-9]{9})'",
        r'data-asin=\\"(B[A-Z0-9]{9})\\"',
    ):
        for asin in re.findall(pat, text):
            if asin in seen or not is_plausible_asin(asin):
                continue
            title = _extract_title_near_asin(text, asin)
            if len(title) < 8:
                continue
            seen.add(asin)
            candidates.append({"asin": asin, "title": title, "image": "", "price": None})
            if len(candidates) >= max_candidates:
                return candidates
    return candidates


def _tokens(text: str) -> list[str]:
    return [
        w
        for w in re.findall(r"[a-z0-9]+", text.lower())
        if len(w) > 1 and w not in _STOPWORDS
    ]


def _bigram_overlap(q_tokens: list[str], t_tokens: list[str]) -> float:
    if len(q_tokens) < 2:
        return 0.0
    q_bigrams = {f"{q_tokens[i]} {q_tokens[i+1]}" for i in range(len(q_tokens) - 1)}
    t_bigrams = {f"{t_tokens[i]} {t_tokens[i+1]}" for i in range(len(t_tokens) - 1)}
    if not q_bigrams:
        return 0.0
    return len(q_bigrams & t_bigrams) / len(q_bigrams)


def _content_score(query: str, title: str) -> float:
    """Score how well an Amazon candidate matches the eBay listing text."""
    q_tokens = _tokens(query)
    t_tokens = _tokens(title)
    q, t = set(q_tokens), set(t_tokens)
    if not q:
        return 0.0

    inter = q & t
    recall = len(inter) / len(q)
    precision = len(inter) / len(t) if t else 0.0
    f1 = (2 * recall * precision / (recall + precision)) if (recall + precision) > 0 else 0.0

    q_models = {w for w in q if any(c.isdigit() for c in w)}
    model_hit = (len(q_models & t) / len(q_models)) if q_models else 1.0

    bigram = _bigram_overlap(q_tokens, t_tokens)

    score = 0.40 * f1 + 0.25 * recall + 0.20 * model_hit + 0.15 * bigram

    # Penalise accessory listings when the eBay title isn't an accessory.
    if _ACCESSORY_RE.search(title) and not _ACCESSORY_RE.search(query):
        score *= 0.45

    # First meaningful token is often the brand — penalise if missing on Amazon.
    if q_tokens and t_tokens and len(q_tokens[0]) >= 4:
        lead = q_tokens[:2]
        if not any(tok in t for tok in lead):
            score *= 0.62

    # Penalise Amazon titles with many extra tokens (often wrong variant/model).
    extra = t - q
    if len(extra) > max(4, len(q) * 0.55):
        score *= 0.72

    # Model/size tokens in the eBay title must appear on Amazon when present.
    if q_models and model_hit < 0.5:
        score *= 0.35

    return round(min(score, 1.0), 3)


async def fetch_serp(
    sess: AsyncSession,
    query: str,
    *,
    max_candidates: int = _MAX_CANDIDATES,
    use_proxy: bool = False,
) -> list[dict]:
    """Fetch Amazon SERP for one query; returns parsed product candidates."""
    if not query:
        return []

    params = {"k": query, "ref": "sr_pg_1", "language": "en_US"}

    async def _run_fetch() -> list[dict]:
        status_code = 0
        html = ""
        for attempt in range(2 if use_proxy else 1):
            try:
                if not use_proxy:
                    async with _NO_PROXY_SERP_LOCK:
                        wait = _NO_PROXY_SERP_INTERVAL - (
                            time.monotonic() - _NO_PROXY_STATE["last_at"]
                        )
                        if wait > 0:
                            await asyncio.sleep(wait)
                        _NO_PROXY_STATE["last_at"] = time.monotonic()

                async with _AMAZON_SERP_GATE:
                    text, _nbytes, status_code = await _fetch_serp_html(
                        sess,
                        params,
                        use_proxy=use_proxy,
                        target_candidates=max_candidates,
                    )

                html = text or ""
                if not html:
                    if use_proxy and attempt == 0:
                        await asyncio.sleep(1)
                        continue
                    candidates: list[dict] = []
                    logger.info(
                        "[SERP] use_proxy=%s query='%s' status=%s candidates=%d html_len=%d",
                        use_proxy,
                        query[:50],
                        status_code,
                        0,
                        0,
                    )
                    return candidates

                if _serp_is_blocked(html):
                    logger.info("[SERP BLOCKED] captcha detected")
                    _note_captcha()
                    if use_proxy and attempt == 0:
                        await asyncio.sleep(2)
                        continue
                    logger.info(
                        "[SERP] use_proxy=%s query='%s' status=%s candidates=%d html_len=%d blocked=1",
                        use_proxy,
                        query[:50],
                        status_code,
                        0,
                        len(html),
                    )
                    return []

                logger.debug("[SERP DEBUG] html_preview: %s", html[:1000])
                all_asins = re.findall(r'data-asin="([A-Z0-9]{10})"', html)
                logger.debug(
                    "[SERP DEBUG] data-asin count: %d asins: %s",
                    len(all_asins),
                    all_asins[:5],
                )
                alt1 = re.findall(r'"asin":"([A-Z0-9]{10})"', html)
                alt2 = re.findall(r'data-asin=\\"([A-Z0-9]{10})\\"', html)
                logger.debug("[SERP DEBUG] alt1=%s alt2=%s", alt1[:3], alt2[:3])

                candidates = _parse_serp_candidates(html, max_candidates)
                min_needed = min(3, max_candidates)
                if len(candidates) < min_needed:
                    if len(html) < _SERP_FULL_FALLBACK_MIN_HTML:
                        logger.info(
                            "[SERP] stream parse insufficient (%d), trying full page fetch: %s",
                            len(candidates),
                            query[:50],
                        )
                        full_html, _full_bytes, full_status = await _fetch_serp_html_full(
                            sess,
                            params,
                            use_proxy=use_proxy,
                        )
                        if full_html and not _serp_is_blocked(full_html):
                            html = full_html
                            status_code = full_status or status_code
                            full_candidates = _parse_serp_candidates(html, max_candidates)
                            if len(full_candidates) > len(candidates):
                                candidates = full_candidates
                    elif len(candidates) == 0:
                        logger.info(
                            "[SERP] 300KB fetched, still 0 candidates — no results for query"
                        )

                if candidates:
                    _note_serp_ok()
                elif not _serp_is_blocked(html):
                    logger.info("[SERP SHELL] real page but no products")
                    if len(html) > 30000:
                        asins_in_html = re.findall(r'data-asin="([A-Z0-9]{10})"', html)
                        shell = "s-result-item" not in html.lower() and not asins_in_html
                        logger.warning(
                            "Amazon SERP returned HTML but 0 candidates for %r (shell=%s html_len=%d)",
                            query[:50],
                            shell,
                            len(html),
                        )

                logger.info(
                    "[SERP] use_proxy=%s query='%s' status=%s candidates=%d html_len=%d",
                    use_proxy,
                    query[:50],
                    status_code,
                    len(candidates),
                    len(html),
                )
                return candidates
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "Amazon search failed for %r (proxy=%s attempt %s): %s",
                    query[:40],
                    use_proxy,
                    attempt + 1,
                    exc,
                )
                if use_proxy and attempt == 0:
                    await asyncio.sleep(1)
        return []

    if use_proxy:
        async with _PROXY_SEMAPHORE:
            out = await _run_fetch()
    else:
        out = await _run_fetch()
    _note_serp_lookup()
    return out


async def search_amazon_candidates(
    query: str,
    max_candidates: int = _MAX_CANDIDATES,
    serp_cache: dict[str, list[dict]] | None = None,
    session: AsyncSession | None = None,
    *,
    prefer_no_proxy: bool | None = None,
) -> tuple[list[dict], bool]:
    """Return organic Amazon results from search page. Second value: proxy_used."""
    if prefer_no_proxy is None:
        prefer_no_proxy = not _SERP_USE_PROXY
    if not query:
        return [], False
    if captcha_abort():
        logger.warning("Amazon SERP skipped — captcha streak limit reached")
        return [], False

    cache_key = query.lower().strip()
    if serp_cache is not None and cache_key in serp_cache:
        cached = serp_cache[cache_key]
        if cached:
            return cached, False

    async def _run(sess: AsyncSession) -> tuple[list[dict], bool]:
        proxy_used = False
        if prefer_no_proxy:
            candidates = await fetch_serp(
                sess, query, max_candidates=max_candidates, use_proxy=False
            )
            if candidates:
                if serp_cache is not None:
                    serp_cache[cache_key] = candidates
                return candidates, False
            logger.info(
                "[SERP] no-proxy empty, retrying with proxy: %s",
                query[:50],
            )
        candidates = await fetch_serp(
            sess, query, max_candidates=max_candidates, use_proxy=True
        )
        proxy_used = True
        if serp_cache is not None and candidates:
            serp_cache[cache_key] = candidates
        return candidates, proxy_used

    if session is not None:
        return await _run(session)
    async with AsyncSession() as sess:
        return await _run(sess)


def _parse_serp_candidates(text: str, max_candidates: int) -> list[dict]:
    sel = Selector(text=text)
    candidates: list[dict] = []
    seen: set[str] = set()

    node_selectors = (
        'div.s-result-item[data-asin]',
        'div[data-component-type="s-search-result"][data-asin]',
        'div[role="listitem"][data-asin]',
        'article[data-asin]',
        'div[data-cy="title-recipe-card"][data-asin]',
        '[data-asin]',
    )
    nodes = []
    for css in node_selectors:
        found = sel.css(css)
        if found:
            nodes = found
            break

    for node in nodes:
        asin = node.attrib.get("data-asin", "").strip()
        if not asin or asin in seen or not is_plausible_asin(asin):
            continue
        title_parts = [t.strip() for t in node.css("h2 ::text").getall() if t.strip()]
        title = " ".join(title_parts)
        if not title:
            title = (node.css("span.a-text-normal::text").get() or "").strip()
        if not title:
            title = (node.css("img::attr(alt)").get() or "").strip()
        if not title:
            continue
        image = (
            node.css("img.s-image::attr(src)").get()
            or node.css("img::attr(src)").get()
            or ""
        )
        seen.add(asin)
        price = _parse_serp_price(node)
        candidates.append({"asin": asin, "title": title, "image": image, "price": price})
        if len(candidates) >= max_candidates:
            break

    if len(candidates) < max_candidates:
        for extra in _parse_serp_json_candidates(text, max_candidates, seen):
            candidates.append(extra)
            if len(candidates) >= max_candidates:
                return candidates

    if len(candidates) < max_candidates:
        for extra in _parse_serp_regex_candidates(text, max_candidates, seen):
            candidates.append(extra)
            if len(candidates) >= max_candidates:
                return candidates

    # Amazon occasionally changes markup — fall back to /dp/ links in result HTML.
    if len(candidates) < max_candidates and len(text) > 5000:
        for node in sel.css('a[href*="/dp/"]'):
            href = node.attrib.get("href", "") or ""
            m = re.search(r"/dp/([A-Z0-9]{10})", href)
            if not m:
                continue
            asin = m.group(1)
            if asin in seen:
                continue
            title = " ".join(t.strip() for t in node.css("::text").getall() if t.strip())
            if len(title) < 8:
                parent = node.xpath("ancestor::div[@data-asin][1]")
                if parent:
                    title = " ".join(
                        t.strip() for t in parent.css("h2 ::text, span.a-text-normal::text").getall() if t.strip()
                    )
            if len(title) < 8:
                continue
            image = node.css("img::attr(src)").get() or ""
            seen.add(asin)
            candidates.append({"asin": asin, "title": title, "image": image, "price": None})
            if len(candidates) >= max_candidates:
                break

    return candidates


async def search_amazon_for_asin(title: str, brand: str | None = None) -> dict:
    """Search Amazon, return best organic ASIN + word-overlap confidence."""
    search_queries = _search_queries(title)
    if brand:
        branded = clean_query(title, brand)
        if branded and branded.lower() not in {q.lower() for q in search_queries}:
            search_queries = [branded] + search_queries
    if not search_queries:
        return {"asin": None, "confidence": 0.0, "method": "no_results"}

    candidates: list[dict] = []
    async with AsyncSession() as session:
        for query in search_queries[:FINDER_MAX_SERP_QUERIES]:
            batch, _proxy_used = await search_amazon_candidates(
                query, session=session, prefer_no_proxy=True
            )
            if batch:
                candidates = batch
                break

    if not candidates:
        return {"asin": None, "confidence": 0.0, "method": "no_results"}

    query = clean_query(title, brand)
    for cand in candidates:
        cand["score"] = _content_score(query, cand["title"])
    best = max(candidates, key=lambda c: c["score"])
    return {
        "asin": best["asin"],
        "confidence": best["score"],
        "amazon_title": best["title"].lower(),
        "method": "search",
    }


async def match_listing(
    listing: dict,
    img_session: AsyncSession | None = None,
    serp_cache: dict[str, list[dict]] | None = None,
) -> dict:
    """Match one listing within a hard time budget (so a single slow product can't
    stall the whole batch). On timeout we report no confident match."""
    if listing.get("amazon_asin"):
        return {**listing, "match_confidence": 1.0, "match_method": "description"}

    try:
        return await asyncio.wait_for(
            _match_listing_inner(listing, img_session, serp_cache),
            timeout=_PER_PRODUCT_TIMEOUT,
        )
    except (asyncio.TimeoutError, Exception):  # noqa: BLE001
        return {
            **listing,
            "amazon_asin": None,
            "match_confidence": 0.0,
            "clean_title": clean_query(listing.get("title", "")),
        }


def _copy_match_fields(src: dict, dst: dict) -> dict:
    """Apply match result from a representative listing onto a duplicate title."""
    for key in (
        "amazon_asin",
        "match_confidence",
        "match_title_score",
        "match_image_score",
        "match_method",
        "amazon_title",
        "clean_title",
    ):
        if key in src:
            dst[key] = src[key]
    return dst


async def _get_candidates(
    queries: list[str], serp_cache: dict[str, list[dict]] | None
) -> list[dict]:
    """One SERP request per title; second query only if the first returns nothing."""
    all_cands: list[dict] = []
    seen: set[str] = set()

    for qi, query in enumerate(queries[:FINDER_MAX_SERP_QUERIES]):
        cache_key = query.lower()
        if serp_cache is not None and cache_key in serp_cache:
            batch = serp_cache[cache_key]
        else:
            batch, _proxy = await search_amazon_candidates(query)
            if serp_cache is not None:
                serp_cache[cache_key] = batch

        for c in batch:
            if c["asin"] not in seen:
                seen.add(c["asin"])
                all_cands.append(c)

    return all_cands[: _MAX_CANDIDATES * 2]


async def _match_listing_inner(
    listing: dict,
    img_session: AsyncSession | None,
    serp_cache: dict[str, list[dict]] | None = None,
) -> dict:
    title = listing.get("title", "")
    clean = clean_query(title)

    # Redis cache — only reuse high-confidence ASIN hits (never cache misses).
    cached = match_cache.get_match(clean)
    if cached and cached.get("amazon_asin"):
        conf = float(cached.get("match_confidence") or 0)
        if conf >= _MIN_MATCH_CONFIDENCE:
            return {**listing, **cached, "clean_title": clean}

    queries = _search_queries(title)

    # Stage 1 — Amazon SERP (primary query + focused fallback if needed).
    candidates = await _get_candidates(queries, serp_cache)
    if not candidates:
        return {**listing, "amazon_asin": None, "match_confidence": 0.0, "clean_title": clean}

    # Stage 2 — content scoring on every candidate.
    for cand in candidates:
        cand["content"] = _content_score(clean, cand["title"])
    candidates.sort(key=lambda c: c["content"], reverse=True)
    viable = [c for c in candidates if c["content"] >= _MIN_CONTENT]
    if not viable:
        return {
            **listing,
            "amazon_asin": None,
            "match_confidence": candidates[0]["content"] if candidates else 0.0,
            "clean_title": clean,
        }

    text_best_score = viable[0]["content"]
    ebay_image_url = listing.get("image", "")

    best: dict | None = None
    if ebay_image_url:
        candidates_for_image = [
            {
                "asin": c["asin"],
                "image_url": c.get("image", ""),
                "text_score": c["content"],
                "title": c["title"],
                "price": c.get("price"),
            }
            for c in viable
        ]
        image_result = await siglip_match(
            ebay_image_url=ebay_image_url,
            candidates=candidates_for_image,
            text_best_score=text_best_score,
        )
        if image_result and image_result["combined_score"] >= 0.72:
            conf = float(image_result["combined_score"])
            if image_result["image_score"] >= 0.85:
                conf = max(conf, 0.81)
            elif image_result["image_score"] >= 0.75:
                conf = max(conf, 0.80)
            best = {
                "asin": image_result["asin"],
                "combined": conf,
                "content_score": image_result["text_score"],
                "image_score": image_result["image_score"],
                "amazon_title": (image_result.get("title") or "").lower(),
                "method": "image_siglip",
            }

    if best is None:
        for cand in viable:
            content = cand["content"]
            if content >= _STRONG_CONTENT:
                combined = content
                method = "title+content"
            else:
                combined = content * 0.75
                method = "title+content"

            if best is None or combined > best["combined"]:
                best = {
                    "asin": cand["asin"],
                    "combined": combined,
                    "content_score": round(content, 2),
                    "image_score": None,
                    "amazon_title": cand["title"].lower(),
                    "method": method,
                }

    if not best or best["combined"] < _MIN_COMBINED:
        return {
            **listing,
            "amazon_asin": None,
            "match_confidence": round(best["combined"], 2) if best else 0.0,
            "clean_title": clean,
        }

    # Text-only wins must clear a higher bar; image wins need strong combined score.
    if best.get("image_score") is None and best["content_score"] < _STRONG_CONTENT:
        return {
            **listing,
            "amazon_asin": None,
            "match_confidence": round(best["combined"], 2),
            "clean_title": clean,
        }

    result = {
        **listing,
        "amazon_asin": best["asin"],
        "match_confidence": round(best["combined"], 2),
        "match_title_score": best["content_score"],
        "match_image_score": best["image_score"],
        "text_score": best["content_score"],
        "image_score": best["image_score"],
        "match_method": best["method"],
        "amazon_title": best["amazon_title"],
        "clean_title": clean,
    }
    match_cache.set_match(
        clean,
        {
            "amazon_asin": result["amazon_asin"],
            "match_confidence": result["match_confidence"],
            "match_title_score": result["match_title_score"],
            "match_image_score": result["match_image_score"],
            "match_method": result["match_method"],
            "amazon_title": result["amazon_title"],
        },
    )
    return result


async def match_listings_batch(listings: list[dict], concurrency: int = 30) -> list[dict]:
    """Match listings concurrently. Identical titles share one Amazon SERP lookup."""
    if not listings:
        return []

    groups: dict[str, list[int]] = {}
    for i, listing in enumerate(listings):
        key = clean_query(listing.get("title", "")).lower()
        groups.setdefault(key, []).append(i)

    representatives = [listings[idxs[0]] for idxs in groups.values()]
    serp_cache: dict[str, list[dict]] = {}
    semaphore = asyncio.Semaphore(concurrency)

    async with AsyncSession() as img_session:

        async def _match_rep(rep: dict) -> dict:
            async with semaphore:
                res = await match_listing(rep, img_session=img_session, serp_cache=serp_cache)
                await asyncio.sleep(0.02)
                return res

        matched_reps = await asyncio.gather(*[_match_rep(r) for r in representatives])

    rep_by_key = {
        clean_query(rep.get("title", "")).lower(): matched
        for rep, matched in zip(representatives, matched_reps)
    }
    out = list(listings)
    for key, idxs in groups.items():
        template = rep_by_key.get(key, {})
        for idx in idxs:
            out[idx] = _copy_match_fields(template, dict(listings[idx]))
    return out
