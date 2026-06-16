"""Try multiple eBay sold-search URL shapes for a seller."""
import asyncio
import re

from curl_cffi.requests import AsyncSession
from parsel import Selector

from ebay_scraper import EBAY_HEADERS, _warmup, _ebay_get, parse_sold_listings

SELLERS = ["Mirsolav", "ADart201", "vadim86vg"]


def count_items(html: str) -> dict:
    sel = Selector(text=html)
    return {
        "s-card": len(sel.css("li.s-card")),
        "s-item": len(sel.css("li.s-item")),
        "parsed": len(parse_sold_listings(html)),
        "title": (sel.css("title::text").get() or "")[:80],
        "results": re.search(r"([\d,]+)\s+results", html, re.I),
        "sold_in_html": "lh_sold=1" in html.lower() or "sold items" in html.lower(),
    }


async def try_url(session, label: str, url: str, params: dict | None = None) -> None:
    try:
        r = await _ebay_get(
            session,
            url,
            params=params,
            headers={**EBAY_HEADERS, "Referer": "https://www.ebay.com/"},
            timeout=25,
        )
        info = count_items(r.text)
        final = str(r.url)[:120]
        print(
            f"{label}: status={r.status_code} parsed={info['parsed']} "
            f"s-card={info['s-card']} s-item={info['s-item']} title={info['title']!r} "
            f"url={final}",
            flush=True,
        )
    except Exception as exc:
        print(f"{label}: ERROR {exc}", flush=True)


async def main() -> None:
    async with AsyncSession() as session:
        await _warmup(session)
        for seller in SELLERS:
            print(f"\n===== {seller} =====", flush=True)
            base_params = {
                "_ssn": seller,
                "LH_Sold": "1",
                "LH_Complete": "1",
                "_ipg": "240",
                "_pgn": "1",
                "_sop": "13",
            }
            await try_url(session, "sch/i.html", "https://www.ebay.com/sch/i.html", base_params)
            await try_url(
                session,
                "sch/i + rt=nc",
                "https://www.ebay.com/sch/i.html",
                {**base_params, "rt": "nc"},
            )
            await try_url(
                session,
                "sch/m.html",
                "https://www.ebay.com/sch/m.html",
                base_params,
            )
            await try_url(
                session,
                "usr sold tab",
                f"https://www.ebay.com/usr/{seller}",
                {"_tab": "sold", "_pgn": "1"},
            )
            await try_url(
                session,
                "str store",
                f"https://www.ebay.com/sch/i.html",
                {
                    "_ssn": seller,
                    "LH_Sold": "1",
                    "LH_Complete": "1",
                    "LH_BIN": "1",
                    "_sop": "13",
                    "_ipg": "240",
                    "_pgn": "1",
                    "rt": "nc",
                    "_from": "R40",
                },
            )
            # Direct link pattern from eBay UI (sold/completed)
            await try_url(
                session,
                "direct qs",
                f"https://www.ebay.com/sch/i.html?_ssn={seller}&LH_Sold=1&LH_Complete=1&_sop=13&rt=nc&LH_PrefLoc=1&_ipg=240&_pgn=1",
                None,
            )


if __name__ == "__main__":
    asyncio.run(main())
