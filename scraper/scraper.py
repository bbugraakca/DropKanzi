"""
2-tier Amazon scrape:
  Tier 1 — AOD ajax (~8KB): price, stock, buy box (every request)
  Tier 2 — Full /dp page (~150-500KB): title, images (first fetch or fullFetchAt > 24h)
"""

import asyncio
import logging
import os
import random
from datetime import datetime, timezone
from typing import Optional

from curl_cffi.requests import AsyncSession

from parser import (
    is_blocked_html,
    is_captcha_html,
    parse_aod,
    parse_full_page,
    parse_product_page_offer,
    has_product_signals,
    has_aod_signals,
)
from proxy import get_proxy_url

logger = logging.getLogger("pricehawk.scraper")

BULK_CONCURRENCY = int(os.getenv("BULK_CONCURRENCY", "40"))
BULK_RETRY_ATTEMPTS = int(os.getenv("BULK_RETRY_ATTEMPTS", "3"))
BULK_SESSION_POOL = int(os.getenv("BULK_SESSION_POOL", "6"))
FINDER_PRICE_SESSION_POOL = int(os.getenv("FINDER_PRICE_SESSION_POOL", "16"))
FINDER_PRICE_MAX_CONCURRENCY = int(os.getenv("FINDER_PRICE_MAX_CONCURRENCY", "60"))
FINDER_PRICE_MAX_ASINS = int(os.getenv("FINDER_PRICE_MAX_ASINS", "1000"))
FULL_FETCH_TTL_SEC = 86400  # 24h
SKIP_AOD = os.getenv("SCRAPER_SKIP_AOD", "false").lower() in ("1", "true", "yes")
PRICE_STREAM_CHUNK = int(os.getenv("PRICE_STREAM_CHUNK", "65536"))
PRICE_STREAM_MAX_BYTES = int(os.getenv("PRICE_STREAM_MAX_BYTES", "1000000"))
PRICE_CHECK_EVERY_BYTES = int(os.getenv("PRICE_CHECK_EVERY_BYTES", "131072"))
AOD_PRICE_MAX_BYTES = int(os.getenv("AOD_PRICE_MAX_BYTES", "65536"))
AOD_PARSE_CHECK_EVERY = int(os.getenv("AOD_PARSE_CHECK_EVERY", "8192"))
PRICE_FETCH_AOD_ATTEMPTS = int(os.getenv("PRICE_FETCH_AOD_ATTEMPTS", "3"))
PRICE_FETCH_DP_FALLBACK = os.getenv("PRICE_FETCH_DP_FALLBACK", "true").lower() not in (
    "0",
    "false",
    "no",
)
FINDER_AOD_MAX_BYTES = int(os.getenv("FINDER_AOD_MAX_BYTES", "49152"))
FINDER_AOD_RETRIES = int(os.getenv("FINDER_AOD_RETRIES", "3"))
FINDER_AOD_PARSE_EVERY = int(os.getenv("FINDER_AOD_PARSE_EVERY", "4096"))
FINDER_AOD_ALL_OFFERS_BYTES = int(os.getenv("FINDER_AOD_ALL_OFFERS_BYTES", "98304"))
FINDER_PRICE_RETRY_PASS = os.getenv("FINDER_PRICE_RETRY_PASS", "true").lower() in (
    "1",
    "true",
    "yes",
)
FINDER_PRICE_DP_FALLBACK = os.getenv("FINDER_PRICE_DP_FALLBACK", "true").lower() in (
    "1",
    "true",
    "yes",
)
FINDER_DP_STREAM_MAX_BYTES = int(os.getenv("FINDER_DP_STREAM_MAX_BYTES", "98304"))

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
]

# Correct AOD endpoint (ref=dp_aod_ALL_mbc returns 404)
AOD_URL = "https://www.amazon.com/gp/product/ajax/aodAjaxMain/"
FULL_PAGE_BASE = "https://www.amazon.com/dp/{asin}"


def _aod_params(asin: str, *, all_offers: bool | None = None) -> dict[str, str]:
    # filters all=false → buy box / featured offer only (~8–15KB)
    # filters all=true  → full seller list (~100–140KB)
    if all_offers is None:
        filters_all = os.getenv("AOD_FILTERS_ALL", "false").lower() in (
            "1",
            "true",
            "yes",
        )
    else:
        filters_all = all_offers
    filters = '{"all":true}' if filters_all else '{"all":false}'
    return {
        "asin": asin,
        "pageno": "1",
        "language": "en_US",
        "marketplace": "ATVPDKIKX0DER",
        "filters": filters,
    }


