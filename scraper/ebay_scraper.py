"""
Scrape eBay sold listings for a given seller.

Target: https://www.ebay.com/sch/i.html?_ssn={seller}&LH_Sold=1&LH_Complete=1&_ipg=240&_pgn={page}
eBay sold data is public and rarely blocks — no proxy needed. Uses curl_cffi chrome120.
"""

import asyncio
import logging
import os
import re
from datetime import datetime, timezone, timedelta
from typing import Optional
from urllib.parse import parse_qs, unquote, urlencode, urlparse

from curl_cffi.requests import AsyncSession
from parsel import Selector

from proxy_http import ensure_proxy
import proxy_meter

logger = logging.getLogger("pricehawk.ebay")

# Only one eBay seller scrape at a time — concurrent scrapes share the same
# residential proxy and frequently trigger bot challenges (0 listings).
_EBAY_GATE = asyncio.Semaphore(1)

_SSN_FROM_LINK = re.compile(r"[?&]_ssn=([A-Za-z0-9_\-]+)", re.I)
_STORE_NAME_FROM_LINK = re.compile(r"[?&]store_name=([A-Za-z0-9_\-]+)", re.I)


def parse_ebay_seller_input(raw: str) -> dict:
    """Parse queue input: plain username, store name, or full eBay URL."""
    raw = raw.strip()
    out: dict = {
        "raw": raw,
        "display": raw.lstrip("@"),
        "ebay_ssn": None,
        "store_name": None,
        "from_url": False,
    }
    if not raw:
        return out

    if "ebay." not in raw.lower():
        out["display"] = raw.lstrip("@")
        return out

    url = raw if "://" in raw else f"https://{raw}"
    parsed = urlparse(url)
    qs = parse_qs(parsed.query)
    ssn = (qs.get("_ssn") or [None])[0]
    store = (qs.get("store_name") or [None])[0]
    if ssn:
        out["ebay_ssn"] = ssn.strip()
    if store:
        out["store_name"] = store.strip()

    path_m = re.search(r"/(?:usr|str)/([^/?#]+)", parsed.path, re.I)
    if path_m:
        path_name = unquote(path_m.group(1)).strip()
        if path_name and not out["store_name"]:
            out["store_name"] = path_name

    out["from_url"] = True
    out["display"] = out["store_name"] or out["ebay_ssn"] or out["display"]
    return out


