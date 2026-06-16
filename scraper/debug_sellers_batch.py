import asyncio
import re

from curl_cffi.requests import AsyncSession
from parsel import Selector

from ebay_scraper import (
    EBAY_HEADERS,
    _warmup,
    _ebay_get,
    parse_sold_listings,
    seller_exists,
    diagnose_seller_scrape,
    _search_results_count,
    _fetch_seller_search,
)

SELLERS = ["Lazarov", "lazarov", "ADart201", "Mirsolav", "Miroslav", "vadim86vg"]


async def profile_stats(session, seller: str) -> None:
    r = await _ebay_get(
        session,
        f"https://www.ebay.com/usr/{seller}",
        headers=EBAY_HEADERS,
        timeout=20,
    )
    sel = Selector(text=r.text)
    title = sel.css("title::text").get() or ""
    text = r.text
    sold_m = re.search(r"([\d,]+)\s+items?\s+sold", text, re.I)
    fb_m = re.search(r"([\d,]+)\s+positive feedback", text, re.I)
    print(
        f"  profile {seller}: title={title[:55]!r} "
        f"items_sold={sold_m.group(1) if sold_m else '-'} "
        f"feedback={fb_m.group(1) if fb_m else '-'}",
        flush=True,
    )


async def sold_search(session, seller: str, site: str = "ebay.com") -> None:
    base = f"https://www.{site}/sch/i.html"
    params = {
        "_ssn": seller,
        "LH_Sold": "1",
        "LH_Complete": "1",
        "_ipg": "240",
        "_pgn": "1",
        "_sop": "13",
        "rt": "nc",
    }
    r = await _ebay_get(
        session,
        base,
        params=params,
        headers={**EBAY_HEADERS, "Referer": f"https://www.{site}/"},
        timeout=25,
    )
    parsed = len(parse_sold_listings(r.text))
    count = _search_results_count(r.text)
    title = Selector(text=r.text).css("title::text").get() or ""
    print(
        f"  sold {site} {seller}: results={count} parsed={parsed} title={title[:50]!r}",
        flush=True,
    )


async def active_search(session, seller: str) -> None:
    html = await _fetch_seller_search(seller, 1, sold_only=False, session=session, attempts=2)
    if not html:
        print(f"  active {seller}: fetch failed", flush=True)
        return
    print(
        f"  active {seller}: results={_search_results_count(html)} parsed={len(parse_sold_listings(html))}",
        flush=True,
    )


async def store_url(session, seller: str) -> None:
    for url in (
        f"https://www.ebay.com/str/{seller}",
        f"https://www.ebay.com/str/{seller.lower()}",
    ):
        r = await _ebay_get(session, url, headers=EBAY_HEADERS, timeout=20)
        title = Selector(text=r.text).css("title::text").get() or ""
        print(f"  store {url}: status={r.status_code} title={title[:55]!r}", flush=True)


async def feedback(session, seller: str) -> None:
    r = await _ebay_get(
        session,
        f"https://www.ebay.com/fdbk/feedback_profile/{seller}",
        headers=EBAY_HEADERS,
        timeout=20,
    )
    sel = Selector(text=r.text)
    items = sel.css(".fdbk-item, [class*='fdbk-item']")
    titles = [
        (t.css(".fdbk-item__title ::text, a ::text").get() or "").strip()[:50]
        for t in items[:5]
    ]
    print(
        f"  feedback {seller}: status={r.status_code} items={len(items)} "
        f"sample={titles[:2]}",
        flush=True,
    )


async def main() -> None:
    async with AsyncSession() as session:
        await _warmup(session)
        for seller in SELLERS:
            print(f"\n===== {seller} =====", flush=True)
            print(f"  exists={await seller_exists(seller)}", flush=True)
            d = await diagnose_seller_scrape(seller, 30)
            print(f"  diagnose={d.get('status')}: {d.get('message', '')[:100]}", flush=True)
            await profile_stats(session, seller)
            await sold_search(session, seller, "ebay.com")
            await sold_search(session, seller, "ebay.co.uk")
            await active_search(session, seller)
            await store_url(session, seller)
            await feedback(session, seller)


if __name__ == "__main__":
    asyncio.run(main())