def _full_page_params() -> dict[str, str]:
    return {"language": "en_US", "th": "1", "psc": "1"}


def _aod_headers(referer: str) -> dict[str, str]:
    return {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Referer": referer,
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
    }


def _full_page_headers() -> dict[str, str]:
    return {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
        "Cache-Control": "no-cache",
    }


def _proxies() -> dict | None:
    proxy = get_proxy_url()
    return {"http": proxy, "https": proxy} if proxy else None


def _parse_last_full_fetch(value: Optional[datetime | str]) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value
    try:
        s = str(value).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def needs_full_page(
    *,
    force_full_page: bool = False,
    last_full_fetch: Optional[datetime | str] = None,
) -> bool:
    if force_full_page:
        return True
    parsed = _parse_last_full_fetch(last_full_fetch)
    if parsed is None:
        return True
    age = (datetime.now(timezone.utc) - parsed).total_seconds()
    return age > FULL_FETCH_TTL_SEC


def _result_has_data(result: dict | None, *, aod_only: bool = False) -> bool:
    if not result:
        return False
    if result.get("error"):
        return False
    if aod_only:
        if result.get("price") is not None:
            return True
        stock = str(result.get("stock") or "")
        return stock not in ("", "Unknown")
    if result.get("title"):
        return True
    if result.get("price") is not None:
        return True
    if len(result.get("bullet_points") or []) > 0:
        return True
    if len(result.get("images") or []) > 0:
        return True
    return False


async def _warm_session(session: AsyncSession, proxies: dict | None) -> bool:
    try:
        resp = await session.get(
            "https://www.amazon.com/",
            headers=_full_page_headers(),
            proxies=proxies,
            impersonate="chrome120",
            timeout=20,
        )
        return resp.status_code < 400 and len(resp.text) > 1000
    except Exception:
        return False


async def _fetch_aod_html(
    session: AsyncSession,
    asin: str,
    *,
    proxies: dict | None = None,
    max_attempts: int = 3,
    timeout: int = 15,
) -> tuple[str | None, int]:
    if proxies is None:
        proxies = _proxies()

    dp_url = f"https://www.amazon.com/dp/{asin}"
    headers = _aod_headers(dp_url)

    for attempt in range(max_attempts):
        try:
            resp = await session.get(
                AOD_URL,
                params=_aod_params(asin),
                headers=headers,
                proxies=proxies,
                impersonate="chrome120",
                timeout=timeout,
            )
            body = resp.text
            nbytes = len(body.encode("utf-8", errors="replace"))
            if is_blocked_html(body):
                await asyncio.sleep(min(2**attempt, 4))
                continue
            if resp.status_code == 404 and not has_aod_signals(body):
                return None, 0
            if resp.status_code >= 400 and not has_aod_signals(body):
                await asyncio.sleep(min(2**attempt, 2))
                continue
            if has_aod_signals(body):
                return body, nbytes
        except Exception as exc:
            logger.warning("AOD fetch %s attempt %s: %s", asin, attempt + 1, exc)
            await asyncio.sleep(min(2**attempt, 2))
    return None, 0


