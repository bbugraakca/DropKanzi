import asyncio
import re

from curl_cffi.requests import AsyncSession
from parsel import Selector

from ebay_scraper import EBAY_HEADERS, _warmup, _ebay_get

NAMES = ["Mirsolav", "mirosiav", "Miroslav", "ADart201", "adart201"]


async def profile(seller: str) -> None:
    async with AsyncSession() as session:
        await _warmup(session)
        url = f"https://www.ebay.com/usr/{seller}"
        r = await _ebay_get(session, url, headers=EBAY_HEADERS, timeout=20)
        low = r.text.lower()
        sel = Selector(text=r.text)
        title = sel.css("title::text").get() or ""
        sold_m = re.search(r"([\d,]+)\s+items?\s+sold", r.text, re.I)
        fb_m = re.search(r"([\d,]+)\s+positive feedback", r.text, re.I)
        print(
            f"{seller}: status={r.status_code} title={title[:60]!r} "
            f"items_sold={sold_m.group(1) if sold_m else '?'} "
            f"feedback={fb_m.group(1) if fb_m else '?'} "
            f"not_found={'not found' in low[:8000]}",
            flush=True,
        )


async def main() -> None:
    for n in NAMES:
        await profile(n)
    print("\n--- diagnose ---", flush=True)
    from ebay_scraper import seller_exists, diagnose_seller_scrape

    for n in ["Mirsolav", "Miroslav", "mirosiav", "ADart201", "vadim86vg"]:
        ex = await seller_exists(n)
        d = await diagnose_seller_scrape(n, 30)
        print(n, "exists", ex, d, flush=True)


if __name__ == "__main__":
    asyncio.run(main())