async def resolve_ebay_seller_id(
    name: str,
    *,
    ebay_ssn_hint: str | None = None,
    store_name_hint: str | None = None,
) -> dict:
    """Map eBay store display name -> real `_ssn` username used in sold search.

    Many sellers queue a *store name* (e.g. ADart201) while sold data lives under
    a different account id (e.g. avigdur83) linked from /str/{store}.
    """
    name = name.strip()
    out = {
        "input": name,
        "ebay_ssn": name,
        "store_name": None,
        "resolved": False,
    }
    if not name:
        return out

    store_hint = (store_name_hint or "").strip() or None
    if store_hint and store_hint.lower() != name.lower():
        name = store_hint

    if ebay_ssn_hint:
        hint = ebay_ssn_hint.strip()
        store_for_search = store_hint or (name if name.lower() != hint.lower() else None)
        test_params = _build_sold_search_params(hint, 1, store_name=store_for_search)
        test = await _fetch_search_page_with_params(
            hint, 1, test_params, session=None, attempts=2
        )
        if not test or _html_looks_blocked(test):
            test = await _fetch_seller_search(hint, 1, sold_only=True, session=None, attempts=2)
        if test and not _html_looks_blocked(test):
            count = _search_results_count(test) or 0
            if count > 0 or len(parse_sold_listings(test)) > 0:
                out["ebay_ssn"] = hint
                if store_for_search and store_for_search.lower() != hint.lower():
                    out["store_name"] = store_for_search
                    out["resolved"] = True
                elif name.lower() != hint.lower():
                    out["store_name"] = name
                    out["resolved"] = True
                logger.info("Resolved %s -> _ssn %s (URL hint)", name, hint)
                return out

    html = await _fetch_seller_search(name, 1, sold_only=True, session=None, attempts=2)
    if html and not _html_looks_blocked(html):
        count = _search_results_count(html) or 0
        if count > 0 or len(parse_sold_listings(html)) > 0:
            return out

    async with AsyncSession() as session:
        await _warmup(session)
        store_url = f"https://www.ebay.com/str/{name}"
        r = await _ebay_get(session, store_url, headers=EBAY_HEADERS, timeout=20)
        if r is None:
            return out
        if _html_looks_blocked(r.text):
            r = await _ebay_get_force_proxy(
                session, store_url, headers=EBAY_HEADERS, timeout=25
            )
        if r is None or r.status_code != 200 or _html_looks_blocked(r.text):
            return out
        if "ebay store" not in r.text.lower():
            return out

        ssns: list[str] = []
        for m in _SSN_FROM_LINK.finditer(r.text):
            ssn = m.group(1).strip()
            if ssn and ssn.lower() != name.lower() and ssn not in ssns:
                ssns.append(ssn)

        for ssn in ssns:
            test_params = _build_sold_search_params(ssn, 1, store_name=name)
            test = await _fetch_search_page_with_params(
                ssn, 1, test_params, session=None, attempts=2
            )
            if not test or _html_looks_blocked(test):
                test = await _fetch_seller_search(ssn, 1, sold_only=True, session=None, attempts=2)
            if not test or _html_looks_blocked(test):
                continue
            if (_search_results_count(test) or 0) > 0 or len(parse_sold_listings(test)) > 0:
                out["ebay_ssn"] = ssn
                out["store_name"] = name
                out["resolved"] = True
                logger.info("Resolved eBay store %s -> _ssn %s", name, ssn)
                return out

        # Sold search by store_name param (some stores only expose sales this way).
        store_params = _build_sold_search_params(ssns[0] if ssns else name, 1, store_name=name)
        test_html = await _fetch_search_page_with_params(
            name, 1, store_params, session=None, attempts=2
        )
        if test_html and not _html_looks_blocked(test_html):
            if (_search_results_count(test_html) or 0) > 0 or len(parse_sold_listings(test_html)) > 0:
                resolved_ssn = ssns[0] if ssns else name
                out["ebay_ssn"] = resolved_ssn
                out["store_name"] = name
                out["resolved"] = bool(ssns and ssns[0].lower() != name.lower())
                logger.info("Resolved store_name %s -> _ssn %s (sold URL)", name, resolved_ssn)
                return out

    return out


async def _ebay_get_force_proxy(session: AsyncSession, url: str, **kwargs):
    """Always route through residential proxy (for retry after challenge)."""
    kwargs.setdefault("impersonate", "chrome120")
    try:
        r = await session.get(url, proxies=_proxies(), **kwargs)
        proxy_meter.add_response(r)
        return r
    except Exception as exc:  # noqa: BLE001
        logger.warning("eBay proxy GET failed %s: %s", url[:96], exc)
        return None



def _proxies() -> dict | None:
    """eBay sold search — residential gateway only (dc.* often fails DNS in Docker)."""
    return ensure_proxy("residential")


def _html_looks_blocked(html: str) -> bool:
    low = html.lower()
    return "pardon our interruption" in low or "captcha" in low[:8000]


def _is_challenged(r) -> bool:
    """Detect eBay bot wall / non-200 responses."""
    if r.status_code != 200:
        return True
    return _html_looks_blocked(r.text)

EBAY_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
}

from asin_util import normalize_asin

_ASIN_DP_RE = re.compile(r"amazon\.[a-z.]+/(?:dp|gp/product)/([A-Z0-9]{10})", re.IGNORECASE)


def _parse_price_amount(raw: str) -> float | None:
    """Extract sold price from eBay price text (ranges, was/now, currency symbols)."""
    if not raw:
        return None
    text = raw.strip()
    low = text.lower()
    if " to " in low:
        text = text[: low.index(" to ")]
    amounts: list[float] = []
    for m in re.finditer(r"(\d[\d,]*\.?\d*)", text.replace(",", "")):
        try:
            val = float(m.group(1))
            if val > 0:
                amounts.append(val)
        except ValueError:
            continue
    if not amounts:
        return None
    if re.search(r"\bwas\b", text, re.I) and len(amounts) >= 2:
        return amounts[-1]
    return amounts[0]


