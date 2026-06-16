import asyncio
import re

from curl_cffi.requests import AsyncSession
from parsel import Selector

from ebay_scraper import EBAY_HEADERS, _warmup, _ebay_get, parse_sold_listings, _search_results_count

SELLERS = ["ADart201", "Lazarov", "lazarov", "GoldStarOutlet", "Bentom"]


async def inspect_store(session, seller: str) -> None:
    url = f"https://www.ebay.com/str/{seller}"
    r = await _ebay_get(session, url, headers=EBAY_HEADERS, timeout=25)
    sel = Selector(text=r.text)
    title = sel.css("title::text").get() or ""
    print(f"\n=== STORE {seller} === status={r.status_code} title={title[:60]!r}", flush=True)
    # store search links
    for a in sel.css("a[href*='sch/i.html'], a[href*='LH_Sold']")[:8]:
        href = a.attrib.get("href", "")
        text = (a.css("::text").get() or "").strip()[:40]
        if href:
            print(f"  link: {text!r} -> {href[:100]}", flush=True)
    parsed = len(parse_sold_listings(r.text))
    print(f"  parsed on store page: {parsed}", flush=True)
    # try store sold tab params
    for extra in (
        {"_tab=sales": f"https://www.ebay.com/str/{seller}?_tab=sales"},
        {"sch": f"https://www.ebay.com/sch/i.html?_ssn={seller}&LH_Sold=1&LH_Complete=1&rt=nc&_sop=13&_ipg=240"},
        {"store": f"https://www.ebay.com/sch/{seller}/m.html?LH_Sold=1&LH_Complete=1&_ipg=240&_pgn=1"},
    ):
        pass

    urls = [
        f"https://www.ebay.com/str/{seller}?_tab=sales",
        f"https://www.ebay.com/sch/i.html?_ssn={seller}&LH_Sold=1&LH_Complete=1&rt=nc&_sop=13&_ipg=240&_pgn=1",
        f"https://www.ebay.com/sch/{seller}/m.html?_ssn={seller}&LH_Sold=1&LH_Complete=1&_ipg=240&_pgn=1",
        f"https://www.ebay.com/sch/i.html?_ssn={seller}&LH_Sold=1&LH_Complete=1&_sacat=0&rt=nc&LH_ItemCondition=3000&_ipg=240",
    ]
    for u in urls:
        r2 = await _ebay_get(session, u, headers=EBAY_HEADERS, timeout=25)
        t2 = Selector(text=r2.text).css("title::text").get() or ""
        p2 = len(parse_sold_listings(r2.text))
        c2 = _search_results_count(r2.text)
        blocked = "interruption" in t2.lower() or "security measure" in t2.lower()
        print(f"  GET {u[:80]}... -> count={c2} parsed={p2} blocked={blocked} title={t2[:45]!r}", flush=True)


async def main() -> None:
    async with AsyncSession() as session:
        await _warmup(session)
        for s in SELLERS:
            await inspect_store(session, s)


if __name__ == "__main__":
    asyncio.run(main())
