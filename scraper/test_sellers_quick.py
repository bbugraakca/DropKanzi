import asyncio
import sys

from ebay_scraper import (
    diagnose_seller_scrape,
    seller_exists,
    scrape_seller_sold_listings,
    _fetch_search_page,
    parse_sold_listings,
)


async def main() -> None:
    sellers = sys.argv[1:] or ["UrbanBazaar2024", "ADart201"]
    days = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 7
    for seller in sellers:
        print(f"=== {seller} ({days}d) ===", flush=True)
        print(f"  diagnose: {await diagnose_seller_scrape(seller, days)}", flush=True)
        try:
            exists = await asyncio.wait_for(seller_exists(seller), timeout=20)
            print(f"  exists: {exists}", flush=True)
        except Exception as exc:
            print(f"  exists error: {exc}", flush=True)
        try:
            html = await asyncio.wait_for(_fetch_search_page(seller, 1, session=None, attempts=2), timeout=45)
            if html is None:
                print("  page1: None (blocked/failed)", flush=True)
            else:
                from parsel import Selector

                sel = Selector(text=html)
                items = parse_sold_listings(html)
                blocked = "pardon our interruption" in html.lower()
                print(
                    f"  page1: {len(items)} items, html={len(html)}, blocked={blocked}, "
                    f"s-card={len(sel.css('li.s-card'))}, s-item={len(sel.css('li.s-item'))}, "
                    f"title={(sel.css('title::text').get() or '')[:60]!r}",
                    flush=True,
                )
                if len(items) == 0 and len(html) > 10000:
                    low = html.lower()
                    for needle in (
                        "0 results",
                        "no exact matches",
                        "results found",
                        "srp-controls__count",
                    ):
                        if needle in low:
                            print(f"    hint: found {needle!r} in html", flush=True)
        except Exception as exc:
            print(f"  page1 error: {exc}", flush=True)
        try:
            listings = await asyncio.wait_for(
                scrape_seller_sold_listings(seller, days_back=days, max_pages=3, max_items=100),
                timeout=90,
            )
            print(f"  scrape ({days}d): {len(listings)} listings", flush=True)
        except Exception as exc:
            print(f"  scrape error: {exc}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
