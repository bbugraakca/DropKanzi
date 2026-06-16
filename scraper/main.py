import asyncio
import logging
import os
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from scraper import (
    scrape_asin,
    scrape_asin_batch,
    scrape_price_only,
    scrape_price_only_finder,
    fetch_finder_prices_batch,
)
from asin_util import is_plausible_asin

from ebay_scraper import (
    scrape_seller_sold_listings,
    scrape_seller_active_listings,
    seller_exists,
    diagnose_seller_scrape,
    resolve_ebay_seller_id,
    parse_ebay_seller_input,
)
from amazon_matcher import match_listings_batch, MIN_MATCH_CONFIDENCE, FINDER_MAX_MATCH_GROUPS
from profit_calculator import calculate_batch
import proxy_meter
import match_cache
from amazon_search import reset_captcha_streak, reset_serp_meter, summarize_serp_meter
from image_match import warmup as match_score_warmup

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await match_score_warmup()
    yield


app = FastAPI(title="PriceHawk Scraper", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ScrapeRequest(BaseModel):
    asin: str = Field(min_length=10, max_length=10)
    full_page: bool = False
    fast: bool = False
    last_full_fetch: Optional[str] = None  # ISO8601 from DB fullFetchAt


class BatchScrapeRequest(BaseModel):
    asins: list[str]
    full_page: bool = False
    full_page_asins: list[str] | None = None
    last_full_fetch_by_asin: dict[str, str | None] | None = None
    fast: bool = True
    concurrency: int | None = None


MAX_FINDER_LISTINGS = 5000  # safety cap only — scrape stops naturally when eBay has no more pages

# Fetch Amazon AOD price during analyze (per matched ASIN). Set false to save proxy.
FINDER_FETCH_PRICES_ON_ANALYZE = os.getenv(
    "FINDER_FETCH_PRICES_ON_ANALYZE", "true"
).lower() not in ("0", "false", "no")
FINDER_PRICE_CONCURRENCY = int(os.getenv("FINDER_PRICE_CONCURRENCY", "50"))
FINDER_PRICE_MAX_ASINS = int(os.getenv("FINDER_PRICE_MAX_ASINS", "1000"))
MATCH_CONCURRENCY = int(os.getenv("FINDER_MATCH_CONCURRENCY", "20"))

# Active/live inventory scans cover the seller's FULL store:
# bigger listing cap and no unique-title match cap (0 = unlimited).
ACTIVE_MAX_LISTINGS = int(os.getenv("FINDER_ACTIVE_MAX_LISTINGS", "10000"))
ACTIVE_MAX_MATCH_GROUPS = int(os.getenv("FINDER_ACTIVE_MAX_MATCH_GROUPS", "0"))


class ProductFinderRequest(BaseModel):
    seller: str
    days_back: int = 30
    store_settings: dict = Field(default_factory=dict)
    fetch_prices: bool = FINDER_FETCH_PRICES_ON_ANALYZE
    force_refresh: bool = False


class ProductFinderActiveRequest(BaseModel):
    seller: str
    store_settings: dict = Field(default_factory=dict)
    fetch_prices: bool = FINDER_FETCH_PRICES_ON_ANALYZE
    force_refresh: bool = False
    max_items: int = 0  # 0 → ACTIVE_MAX_LISTINGS


class ProductFinderPricesRequest(BaseModel):
    asins: list[str] = Field(default_factory=list)


async def _fetch_prices_batch(asins: list[str], concurrency: int) -> list[dict]:
    """Minimal AOD price fetch for Product Finder (~28KB/ASIN)."""
    return await fetch_finder_prices_batch(asins, concurrency=concurrency)


@app.get("/stats/bandwidth")
async def stats_bandwidth():
    return proxy_meter.get_bandwidth_totals()


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/")
async def root():
    return {
        "service": "PriceHawk Scraper",
        "health": "/health",
        "scrape": "POST /scrape",
        "strategy": {
            "tier1_aod": "~8KB — price/stock every request",
            "tier2_full": "~150-500KB — title/images when fullFetchAt null or >24h",
        },
    }


@app.post("/scrape/price")
async def scrape_price(req: ScrapeRequest):
    """Minimal price + stock: streamed AOD, ~8–64KB."""
    asin = req.asin.strip().upper()
    result = await scrape_price_only(asin)
    if result is None:
        raise HTTPException(
            status_code=404,
            detail="Price check failed — no buy box price in AOD response.",
        )
    return result


@app.post("/scrape")
async def scrape(req: ScrapeRequest):
    asin = req.asin.strip().upper()
    result = await scrape_asin(
        asin,
        force_full_page=req.full_page,
        last_full_fetch=req.last_full_fetch,
        fast=req.fast,
    )
    if result is None:
        raise HTTPException(
            status_code=404,
            detail="Amazon blocked or product unavailable. Check ASIN (10 chars) and proxy.",
        )
    return result


@app.post("/scrape/batch")
async def scrape_batch_endpoint(req: BatchScrapeRequest):
    if len(req.asins) > 1000:
        raise HTTPException(status_code=400, detail="Max 1000 ASINs per batch")
    results = await scrape_asin_batch(
        req.asins,
        full_page=req.full_page,
        fast=req.fast,
        concurrency=req.concurrency,
        full_page_asins=req.full_page_asins,
        last_full_fetch_by_asin=req.last_full_fetch_by_asin,
    )
    return results


@app.get("/product-finder/seller-info/{seller}")
async def product_finder_seller_info(seller: str):
    exists = await seller_exists(seller)
    return {"seller": seller, "exists": exists}


@app.post("/product-finder/prices")
async def product_finder_prices(req: ProductFinderPricesRequest):
    """Fast AOD price fetch for a list of ASINs (Found products refresh)."""
    asins = list(
        dict.fromkeys(
            a.strip().upper()
            for a in req.asins
            if a and is_plausible_asin(a.strip().upper())
        )
    )[:FINDER_PRICE_MAX_ASINS]
    if not asins:
        return {"prices": {}}
    proxy_meter.start()
    proxy_meter.stage("amazon_price")
    results = await _fetch_prices_batch(asins, concurrency=FINDER_PRICE_CONCURRENCY)
    by_asin = {r["asin"]: r for r in results if r.get("asin")}
    for r in results:
        proxy_meter.add(int(r.get("bytes_downloaded") or 0))
    loaded = sum(1 for a in asins if by_asin.get(a, {}).get("price") is not None)
    failed = len(asins) - loaded
    if failed:
        logging.info(
            "product-finder/prices: loaded=%d failed=%d of %d ASINs",
            loaded,
            failed,
            len(asins),
        )
    prices = {
        asin: {
            "price": by_asin[asin].get("price") if asin in by_asin else None,
            "stock": by_asin[asin].get("stock") if asin in by_asin else None,
            "amazon_url": f"https://www.amazon.com/dp/{asin}",
        }
        for asin in asins
    }
    return {"prices": prices, "prices_loaded": loaded, "prices_failed": failed, **proxy_meter.summarize()}


@app.post("/product-finder/analyze")
async def product_finder_analyze(req: ProductFinderRequest):
    """Pipeline: eBay sold listings → ASIN match → Amazon price → profit."""
    try:
        return await _product_finder_analyze_inner(req)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logging.exception("product-finder/analyze failed for %s", req.seller)
        raise HTTPException(
            status_code=503,
            detail=f"Analysis crashed: {type(exc).__name__}: {str(exc)[:240]}",
        ) from exc


@app.post("/product-finder/analyze-active")
async def product_finder_analyze_active(req: ProductFinderActiveRequest):
    """Pipeline: eBay active/live listings → ASIN match → Amazon price → profit."""
    try:
        return await _product_finder_analyze_active_inner(req)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logging.exception("product-finder/analyze-active failed for %s", req.seller)
        raise HTTPException(
            status_code=503,
            detail=f"Active analysis crashed: {type(exc).__name__}: {str(exc)[:240]}",
        ) from exc


async def _product_finder_analyze_inner(req: ProductFinderRequest):
    seller_input = req.seller.strip()
    if not seller_input:
        raise HTTPException(status_code=400, detail="seller is required")

    parsed = parse_ebay_seller_input(seller_input)
    seller = parsed["display"]
    ebay_ssn_hint = parsed.get("ebay_ssn")
    store_name_hint = parsed.get("store_name")

    # Start a fresh proxy-cost meter for this analysis.
    proxy_meter.start()
    reset_serp_meter()
    reset_captcha_streak()
    if req.force_refresh:
        cleared_miss = match_cache.clear_miss_cache()
        if cleared_miss:
            logging.info("Force refresh: cleared %s cached no-match entries", cleared_miss)
    if os.getenv("FINDER_CLEAR_MATCH_CACHE", "false").lower() in ("1", "true", "yes"):
        cleared = match_cache.clear_misses()
        if cleared:
            logging.info("Cleared %s stale low-confidence match cache entries", cleared)

    # 1) Resolve store display name -> real eBay _ssn, then scrape sold pages.
    proxy_meter.stage("ebay_search")
    resolution = await resolve_ebay_seller_id(
        seller,
        ebay_ssn_hint=ebay_ssn_hint,
        store_name_hint=store_name_hint,
    )
    ebay_ssn = resolution["ebay_ssn"]
    store_name = resolution.get("store_name") or store_name_hint
    listings: list[dict] = []
    for attempt in range(5):
        listings = await scrape_seller_sold_listings(
            seller,
            days_back=req.days_back,
            max_items=MAX_FINDER_LISTINGS,
            ebay_ssn=ebay_ssn,
            store_name=store_name,
        )
        if listings:
            break
        if not resolution.get("resolved"):
            resolution = await resolve_ebay_seller_id(
                seller,
                ebay_ssn_hint=ebay_ssn_hint,
                store_name_hint=store_name_hint,
            )
            ebay_ssn = resolution["ebay_ssn"]
            store_name = resolution.get("store_name") or store_name_hint
        if attempt < 4:
            await asyncio.sleep(2.5 * (attempt + 1))
    if not listings:
        diag = await diagnose_seller_scrape(seller, req.days_back)
        return {
            "seller": seller,
            "listings": [],
            "summary": {
                **_empty_summary(),
                "ebay_status": diag.get("status"),
                "ebay_message": diag.get("message"),
                "ebay_verify_url": diag.get("verify_url"),
                "ebay_active_listings": diag.get("active_listings"),
                "ebay_seller_id": diag.get("ebay_seller_id") or ebay_ssn,
                "ebay_store_resolved": resolution.get("resolved"),
                **proxy_meter.summarize(),
            },
        }

    truncated = len(listings) >= MAX_FINDER_LISTINGS

    # 2) Match via Amazon search (SERP capped at ~96 KB each; Redis title cache).
    for i, l in enumerate(listings):
        l["_idx"] = i
    proxy_meter.stage("amazon_search")
    unmatched = [l for l in listings if not l.get("amazon_asin")]
    match_stats = {"groups_total": 0, "groups_attempted": 0, "groups_skipped": 0, "captcha_aborted": False}
    if unmatched:
        matched_extra, match_stats = await match_listings_batch(
            unmatched,
            concurrency=MATCH_CONCURRENCY,
            max_groups=FINDER_MAX_MATCH_GROUPS,
            skip_miss_cache=req.force_refresh,
        )
        for m in matched_extra:
            listings[m["_idx"]] = m
    for l in listings:
        l.pop("_idx", None)

    # Drop weak matches — only keep ≥80% confidence (description ASINs stay at 1.0).
    for l in listings:
        if not l.get("amazon_asin"):
            continue
        method = l.get("match_method")
        conf = l.get("match_confidence")
        if method == "description":
            if conf is None:
                l["match_confidence"] = 1.0
            continue
        if conf is None:
            l["amazon_asin"] = None
            l["match_confidence"] = 0.0
            continue
        if float(conf) < MIN_MATCH_CONFIDENCE:
            l["amazon_asin"] = None
            l["match_confidence"] = float(conf)

    # 3) Amazon live prices — AOD for each unique matched ASIN (≥80% confidence).
    prices_fetched = False
    prices_loaded = 0
    prices_from_serp = 0
    matched_for_price = [
        l
        for l in listings
        if l.get("amazon_asin")
        and (
            l.get("match_method") == "description"
            or float(l.get("match_confidence") or 0) >= MIN_MATCH_CONFIDENCE
        )
    ]
    prices_from_serp = sum(
        1 for l in matched_for_price if l.get("amazon_price") is not None
    )
    if req.fetch_prices:
        proxy_meter.stage("amazon_price")
        for listing in matched_for_price:
            if listing.get("amazon_asin"):
                listing["amazon_url"] = f"https://www.amazon.com/dp/{listing['amazon_asin']}"
        need_aod = [
            l
            for l in matched_for_price
            if l.get("amazon_asin") and l.get("amazon_price") is None
        ]
        asins = list(dict.fromkeys(l["amazon_asin"] for l in need_aod))
        if asins:
            amazon_results = await _fetch_prices_batch(asins, concurrency=FINDER_PRICE_CONCURRENCY)
            for r in amazon_results:
                proxy_meter.add(int(r.get("bytes_downloaded") or 0))
            amazon_map = {r["asin"]: r for r in amazon_results if r.get("asin")}
            for listing in listings:
                asin = listing.get("amazon_asin")
                if not asin or asin not in amazon_map:
                    continue
                data = amazon_map[asin]
                if listing.get("amazon_price") is None and data.get("price") is not None:
                    listing["amazon_price"] = data.get("price")
                    listing["price_source"] = "aod"
                if data.get("stock"):
                    listing["amazon_stock"] = data.get("stock")
        prices_fetched = True
        prices_loaded = sum(
            1
            for l in matched_for_price
            if l.get("amazon_price") is not None
        )
        if prices_from_serp and prices_loaded > prices_from_serp:
            logging.info(
                "Prices: %s from SERP (search page), %s extra via AOD",
                prices_from_serp,
                prices_loaded - prices_from_serp,
            )
    else:
        for listing in listings:
            if listing.get("amazon_asin"):
                listing["amazon_url"] = f"https://www.amazon.com/dp/{listing['amazon_asin']}"
        prices_loaded = prices_from_serp

    # 4) Profit
    listings = calculate_batch(listings, req.store_settings)

    def _count_match_method(*methods: str) -> int:
        return sum(1 for l in listings if l.get("match_method") in methods)

    def _count_search_methods() -> int:
        return sum(
            1
            for l in listings
            if (l.get("match_method") or "").startswith("search")
            or l.get("match_method") in ("mpn_search", "mpn_exact", "search_best")
        )

    # 6) Summary — only count matches at ≥80% confidence (same as UI).
    matched = [
        l
        for l in listings
        if l.get("amazon_asin")
        and (
            l.get("match_method") == "description"
            or float(l.get("match_confidence") or 0) >= MIN_MATCH_CONFIDENCE
        )
    ]
    for l in matched:
        if l.get("text_score") is None and l.get("match_title_score") is not None:
            l["text_score"] = l["match_title_score"]
        if l.get("image_score") is None and l.get("match_image_score") is not None:
            l["image_score"] = l.get("match_image_score")
    profitable = [l for l in listings if l.get("is_profitable")]
    summary = {
        "total_listings": len(listings),
        "matched_to_amazon": len(matched),
        "profitable": len(profitable),
        "match_rate": round(len(matched) / len(listings) * 100, 1) if listings else 0,
        "avg_margin": round(
            sum(l["margin_percent"] for l in profitable) / len(profitable), 2
        )
        if profitable
        else 0,
        "total_revenue": round(
            sum((l.get("sold_price") or 0) * (l.get("quantity_sold") or 1) for l in listings), 2
        ),
        "total_profit": round(sum(l.get("net_profit") or 0 for l in profitable), 2),
        "truncated": truncated,
        "truncated_at": MAX_FINDER_LISTINGS if truncated else None,
        "prices_fetched": prices_fetched,
        "prices_loaded": prices_loaded if req.fetch_prices else 0,
        "prices_from_serp": prices_from_serp if req.fetch_prices else 0,
        "match_groups_total": match_stats.get("groups_total", 0),
        "match_groups_attempted": match_stats.get("groups_attempted", 0),
        "match_groups_skipped": match_stats.get("groups_skipped", 0),
        "match_captcha_aborted": bool(match_stats.get("captcha_aborted")),
        "match_cached_miss": match_stats.get("match_cached_miss", 0),
        "match_raw_before_filter": match_stats.get("match_raw_before_filter", 0),
        "claude_arbitration_calls": match_stats.get("claude_arbitration_calls", 0),
        "asin_reuse_rejected": match_stats.get("asin_reuse_rejected", 0),
        "match_methods": {
            "asin_in_title": _count_match_method("asin_in_title", "pre_extracted", "claude_asin_extract"),
            "ebay_detail": _count_match_method("ebay_detail"),
            "mpn_exact": _count_match_method("mpn_exact"),
            "text_search": _count_search_methods(),
            "score_match": _count_match_method(
                "score_upc",
                "score_mpn",
                "score_phash",
                "score_brand",
                "score_title",
                "score_brand_title",
                "score_multi",
                "score_match",
                "image_siglip",
            ),
            "claude_arbitration": _count_match_method("claude_arbitration"),
            "cached_miss": _count_match_method("cached_miss"),
            "no_match": _count_match_method("no_match", "captcha_abort", "asin_reuse_rejected"),
        },
        "ebay_seller_id": ebay_ssn,
        "ebay_store_name": store_name,
        "ebay_store_resolved": resolution.get("resolved"),
        **summarize_serp_meter(),
        **proxy_meter.summarize(),
    }

    # Only return accepted matches — sending 5000+ raw eBay rows blows up JSON (~200MB) and causes HTTP 500.
    return {"seller": seller, "listings": matched, "summary": summary}


async def _product_finder_analyze_active_inner(req: ProductFinderActiveRequest):
    seller_input = req.seller.strip()
    if not seller_input:
        raise HTTPException(status_code=400, detail="seller is required")

    parsed = parse_ebay_seller_input(seller_input)
    seller = parsed["display"]
    ebay_ssn_hint = parsed.get("ebay_ssn")
    store_name_hint = parsed.get("store_name")
    max_items = min(ACTIVE_MAX_LISTINGS, max(1, int(req.max_items or ACTIVE_MAX_LISTINGS)))

    proxy_meter.start()
    reset_serp_meter()
    reset_captcha_streak()
    if req.force_refresh:
        cleared_miss = match_cache.clear_miss_cache()
        if cleared_miss:
            logging.info("Force refresh active: cleared %s cached no-match entries", cleared_miss)

    proxy_meter.stage("ebay_search")
    resolution = await resolve_ebay_seller_id(
        seller,
        ebay_ssn_hint=ebay_ssn_hint,
        store_name_hint=store_name_hint,
    )
    ebay_ssn = resolution["ebay_ssn"]
    store_name = resolution.get("store_name") or store_name_hint
    listings: list[dict] = []
    for attempt in range(5):
        listings = await scrape_seller_active_listings(
            seller,
            max_items=max_items,
            ebay_ssn=ebay_ssn,
            store_name=store_name,
        )
        if listings:
            break
        if not resolution.get("resolved"):
            resolution = await resolve_ebay_seller_id(
                seller,
                ebay_ssn_hint=ebay_ssn_hint,
                store_name_hint=store_name_hint,
            )
            ebay_ssn = resolution["ebay_ssn"]
            store_name = resolution.get("store_name") or store_name_hint
        if attempt < 4:
            await asyncio.sleep(2.5 * (attempt + 1))

    if not listings:
        active_html = None
        try:
            from ebay_scraper import _fetch_active_search_page

            active_html = await _fetch_active_search_page(ebay_ssn, 1, store_name=store_name)
        except Exception:  # noqa: BLE001
            pass
        active_count = 0
        if active_html:
            from ebay_scraper import _search_results_count, parse_sold_listings

            active_count = _search_results_count(active_html) or len(parse_sold_listings(active_html))
        return {
            "seller": seller,
            "listings": [],
            "summary": {
                **_empty_summary(),
                "scan_type": "active",
                "ebay_active_listings": active_count,
                "ebay_seller_id": ebay_ssn,
                "ebay_store_resolved": resolution.get("resolved"),
                "ebay_message": (
                    f"No active listings parsed for {seller}"
                    if active_count == 0
                    else "Active listings found but parse failed — retry with Fresh scan"
                ),
                **proxy_meter.summarize(),
            },
        }

    truncated = len(listings) >= max_items

    for i, l in enumerate(listings):
        l["_idx"] = i
        l["source_seller"] = seller
    proxy_meter.stage("amazon_search")
    unmatched = [l for l in listings if not l.get("amazon_asin")]
    match_stats = {"groups_total": 0, "groups_attempted": 0, "groups_skipped": 0, "captcha_aborted": False}
    if unmatched:
        matched_extra, match_stats = await match_listings_batch(
            unmatched,
            concurrency=MATCH_CONCURRENCY,
            max_groups=ACTIVE_MAX_MATCH_GROUPS,
            skip_miss_cache=req.force_refresh,
        )
        for m in matched_extra:
            listings[m["_idx"]] = m
    for l in listings:
        l.pop("_idx", None)

    for l in listings:
        if not l.get("amazon_asin"):
            continue
        method = l.get("match_method")
        conf = l.get("match_confidence")
        if method == "description":
            if conf is None:
                l["match_confidence"] = 1.0
            continue
        if conf is None:
            l["amazon_asin"] = None
            l["match_confidence"] = 0.0
            continue
        if float(conf) < MIN_MATCH_CONFIDENCE:
            l["amazon_asin"] = None
            l["match_confidence"] = float(conf)

    prices_fetched = False
    prices_loaded = 0
    prices_from_serp = 0
    matched_for_price = [
        l
        for l in listings
        if l.get("amazon_asin")
        and (
            l.get("match_method") == "description"
            or float(l.get("match_confidence") or 0) >= MIN_MATCH_CONFIDENCE
        )
    ]
    prices_from_serp = sum(
        1 for l in matched_for_price if l.get("amazon_price") is not None
    )
    if req.fetch_prices:
        proxy_meter.stage("amazon_price")
        for listing in matched_for_price:
            if listing.get("amazon_asin"):
                listing["amazon_url"] = f"https://www.amazon.com/dp/{listing['amazon_asin']}"
        need_aod = [
            l
            for l in matched_for_price
            if l.get("amazon_asin") and l.get("amazon_price") is None
        ]
        asins = list(dict.fromkeys(l["amazon_asin"] for l in need_aod))
        if asins:
            amazon_results = await _fetch_prices_batch(asins, concurrency=FINDER_PRICE_CONCURRENCY)
            for r in amazon_results:
                proxy_meter.add(int(r.get("bytes_downloaded") or 0))
            amazon_map = {r["asin"]: r for r in amazon_results if r.get("asin")}
            for listing in listings:
                asin = listing.get("amazon_asin")
                if not asin or asin not in amazon_map:
                    continue
                data = amazon_map[asin]
                if listing.get("amazon_price") is None and data.get("price") is not None:
                    listing["amazon_price"] = data.get("price")
                    listing["price_source"] = "aod"
                if data.get("stock"):
                    listing["amazon_stock"] = data.get("stock")
        prices_fetched = True
        prices_loaded = sum(
            1 for l in matched_for_price if l.get("amazon_price") is not None
        )
    else:
        for listing in listings:
            if listing.get("amazon_asin"):
                listing["amazon_url"] = f"https://www.amazon.com/dp/{listing['amazon_asin']}"
        prices_loaded = prices_from_serp

    listings = calculate_batch(listings, req.store_settings)

    matched = [
        l
        for l in listings
        if l.get("amazon_asin")
        and (
            l.get("match_method") == "description"
            or float(l.get("match_confidence") or 0) >= MIN_MATCH_CONFIDENCE
        )
    ]
    profitable = [l for l in listings if l.get("is_profitable")]
    summary = {
        "scan_type": "active",
        "total_listings": len(listings),
        "matched_to_amazon": len(matched),
        "profitable": len(profitable),
        "match_rate": round(len(matched) / len(listings) * 100, 1) if listings else 0,
        "avg_margin": round(
            sum(l["margin_percent"] for l in profitable) / len(profitable), 2
        )
        if profitable
        else 0,
        "total_revenue": round(
            sum((l.get("sold_price") or l.get("list_price") or 0) for l in listings), 2
        ),
        "total_profit": round(sum(l.get("net_profit") or 0 for l in profitable), 2),
        "truncated": truncated,
        "truncated_at": max_items if truncated else None,
        "prices_fetched": prices_fetched,
        "prices_loaded": prices_loaded if req.fetch_prices else 0,
        "prices_from_serp": prices_from_serp if req.fetch_prices else 0,
        "match_groups_total": match_stats.get("groups_total", 0),
        "match_groups_attempted": match_stats.get("groups_attempted", 0),
        "match_groups_skipped": match_stats.get("groups_skipped", 0),
        "match_captcha_aborted": bool(match_stats.get("captcha_aborted")),
        "ebay_seller_id": ebay_ssn,
        "ebay_store_name": store_name,
        "ebay_store_resolved": resolution.get("resolved"),
        **summarize_serp_meter(),
        **proxy_meter.summarize(),
    }
    return {"seller": seller, "listings": matched, "summary": summary}


def _empty_summary() -> dict:
    return {
        "total_listings": 0,
        "matched_to_amazon": 0,
        "profitable": 0,
        "match_rate": 0,
        "avg_margin": 0,
        "total_revenue": 0,
        "total_profit": 0,
        "truncated": False,
    }