def _parse_card_price(card) -> float | None:
    """Sold price from s-card or s-item markup."""
    for sel in (
        ".s-card__price .su-styled-text.positive ::text",
        ".s-card__price .su-styled-text ::text",
        ".s-card__price ::text",
        ".s-item__price ::text",
        ".s-item__detail .s-item__price ::text",
    ):
        parts = [x.strip() for x in card.css(sel).getall() if x.strip()]
        if not parts:
            continue
        price = _parse_price_amount(" ".join(parts))
        if price is not None:
            return price
    return None


def _parse_card_title(card) -> str:
    for sel in (
        ".s-card__title .su-styled-text::text",
        ".s-card__title ::text",
        ".s-item__title ::text",
        ".s-item__title .s-item__title--tagblock ::text",
    ):
        title = (card.css(sel).get() or "").strip()
        if title:
            return title
    return ""


def _parse_card_from_element(card) -> dict | None:
    title = _parse_card_title(card)
    if not title or title.lower() == "shop on ebay":
        return None

    sold_price = _parse_card_price(card)
    if sold_price is None:
        return None

    listing_id = (card.attrib.get("data-listingid") or "").strip() or None
    url = (
        card.css("a.s-card__link::attr(href)").get()
        or card.css("a.s-item__link::attr(href)").get()
        or card.css("a[href*='/itm/']::attr(href)").get()
        or ""
    )
    url = url.split("?")[0]
    if (not listing_id or listing_id == "0") and url:
        m = re.search(r"/itm/(\d+)", url)
        listing_id = m.group(1) if m else listing_id

    caption = " ".join(
        x.strip()
        for x in card.css(
            ".s-card__caption ::text, .s-card__caption .su-styled-text ::text, "
            ".s-item__title--tagblock .POSITIVE ::text, .s-item__subtitle ::text"
        ).getall()
        if x.strip()
    )
    sold_date = parse_ebay_date(caption)

    attrs = " ".join(
        x.strip()
        for x in card.css(
            ".su-card-container__attributes ::text, .s-item__details ::text, "
            ".s-item__detail ::text"
        ).getall()
        if x.strip()
    )
    qty_match = re.search(r"([\d,]+)\s+sold", attrs, re.IGNORECASE)
    quantity_sold = int(qty_match.group(1).replace(",", "")) if qty_match else 1

    image = (
        card.css(".s-card__media-wrapper img::attr(src)").get()
        or card.css(".s-item__image-img::attr(src)").get()
        or card.css("img::attr(src)").get()
        or card.css("img::attr(data-src)").get()
        or ""
    )

    return {
        "listing_id": listing_id,
        "title": title,
        "sold_price": sold_price,
        "quantity_sold": quantity_sold,
        "sold_date": sold_date.isoformat() if sold_date else None,
        "url": url,
        "image": image,
        "amazon_asin": None,
        "amazon_price": None,
        "match_confidence": None,
    }


# always | never | on_challenge — default always: never use host IP for eBay
EBAY_PROXY_MODE = os.getenv("EBAY_PROXY_MODE", "always").lower()


def _ebay_use_proxy(force: bool = False) -> bool:
    if EBAY_PROXY_MODE == "always" or force:
        return True
    if EBAY_PROXY_MODE == "never":
        return False
    return force


async def _ebay_get(session: AsyncSession, url: str, **kwargs):
    """Fetch eBay HTML; count proxy bytes only when residential proxy is used."""
    kwargs.setdefault("impersonate", "chrome120")
    try:
        if EBAY_PROXY_MODE == "always":
            r = await session.get(url, proxies=_proxies(), **kwargs)
            if r is not None and r.status_code == 200 and not _is_challenged(r):
                proxy_meter.add_response(r)
                return r
            logger.warning("eBay proxy/challenge on %s — retrying direct", url[:96])
            direct = await session.get(url, proxies=None, **kwargs)
            return direct
        if EBAY_PROXY_MODE == "never":
            return await session.get(url, proxies=None, **kwargs)
        r = await session.get(url, proxies=None, **kwargs)
        if not _is_challenged(r):
            return r
        r2 = await _ebay_get_force_proxy(session, url, **kwargs)
        return r2 if r2 is not None else r
    except Exception as exc:  # noqa: BLE001
        logger.warning("eBay GET failed %s: %s", url[:96], exc)
        if EBAY_PROXY_MODE == "always":
            try:
                return await session.get(url, proxies=None, **kwargs)
            except Exception as direct_exc:  # noqa: BLE001
                logger.warning("eBay direct fallback failed %s: %s", url[:96], direct_exc)
        return None