async def _fetch_aod_minimal(
    session: AsyncSession,
    asin: str,
    *,
    proxies: dict | None = None,
    max_bytes: int | None = None,
    timeout: int = 15,
    parse_every: int | None = None,
    all_offers: bool = False,
) -> tuple[dict | None, int]:
    """
    Stream AOD (filters all=false) and stop as soon as buy-box price is parsed.
    Caps download (default 64KB) so 300KB seller lists are not fully read.
    """
    if proxies is None:
        proxies = _proxies()
    cap = max_bytes if max_bytes is not None else AOD_PRICE_MAX_BYTES
    parse_step = parse_every if parse_every is not None else AOD_PARSE_CHECK_EVERY

    dp_url = f"https://www.amazon.com/dp/{asin}"
    headers = _aod_headers(dp_url)
    buf = bytearray()
    bytes_read = 0
    last_parse_at = 0
    best_data: dict | None = None

    try:
        resp = await session.get(
            AOD_URL,
            params=_aod_params(asin, all_offers=all_offers),
            headers=headers,
            proxies=proxies,
            impersonate="chrome120",
            timeout=timeout,
            stream=True,
        )
        try:
            if resp.status_code >= 400:
                return None, 0

            async for chunk in resp.aiter_content(chunk_size=8192):
                if not chunk:
                    continue
                bytes_read += len(chunk)
                buf.extend(chunk)

                if bytes_read - last_parse_at >= parse_step:
                    last_parse_at = bytes_read
                    text = bytes(buf).decode("utf-8", errors="replace")
                    if is_blocked_html(text, partial=True):
                        return None, bytes_read
                    if has_aod_signals(text):
                        parsed = parse_aod(text, asin=asin)
                        if parsed.get("price") is not None:
                            best_data = parsed
                            break
                        offers = parsed.get("all_offer_prices") or []
                        if offers:
                            best_data = {**parsed, "price": min(offers)}
                            break

                if bytes_read >= cap:
                    break
        finally:
            try:
                await resp.aclose()
            except Exception:
                pass

        if not buf:
            return None, bytes_read

        text = bytes(buf).decode("utf-8", errors="replace")
        if is_captcha_html(text):
            return None, bytes_read
        if not has_aod_signals(text):
            return None, bytes_read

        if best_data is None:
            best_data = parse_aod(text, asin=asin)

        if best_data.get("price") is None:
            offers = best_data.get("all_offer_prices") or []
            if offers:
                best_data = {**best_data, "price": min(offers)}
            else:
                return None, bytes_read

        return best_data, bytes_read
    except Exception as exc:
        logger.warning("AOD minimal %s: %s", asin, exc)
        return None, bytes_read


async def _fetch_dp_price_stream(
    session: AsyncSession,
    asin: str,
    *,
    proxies: dict | None = None,
    timeout: int = 25,
    max_bytes: int | None = None,
) -> tuple[str | None, int]:
    """
    Stream /dp until buy-box price is parseable, then abort download.
    Amazon ignores Range headers; closing the stream early is the only way to cap bytes.
    """
    if proxies is None:
        proxies = _proxies()
    cap = max_bytes if max_bytes is not None else PRICE_STREAM_MAX_BYTES

    url = FULL_PAGE_BASE.format(asin=asin)
    buf = bytearray()
    bytes_read = 0
    last_check = 0

    try:
        resp = await session.get(
            url,
            params=_full_page_params(),
            headers=_full_page_headers(),
            proxies=proxies,
            impersonate="chrome120",
            timeout=timeout,
            stream=True,
        )
        try:
            if resp.status_code >= 400:
                return None, 0

            async for chunk in resp.aiter_content(chunk_size=PRICE_STREAM_CHUNK):
                if not chunk:
                    continue
                bytes_read += len(chunk)
                buf.extend(chunk)

                if bytes_read - last_check >= PRICE_CHECK_EVERY_BYTES:
                    last_check = bytes_read
                    text = bytes(buf).decode("utf-8", errors="replace")
                    if is_blocked_html(text, partial=True):
                        return None, bytes_read
                    offer = parse_product_page_offer(text)
                    if offer.get("price") is not None:
                        logger.debug(
                            "price stream %s stopped at %s bytes", asin, bytes_read
                        )
                        break

                if bytes_read >= cap:
                    break
        finally:
            try:
                await resp.aclose()
            except Exception:
                pass

        if not buf:
            return None, bytes_read

        text = bytes(buf).decode("utf-8", errors="replace")
        if is_captcha_html(text):
            return None, bytes_read
        return text, bytes_read
    except Exception as exc:
        logger.warning("price stream %s failed: %s", asin, exc)
        return None, bytes_read


async def _fetch_full_page_html(
    session: AsyncSession,
    asin: str,
    *,
    proxies: dict | None = None,
    max_attempts: int = 3,
    timeout: int = 20,
) -> tuple[str | None, int]:
    if proxies is None:
        proxies = _proxies()

    url = FULL_PAGE_BASE.format(asin=asin)
    headers = _full_page_headers()

    for attempt in range(max_attempts):
        try:
            resp = await session.get(
                url,
                params=_full_page_params(),
                headers=headers,
                proxies=proxies,
                impersonate="chrome120",
                timeout=timeout,
            )
            body = resp.text
            if is_blocked_html(body):
                await asyncio.sleep(min(2**attempt, 4))
                continue
            if resp.status_code == 404 and not has_product_signals(body):
                return None, 0
            if resp.status_code >= 400 and not has_product_signals(body):
                await asyncio.sleep(min(2**attempt, 2))
                continue
            if has_product_signals(body):
                return body, len(body.encode("utf-8", errors="replace"))
        except Exception as exc:
            logger.warning("full page %s attempt %s: %s", asin, attempt + 1, exc)
            await asyncio.sleep(min(2**attempt, 2))
    return None, 0


