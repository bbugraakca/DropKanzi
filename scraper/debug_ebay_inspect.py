import asyncio
import re

from curl_cffi.requests import AsyncSession
from parsel import Selector

from ebay_scraper import EBAY_HEADERS, _warmup, _ebay_get, parse_sold_listings

SELLERS = ["Mirsolav", "Miroslav", "mirosiav", "ADart201", "vadim86vg"]


async def inspect(seller: str) -> None:
    async with AsyncSession() as session:
        await _warmup(session)
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
            "https://www.ebay.com/sch/i.html",
            params=params,
            headers={**EBAY_HEADERS, "Referer": "https://www.ebay.com/"},
            timeout=25,
        )
        html = r.text
        sel = Selector(text=html)
        count_text = sel.css(".srp-controls__count-heading ::text, .srp-controls__count ::text").getall()
        cards = sel.css("li.s-card")
        print(f"\n=== {seller} ===", flush=True)
        print("count ui:", " | ".join(t.strip() for t in count_text if t.strip())[:120], flush=True)
        for m in re.finditer(r"([\d,]+)\+?\s+results?", html, re.I):
            print("regex results:", m.group(0)[:60], flush=True)
            break
        print("parsed:", len(parse_sold_listings(html)), "s-card:", len(cards), flush=True)
        for i, card in enumerate(cards[:5]):
            title = (card.css(".s-card__title .su-styled-text::text").get() or "").strip()
            cap = " ".join(card.css(".s-card__caption ::text").getall()).strip()[:80]
            print(f"  card{i}: {title[:50]!r} cap={cap!r}", flush=True)

        # feedback profile
        fr = await _ebay_get(
            session,
            f"https://www.ebay.com/fdbk/feedback_profile/{seller}",
            headers=EBAY_HEADERS,
            timeout=20,
        )
        fsel = Selector(text=fr.text)
        fb_items = fsel.css(".fdbk-container__details .fdbk-item")
        print("feedback items:", len(fb_items), "title:", (fsel.css("title::text").get() or "")[:50], flush=True)
        for fb in fb_items[:3]:
            item = (fb.css(".fdbk-item__title ::text").get() or "").strip()[:60]
            when = (fb.css(".fdbk-item__time ::text").get() or "").strip()
            print(f"  fb: {when} {item!r}", flush=True)


async def main() -> None:
    for s in SELLERS:
        await inspect(s)


if __name__ == "__main__":
    asyncio.run(main())