async def _warmup(session: AsyncSession) -> None:
    """Visit the eBay homepage to obtain cookies (search is challenged without them)."""
    try:
        await _ebay_get(
            session,
            "https://www.ebay.com/",
            headers=EBAY_HEADERS,
            timeout=20,
        )
    except Exception:  # noqa: BLE001
        pass


def _profile_page_valid(html: str, seller: str) -> bool:
    low = html.lower()
    title = (Selector(text=html).css("title::text").get() or "").lower()
    if title in ("ebay home", "security measure | ebay", "pardon our interruption..."):
        return False
    if "the seller you" in low and "not found" in low:
        return False
    if seller.lower() not in low[:12000] and seller.lower() not in title:
        return False
    return "not found" not in low[:5000]


def _search_results_count(html: str) -> int | None:
    m = re.search(r"([\d,]+)\+?\s+results?\b", html, re.IGNORECASE)
    if not m:
        return None
    try:
        return int(m.group(1).replace(",", ""))
    except ValueError:
        return None


async def _fetch_seller_search(
    seller: str,
    page: int = 1,
    *,
    sold_only: bool = True,
    session: Optional[AsyncSession] = None,
    attempts: int = 3,
) -> str | None:
    """Fetch seller search HTML (sold/completed or all active listings)."""
    params: dict[str, str] = {
        "_ssn": seller,
        "_ipg": "240",
        "_pgn": str(page),
        "rt": "nc",
    }
    if sold_only:
        params.update({"LH_Sold": "1", "LH_Complete": "1", "_sop": "13"})
    else:
        params["_sop"] = "12"
    return await _fetch_search_page_with_params(seller, page, params, session, attempts)