async def _try_fetch_aod(
    session: AsyncSession, asin: str, *, proxies: dict | None
) -> tuple[dict | None, int]:
    if SKIP_AOD:
        return None, 0
    aod_html, nbytes = await _fetch_aod_html(
        session, asin, proxies=proxies, max_attempts=3, timeout=15
    )
    if not aod_html:
        return None, nbytes
    aod_data = parse_aod(aod_html, asin=asin)
    if _result_has_data(aod_data, aod_only=True):
        return aod_data, nbytes
    return None, nbytes


def _price_fields_from_sources(
    aod_data: dict | None, page_html: str | None
) -> dict | None:
    """AOD first; if Amazon returns 404 on AOD, parse buy box from /dp HTML."""
    if aod_data and _result_has_data(aod_data, aod_only=True):
        return aod_data
    if page_html and has_product_signals(page_html):
        offer = parse_product_page_offer(page_html)
        if _result_has_data(offer, aod_only=True):
            return offer
    return None


def _merge_aod_over_full(full_data: dict, aod_data: dict) -> dict:
    """AOD price/stock overrides full page offer parsing."""
    merged = {**full_data}
    for key in (
        "price",
        "stock",
        "is_in_stock",
        "buy_box_seller",
        "is_amazon_fulfilled",
        "all_offer_prices",
    ):
        val = aod_data.get(key)
        if val is not None and val != "" and val != "Unknown":
            merged[key] = val
    return merged


def _finalize_result(
    asin: str,
    result: dict,
    *,
    fetch_type: str,
    full_fetch: bool,
    bytes_downloaded: int = 0,
) -> dict:
    result.update(
        {
            "asin": asin,
            "title": result.get("title"),
            "description": result.get("description"),
            "about_text": result.get("about_text"),
            "bullet_points": result.get("bullet_points") or [],
            "attributes": result.get("attributes") or {},
            "dimensions": result.get("dimensions"),
            "images": result.get("images") or [],
            "rating": result.get("rating"),
            "reviews_count": result.get("reviews_count"),
            "brand": result.get("brand"),
            "scraped_at": datetime.now(timezone.utc).isoformat(),
            "fetch_type": fetch_type,
            "full_fetch": full_fetch,
            "bytes_downloaded": bytes_downloaded,
        }
    )
    return result


async def scrape_asin_in_session(
    session: AsyncSession,
    asin: str,
    *,
    force_full_page: bool = False,
    last_full_fetch: Optional[datetime | str] = None,
    fast: bool = False,
    proxies: dict | None = None,
    skip_warm: bool = False,
) -> dict | None:
    """
    Price refresh: stream /dp until price found (~0.9–1MB, not full 1.8MB).
    First fetch / stale >24h: one full /dp for title/images (unavoidable without working AOD).
    """
    asin = asin.upper().strip()
    if proxies is None:
        proxies = _proxies()

    want_full = needs_full_page(
        force_full_page=force_full_page, last_full_fetch=last_full_fetch
    )
    max_attempts = 2 if fast else 3

    for attempt in range(max_attempts):
        if not skip_warm and not await _warm_session(session, proxies):
            await asyncio.sleep(0.4 + attempt * 0.3)
            continue

        bytes_dl = 0

        # Tier 1: AOD (~5–120KB) — correct endpoint aodAjaxMain
        aod_data, aod_bytes = await _try_fetch_aod(session, asin, proxies=proxies)
        bytes_dl += aod_bytes

        if not want_full and aod_data and _result_has_data(aod_data, aod_only=True):
            return _finalize_result(
                asin,
                aod_data,
                fetch_type="aod",
                full_fetch=False,
                bytes_downloaded=bytes_dl,
            )

        if want_full:
            page_html, dp_bytes = await _fetch_full_page_html(
                session, asin, proxies=proxies, max_attempts=2, timeout=28
            )
            bytes_dl += dp_bytes
            if not page_html:
                if aod_data and _result_has_data(aod_data, aod_only=True):
                    return _finalize_result(
                        asin,
                        aod_data,
                        fetch_type="aod",
                        full_fetch=False,
                        bytes_downloaded=bytes_dl,
                    )
                await asyncio.sleep(0.5 + attempt * 0.4)
                continue

            price_data = _price_fields_from_sources(aod_data, page_html)
            if not price_data:
                await asyncio.sleep(0.4 + attempt * 0.35)
                continue

            full_data = parse_full_page(page_html)
            merged = _merge_aod_over_full(full_data, price_data)
            if _result_has_data(merged, aod_only=False):
                return _finalize_result(
                    asin,
                    merged,
                    fetch_type="full",
                    full_fetch=True,
                    bytes_downloaded=bytes_dl,
                )
            if _result_has_data(price_data, aod_only=True):
                return _finalize_result(
                    asin,
                    price_data,
                    fetch_type="aod" if aod_data else "dp_offer",
                    full_fetch=False,
                    bytes_downloaded=bytes_dl,
                )
            continue

        # Price refresh: AOD had no price — stream /dp fallback
        if aod_data and _result_has_data(aod_data, aod_only=True):
            return _finalize_result(
                asin,
                aod_data,
                fetch_type="aod",
                full_fetch=False,
                bytes_downloaded=bytes_dl,
            )

        page_html, stream_bytes = await _fetch_dp_price_stream(
            session, asin, proxies=proxies
        )
        bytes_dl += stream_bytes
        if page_html:
            price_data = _price_fields_from_sources(None, page_html)
            if price_data:
                return _finalize_result(
                    asin,
                    price_data,
                    fetch_type="dp_stream",
                    full_fetch=False,
                    bytes_downloaded=bytes_dl,
                )
        await asyncio.sleep(0.5 + attempt * 0.4)

    return None


async def scrape_price_only(asin: str) -> dict | None:
    """
    Price + stock only with retries:
      1) Streamed AOD (up to PRICE_FETCH_AOD_ATTEMPTS, default 3)
      2) Full AOD fragment if stream had no price
      3) Stream /dp buy box (optional, PRICE_FETCH_DP_FALLBACK)
    """
    asin = asin.upper().strip()
    async with AsyncSession() as session:
        proxies = _proxies()
        bytes_dl = 0

        for attempt in range(max(1, PRICE_FETCH_AOD_ATTEMPTS)):
            aod_data, nbytes = await _fetch_aod_minimal(
                session, asin, proxies=proxies
            )
            bytes_dl += nbytes
            if aod_data and aod_data.get("price") is not None:
                return _finalize_result(
                    asin,
                    aod_data,
                    fetch_type="aod",
                    full_fetch=False,
                    bytes_downloaded=bytes_dl,
                )
            if attempt < PRICE_FETCH_AOD_ATTEMPTS - 1:
                logger.info(
                    "price-only %s: AOD attempt %s no price, retrying",
                    asin,
                    attempt + 1,
                )
                await asyncio.sleep(0.5 + attempt * 0.35)

        # Fallback: full AOD response (sometimes stream stops before buy box HTML)
        aod_html, aod_bytes = await _fetch_aod_html(
            session, asin, proxies=proxies, max_attempts=2, timeout=18
        )
        bytes_dl += aod_bytes
        if aod_html and has_aod_signals(aod_html):
            aod_data = parse_aod(aod_html, asin=asin)
            if aod_data.get("price") is not None:
                logger.info("price-only %s: price from full AOD fallback", asin)
                return _finalize_result(
                    asin,
                    aod_data,
                    fetch_type="aod",
                    full_fetch=False,
                    bytes_downloaded=bytes_dl,
                )

        if PRICE_FETCH_DP_FALLBACK:
            logger.info("[INFO] aod_empty_fallback asin=%s — trying /dp stream", asin)
            page_html, stream_bytes = await _fetch_dp_price_stream(
                session, asin, proxies=proxies
            )
            bytes_dl += stream_bytes
            if page_html:
                offer = parse_product_page_offer(page_html)
                if offer.get("price") is not None:
                    logger.info("price-only %s: price from /dp stream fallback", asin)
                    return _finalize_result(
                        asin,
                        offer,
                        fetch_type="dp_stream",
                        full_fetch=False,
                        bytes_downloaded=bytes_dl,
                    )

        return None