async def _fetch_search_page_with_params(
    seller: str,
    page: int,
    params: dict[str, str],
    session: Optional[AsyncSession] = None,
    attempts: int = 3,
) -> str | None:
    headers = {**EBAY_HEADERS, "Referer": "https://www.ebay.com/"}
    url = "https://www.ebay.com/sch/i.html"

    if session is not None:
        try:
            r = await _ebay_get(session, url, params=params, headers=headers, timeout=20)
            if r is not None and not _is_challenged(r):
                return r.text
        except Exception as exc:  # noqa: BLE001
            logger.warning("eBay search page %s (shared) failed: %s", page, exc)

    for attempt in range(attempts):
        try:
            async with AsyncSession() as fresh:
                await _warmup(fresh)
                r = await _ebay_get(fresh, url, params=params, headers=headers, timeout=25)
                if r is not None and not _is_challenged(r):
                    return r.text
                # Last resort: force proxy IP (store names often need this).
                r = await _ebay_get_force_proxy(
                    fresh, url, params=params, headers=headers, timeout=30
                )
                if r is not None and not _is_challenged(r):
                    return r.text
                logger.warning(
                    "eBay challenge on page %s (attempt %s/%s)", page, attempt + 1, attempts
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("eBay search page %s attempt %s failed: %s", page, attempt + 1, exc)
        await asyncio.sleep(0.5)
    return None


def _build_sold_search_params(
    ssn: str,
    page: int,
    *,
    store_name: str | None = None,
) -> dict[str, str]:
    """Sold/completed search params — include store_name when the queue is a store front."""
    params: dict[str, str] = {
        "_ssn": ssn,
        "LH_Sold": "1",
        "LH_Complete": "1",
        "_ipg": "240",
        "_pgn": str(page),
        "_sop": "13",
        "rt": "nc",
    }
    if store_name:
        params["store_name"] = store_name
        params["_oac"] = "1"
    return params


def _build_active_search_params(
    ssn: str,
    page: int,
    *,
    store_name: str | None = None,
) -> dict[str, str]:
    """Active/live listings search — no LH_Sold/LH_Complete."""
    params: dict[str, str] = {
        "_ssn": ssn,
        "_ipg": "240",
        "_pgn": str(page),
        "_sop": "12",
        "rt": "nc",
    }
    if store_name:
        params["store_name"] = store_name
        params["_oac"] = "1"
    return params


async def _fetch_active_search_page(
    seller: str,
    page: int,
    session: Optional[AsyncSession] = None,
    attempts: int = 3,
    *,
    store_name: str | None = None,
) -> str | None:
    params = _build_active_search_params(seller, page, store_name=store_name)
    return await _fetch_search_page_with_params(seller, page, params, session, attempts)


async def scrape_seller_active_listings(
    seller: str,
    max_pages: int = 200,
    max_items: int = 10000,
    *,
    ebay_ssn: str | None = None,
    store_name: str | None = None,
) -> list[dict]:
    """Scrape a seller's currently active eBay listings (not sold history)."""
    async with _EBAY_GATE:
        ssn = (ebay_ssn or seller).strip()
        store = (store_name or "").strip() or None
        if store and store.lower() == ssn.lower():
            store = None
        items = await _scrape_seller_active_listings_inner(
            ssn, max_pages, max_items, store_name=store
        )
        return items[:max_items]


async def _scrape_seller_active_listings_inner(
    seller: str,
    max_pages: int,
    max_items: int,
    *,
    store_name: str | None = None,
) -> list[dict]:
    all_items: list[dict] = []
    page_conc = max(1, int(os.getenv("FINDER_EBAY_PAGE_CONCURRENCY", "5")))

    def _tag(items: list[dict]) -> list[dict]:
        for it in items:
            it["listing_type"] = "active"
            it["list_price"] = it.get("sold_price")
            it["quantity_sold"] = 1
            it["sold_date"] = None
        return items

    async with AsyncSession() as session:
        await _warmup(session)

        # Page 1 sequential — handles bot-block retry and tells us if the seller resolves.
        html = await _fetch_active_search_page(seller, 1, session=session, store_name=store_name)
        if html is None:
            await asyncio.sleep(1.0)
            html = await _fetch_active_search_page(
                seller, 1, session=None, attempts=4, store_name=store_name
            )
        if html is None:
            return []
        page_items = parse_sold_listings(html)
        if not page_items and _html_looks_blocked(html):
            await asyncio.sleep(2.0)
            html = await _fetch_active_search_page(
                seller, 1, session=None, attempts=4, store_name=store_name
            )
            if html:
                page_items = parse_sold_listings(html)
        if not page_items:
            return []
        all_items.extend(_tag(page_items))
        total_hint = _search_results_count(html)
        logger.info(
            "[active] %s page 1: %d items (eBay reports ~%s total)",
            seller,
            len(page_items),
            total_hint if total_hint is not None else "?",
        )

        # Remaining pages in parallel waves of `page_conc`.
        page = 2
        stop = False
        while not stop and page <= max_pages and len(all_items) < max_items:
            batch = list(range(page, min(page + page_conc, max_pages + 1)))
            htmls = await asyncio.gather(
                *[
                    _fetch_active_search_page(seller, p, session=session, store_name=store_name)
                    for p in batch
                ]
            )
            for p, h in zip(batch, htmls):
                if h is None:
                    stop = True
                    break
                items = parse_sold_listings(h)
                if not items:
                    stop = True
                    break
                all_items.extend(_tag(items))
                if len(all_items) >= max_items:
                    stop = True
                    break
            logger.info("[active] %s scraped through page %d: %d items", seller, batch[-1], len(all_items))
            page = batch[-1] + 1
            await asyncio.sleep(0.05)

    # Dedupe by listing id (items can shift between pages while paginating).
    seen: set[str] = set()
    unique: list[dict] = []
    for it in all_items:
        key = str(it.get("listing_id") or it.get("url") or id(it))
        if key in seen:
            continue
        seen.add(key)
        unique.append(it)

    logger.info("[active] %s done: %d unique active listings", seller, len(unique))
    return unique[:max_items]


async def _fetch_search_page(
    seller: str,
    page: int,
    session: Optional[AsyncSession] = None,
    attempts: int = 3,
    *,
    store_name: str | None = None,
):
    """Fetch one sold/completed search page."""
    params = _build_sold_search_params(seller, page, store_name=store_name)
    return await _fetch_search_page_with_params(seller, page, params, session, attempts)


async def scrape_seller_sold_listings(
    seller: str,
    days_back: int = 90,
    max_pages: int = 100,
    max_items: int = 5000,
    *,
    ebay_ssn: str | None = None,
    store_name: str | None = None,
) -> list[dict]:
    """Scrape sold listings. `seller` is the queued name; `ebay_ssn` overrides search id."""
    async with _EBAY_GATE:
        ssn = (ebay_ssn or seller).strip()
        store = (store_name or "").strip() or None
        if store and store.lower() == ssn.lower():
            store = None
        items = await _scrape_seller_sold_listings_inner(
            ssn, days_back, max_pages, max_items, store_name=store
        )
        return items[:max_items]


async def _scrape_seller_sold_listings_inner(
    seller: str,
    days_back: int,
    max_pages: int,
    max_items: int,
    *,
    store_name: str | None = None,
) -> list[dict]:
    """Inner scrape loop (must run under _EBAY_GATE)."""

    def _sold_line_key(it: dict) -> str:
        sold = (
            f"{str(it.get('sold_date') or '')[:10]}|"
            f"{it.get('sold_price')}|{it.get('quantity_sold') or 1}"
        )
        lid = it.get("listing_id")
        if lid:
            return f"lid:{lid}|{sold}"
        url = str(it.get("url") or "").split("?")[0]
        if url:
            return f"url:{url}|{sold}"
        return f"title:{it.get('title')}|{sold}"

    all_items: list[dict] = []
    seen_keys: set[str] = set()
    cutoff_date = datetime.now(timezone.utc) - timedelta(days=days_back)
    empty_window_pages = 0

    # One warmed session reused across pages (avoids a homepage warmup per page).
    async with AsyncSession() as session:
        await _warmup(session)

        for page in range(1, max_pages + 1):
            html = await _fetch_search_page(
                seller, page, session=session, store_name=store_name
            )
            if html is None:
                if page == 1:
                    await asyncio.sleep(1.0)
                    html = await _fetch_search_page(
                        seller, page, session=None, attempts=4, store_name=store_name
                    )
                if html is None:
                    break

            page_items = parse_sold_listings(html)
            if page == 1 and not page_items and _html_looks_blocked(html):
                await asyncio.sleep(2.0)
                html = await _fetch_search_page(
                    seller, page, session=None, attempts=4, store_name=store_name
                )
                if html:
                    page_items = parse_sold_listings(html)
            if not page_items:
                break  # end of results

            # eBay returns Best-Match order (NOT by date), so filter each page
            # rather than breaking on the first old item.
            in_window = [
                it
                for it in page_items
                if it["sold_date"] is None
                or datetime.fromisoformat(it["sold_date"]) >= cutoff_date
            ]
            new_items: list[dict] = []
            for it in in_window:
                key = _sold_line_key(it)
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                new_items.append(it)
            all_items.extend(new_items)

            # Pagination stuck (challenge/cookie) — same rows repeat every page.
            if page > 1 and len(new_items) == 0:
                break

            if len(all_items) >= max_items:
                break

            # Stop after two consecutive pages with no in-window sales.
            recent_on_page = sum(
                1
                for it in page_items
                if it["sold_date"] and datetime.fromisoformat(it["sold_date"]) >= cutoff_date
            )
            empty_window_pages = empty_window_pages + 1 if recent_on_page == 0 else 0
            if empty_window_pages >= 2:
                break

            await asyncio.sleep(0.05)

    return all_items[:max_items]


async def scrape_seller_sold_for_name(
    seller: str,
    days_back: int = 90,
    max_pages: int = 100,
    max_items: int = 5000,
    *,
    ebay_ssn_hint: str | None = None,
    store_name_hint: str | None = None,
) -> tuple[list[dict], dict]:
    """Resolve store name then scrape sold listings. Returns (listings, resolution)."""
    resolution = await resolve_ebay_seller_id(
        seller, ebay_ssn_hint=ebay_ssn_hint, store_name_hint=store_name_hint
    )
    store_name = resolution.get("store_name") or store_name_hint
    listings = await scrape_seller_sold_listings(
        seller,
        days_back=days_back,
        max_pages=max_pages,
        max_items=max_items,
        ebay_ssn=resolution["ebay_ssn"],
        store_name=store_name,
    )
    return listings, resolution


def parse_sold_listings(html: str) -> list[dict]:
    """Parse all sold items from an eBay search results page (s-card + s-item markup)."""
    sel = Selector(text=html)
    items: list[dict] = []
    seen_ids: set[str] = set()

    for card in sel.css("li.s-card, li.s-item"):
        parsed = _parse_card_from_element(card)
        if not parsed:
            continue
        dedupe = parsed.get("listing_id") or parsed.get("url") or parsed.get("title")
        if dedupe in seen_ids:
            continue
        seen_ids.add(str(dedupe))
        items.append(parsed)

    return items


def parse_ebay_date(date_str: str) -> Optional[datetime]:
    """Parse common eBay date formats, e.g. 'Sold  May 14, 2025'."""
    if not date_str:
        return None
    text = re.sub(r"^(Sold|Ended)\b", "", date_str.strip(), flags=re.IGNORECASE).strip()

    # Prefer an explicit "Mon DD, YYYY" / "DD Mon YYYY" / "MM/DD/YYYY" substring.
    candidates = [text]
    m = re.search(r"[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}", text)
    if m:
        candidates.insert(0, m.group(0).replace(".", ""))
    m = re.search(r"\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}", text)
    if m:
        candidates.insert(0, m.group(0).replace(".", ""))
    m = re.search(r"\d{1,2}/\d{1,2}/\d{2,4}", text)
    if m:
        candidates.insert(0, m.group(0))

    formats = ["%b %d, %Y", "%B %d, %Y", "%d %b %Y", "%d %B %Y", "%m/%d/%Y", "%m/%d/%y"]
    for cand in candidates:
        cand = cand.strip()
        for fmt in formats:
            try:
                dt = datetime.strptime(cand, fmt)
                return dt.replace(tzinfo=timezone.utc)
            except ValueError:
                continue
    return None


def _extract_asin_from_html(html: str) -> dict | None:
    """
    Extract ASIN from eBay listing HTML.

    Only trusts explicit amazon.com/dp/ or /gp/product/ links — eBay page chrome
    often contains labeled 10-char tokens (e.g. JLZNJLC2HE) that are not ASINs.
    """
    for m in _ASIN_DP_RE.finditer(html):
        asin = normalize_asin(m.group(1))
        if asin:
            return {"asin": asin, "source": "dp_link"}
    return None


async def get_listing_details(
    listing_id: str, session: Optional[AsyncSession] = None
) -> dict:
    """Fetch a listing page and try to extract an Amazon ASIN from its description."""
    url = f"https://www.ebay.com/itm/{listing_id}"
    headers = {**EBAY_HEADERS, "Referer": "https://www.ebay.com/"}

    async def _fetch(sess: AsyncSession) -> dict:
        try:
            r = await _ebay_get(sess, url, headers=headers, timeout=8)
            if r.status_code != 200:
                return {}
            return _extract_asin_from_html(r.text) or {}
        except Exception:  # noqa: BLE001
            return {}

    if session is not None:
        return await _fetch(session)
    async with AsyncSession() as own:
        await _warmup(own)
        return await _fetch(own)


async def diagnose_seller_scrape(seller: str, days_back: int) -> dict:
    """Explain why a sold scrape returned zero rows (for UI messages)."""
    seller = seller.strip()
    if not seller:
        return {"status": "invalid_seller", "message": "Seller username is empty"}

    resolution = await resolve_ebay_seller_id(seller)
    ebay_ssn = resolution["ebay_ssn"]
    store_name = resolution.get("store_name")
    verify_params = _build_sold_search_params(ebay_ssn, 1, store_name=store_name)
    verify_url = f"https://www.ebay.com/sch/i.html?{urlencode(verify_params)}"
    resolve_note = ""
    if resolution.get("resolved"):
        resolve_note = f' (store "{seller}" → account {ebay_ssn})'

    async with AsyncSession() as session:
        await _warmup(session)
        profile_r = await _ebay_get(
            session,
            f"https://www.ebay.com/usr/{ebay_ssn}",
            headers=EBAY_HEADERS,
            timeout=15,
        )
        profile_ok = (
            profile_r is not None
            and profile_r.status_code == 200
            and _profile_page_valid(profile_r.text, ebay_ssn)
        )
        store_r = await _ebay_get(
            session,
            f"https://www.ebay.com/str/{seller}",
            headers=EBAY_HEADERS,
            timeout=15,
        )
        store_ok = (
            store_r is not None
            and store_r.status_code == 200
            and not _html_looks_blocked(store_r.text)
            and "ebay store" in store_r.text.lower()
        )

    if not profile_ok and not store_ok and not resolution.get("resolved"):
        return {
            "status": "seller_not_found",
            "message": (
                f'eBay user/store "{seller}" not found — copy the exact name from '
                f"ebay.com/usr/… or ebay.com/str/… URL"
            ),
            "verify_url": verify_url,
            "ebay_seller_id": ebay_ssn,
        }

    html = await _fetch_seller_search(ebay_ssn, 1, sold_only=True, session=None, attempts=3)
    if html is None:
        return {
            "status": "ebay_blocked",
            "message": "eBay blocked the request (captcha/proxy) — retry with Fresh scan",
            "verify_url": verify_url,
        }

    results_count = _search_results_count(html)
    page_items = parse_sold_listings(html)

    if page_items:
        cutoff = datetime.now(timezone.utc) - timedelta(days=days_back)
        in_window = [
            it
            for it in page_items
            if it["sold_date"] is None
            or datetime.fromisoformat(it["sold_date"]) >= cutoff
        ]
        if in_window:
            return {
                "status": "scrape_retry",
                "message": (
                    f"eBay shows {len(in_window)}+ sold on page 1 but scan returned 0 — retry Fresh scan"
                ),
                "verify_url": verify_url,
            }
        return {
            "status": "date_window_empty",
            "message": f"eBay has sold items but none within the last {days_back} days — try 90 days",
            "verify_url": verify_url,
        }

    if results_count == 0 or "0 results" in html.lower():
        active_html = await _fetch_seller_search(
            ebay_ssn, 1, sold_only=False, session=None, attempts=2
        )
        active_count = _search_results_count(active_html or "") if active_html else None
        active_parsed = len(parse_sold_listings(active_html)) if active_html else 0
        if active_count and active_count > 0:
            return {
                "status": "no_public_sold",
                "message": (
                    f'eBay public search: 0 sold, but {active_count} active listings — '
                    f"seller may not expose completed sales publicly. Verify in browser: {verify_url}"
                ),
                "verify_url": verify_url,
                "active_listings": active_count,
            }
        return {
            "status": "no_sold_listings",
            "message": (
                f"eBay public sold search: 0 results{resolve_note}. "
                f"Verify: {verify_url}"
            ),
            "verify_url": verify_url,
            "active_listings": active_parsed or active_count or 0,
            "ebay_seller_id": ebay_ssn,
            "ebay_store_resolved": resolution.get("resolved"),
        }

    if _html_looks_blocked(html):
        return {
            "status": "ebay_blocked",
            "message": "eBay challenge page — retry later or enable proxy",
            "verify_url": verify_url,
        }

    return {
        "status": "parse_empty",
        "message": "eBay returned results but parser found 0 sold rows — markup may have changed",
        "verify_url": verify_url,
        "ebay_results_count": results_count,
    }


async def seller_exists(seller: str) -> bool:
    """Quick check whether an eBay seller profile exists."""
    seller = seller.strip()
    if not seller:
        return False
    url = f"https://www.ebay.com/usr/{seller}"
    async with AsyncSession() as session:
        try:
            await _warmup(session)
            r = await _ebay_get(
                session,
                url,
                headers=EBAY_HEADERS,
                timeout=15,
            )
            if r.status_code != 200:
                return False
            return _profile_page_valid(r.text, seller)
        except Exception:  # noqa: BLE001
            return False