async def scrape_price_only_finder(asin: str) -> dict | None:
    """Single-ASIN price fetch (legacy); prefer fetch_finder_prices_batch for lists."""
    async with AsyncSession() as session:
        return await scrape_price_only_finder_in_session(session, asin)


async def scrape_price_only_finder_in_session(
    session: AsyncSession,
    asin: str,
    *,
    proxies: dict | None = None,
) -> dict | None:
    """
    Product Finder price fetch — streamed AOD (~28KB), all-offers AOD, /dp fallback.
    """
    asin = asin.upper().strip()
    if proxies is None:
        proxies = _proxies()
    bytes_dl = 0

    for attempt in range(max(1, FINDER_AOD_RETRIES)):
        aod_data, nbytes = await _fetch_aod_minimal(
            session,
            asin,
            proxies=proxies,
            max_bytes=FINDER_AOD_MAX_BYTES,
            parse_every=FINDER_AOD_PARSE_EVERY,
        )
        bytes_dl += nbytes
        if aod_data and aod_data.get("price") is not None:
            return _finalize_result(
                asin,
                aod_data,
                fetch_type="aod",
                full_fetch=False,
                bytes_downloaded=bytes_dl,
            )
        if attempt < FINDER_AOD_RETRIES - 1:
            await asyncio.sleep(0.2 + attempt * 0.15)

    if FINDER_PRICE_DP_FALLBACK:
        aod_all, nbytes = await _fetch_aod_minimal(
            session,
            asin,
            proxies=proxies,
            max_bytes=FINDER_AOD_ALL_OFFERS_BYTES,
            parse_every=FINDER_AOD_PARSE_EVERY,
            all_offers=True,
        )
        bytes_dl += nbytes
        if aod_all and aod_all.get("price") is not None:
            return _finalize_result(
                asin,
                aod_all,
                fetch_type="aod_all",
                full_fetch=False,
                bytes_downloaded=bytes_dl,
            )

    if FINDER_PRICE_DP_FALLBACK:
        page_html, stream_bytes = await _fetch_dp_price_stream(
            session,
            asin,
            proxies=proxies,
            max_bytes=FINDER_DP_STREAM_MAX_BYTES,
        )
        bytes_dl += stream_bytes
        if page_html:
            offer = parse_product_page_offer(page_html)
            if offer.get("price") is not None:
                return _finalize_result(
                    asin,
                    offer,
                    fetch_type="dp_stream",
                    full_fetch=False,
                    bytes_downloaded=bytes_dl,
                )

    return None


async def fetch_finder_prices_batch(
    asins: list[str], concurrency: int = 50
) -> list[dict]:
    """Batch AOD/dp-stream prices — up to 1000 ASINs with warmed session pool."""
    unique = list(dict.fromkeys(a.strip().upper() for a in asins if a and len(a.strip()) == 10))
    unique = unique[:FINDER_PRICE_MAX_ASINS]
    if not unique:
        return []
    sem_limit = max(1, min(concurrency, FINDER_PRICE_MAX_CONCURRENCY))
    task_sem = asyncio.Semaphore(sem_limit)
    pool_size = min(
        FINDER_PRICE_SESSION_POOL,
        max(4, len(unique) // 25),
    )

    sessions: list[AsyncSession] = []
    proxies_list: list[dict | None] = []
    result_map: dict[str, dict] = {}
    try:
        for _ in range(pool_size):
            sessions.append(AsyncSession())
            px = _proxies()
            proxies_list.append(px)
            await _warm_session(sessions[-1], px)

        async def _one(asin: str, index: int, delay: float = 0) -> dict | None:
            if delay > 0:
                await asyncio.sleep(delay)
            async with task_sem:
                sess = sessions[index % pool_size]
                px = proxies_list[index % pool_size]
                await asyncio.sleep(random.random() * 0.04)
                return await scrape_price_only_finder_in_session(sess, asin, proxies=px)

        logger.info(
            "Price batch: %s ASINs, concurrency=%s, sessions=%s",
            len(unique),
            sem_limit,
            pool_size,
        )
        results = await asyncio.gather(*[_one(a, i) for i, a in enumerate(unique)])
        for r in results:
            if r and r.get("asin"):
                result_map[r["asin"]] = r

        if FINDER_PRICE_RETRY_PASS:
            failed = [
                a for a in unique if not result_map.get(a) or result_map[a].get("price") is None
            ]
            if failed:
                logger.info("Price retry pass for %s ASINs", len(failed))
                await asyncio.sleep(1.0)
                retry_results = await asyncio.gather(
                    *[_one(a, i, delay=0.18 * (i % 6)) for i, a in enumerate(failed)]
                )
                for r in retry_results:
                    if r and r.get("asin") and r.get("price") is not None:
                        result_map[r["asin"]] = r

        return list(result_map.values())
    finally:
        for sess in sessions:
            try:
                await sess.close()
            except Exception:
                pass


async def scrape_price_only_fast(asin: str) -> dict | None:
    """Single streamed AOD read (~24 KB cap), no retries or /dp fallback."""
    asin = asin.upper().strip()
    async with AsyncSession() as session:
        proxies = _proxies()
        aod_data, nbytes = await _fetch_aod_minimal(
            session, asin, proxies=proxies, max_bytes=24_576
        )
        if aod_data and aod_data.get("price") is not None:
            return _finalize_result(
                asin,
                aod_data,
                fetch_type="aod",
                full_fetch=False,
                bytes_downloaded=nbytes,
            )
        return None


async def scrape_asin(
    asin: str,
    *,
    force_full_page: bool = False,
    last_full_fetch: Optional[datetime | str] = None,
    fast: bool = False,
    # Legacy API compat
    full_page: bool | None = None,
) -> dict | None:
    if full_page is not None:
        force_full_page = full_page
    async with AsyncSession() as session:
        return await scrape_asin_in_session(
            session,
            asin,
            force_full_page=force_full_page,
            last_full_fetch=last_full_fetch,
            fast=fast,
            skip_warm=False,
        )


async def scrape_asin_batch(
    asins: list[str],
    *,
    full_page: bool = False,
    fast: bool = True,
    concurrency: int | None = None,
    full_page_asins: list[str] | None = None,
    last_full_fetch_by_asin: dict[str, str | None] | None = None,
) -> list[dict]:
    normalized = [a.upper().strip() for a in asins if a and len(a.strip()) >= 10]
    if not normalized:
        return []

    if full_page_asins is not None:
        full_set = {a.upper().strip() for a in full_page_asins}
    elif full_page:
        full_set = set(normalized)
    else:
        full_set = set()

    last_fetch_map = last_full_fetch_by_asin or {}

    sem_limit = min(concurrency or BULK_CONCURRENCY, 60)
    task_sem = asyncio.Semaphore(sem_limit)
    pool_size = min(BULK_SESSION_POOL, max(2, len(normalized) // 15))

    sessions: list[AsyncSession] = []
    proxies_list: list[dict | None] = []
    try:
        for _ in range(pool_size):
            sessions.append(AsyncSession())
            px = _proxies()
            proxies_list.append(px)
            await _warm_session(sessions[-1], px)

        async def _one(asin: str, index: int) -> dict:
            async with task_sem:
                force_full = asin in full_set
                last_ff = last_fetch_map.get(asin)
                sess = sessions[index % pool_size]
                px = proxies_list[index % pool_size]
                last: dict | None = None

                for attempt in range(BULK_RETRY_ATTEMPTS):
                    try:
                        last = await scrape_asin_in_session(
                            sess,
                            asin,
                            force_full_page=force_full,
                            last_full_fetch=last_ff,
                            fast=fast,
                            proxies=px,
                            skip_warm=True,
                        )
                    except Exception as exc:
                        logger.warning(
                            "batch asin %s attempt %s: %s", asin, attempt + 1, exc
                        )
                        last = None

                    aod_only = not force_full and not needs_full_page(
                        last_full_fetch=last_ff
                    )
                    if _result_has_data(last, aod_only=aod_only):
                        return last  # type: ignore[return-value]

                    await asyncio.sleep(
                        0.35 + random.random() * 0.65 + attempt * 0.25
                    )

                if last:
                    last.setdefault("bytes_downloaded", 0)
                    last.setdefault("asin", asin)
                    return last
                return {
                    "asin": asin,
                    "error": "not_found",
                    "bytes_downloaded": 0,
                    "scraped_at": datetime.now(timezone.utc).isoformat(),
                }

        return await asyncio.gather(*[_one(a, i) for i, a in enumerate(normalized)])
    finally:
        for s in sessions:
            try:
                await s.close()
            except Exception:
                pass
