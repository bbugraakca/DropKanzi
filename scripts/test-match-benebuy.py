import asyncio
from amazon_matcher import match_listing
from amazon_search import clean_query

SAMPLE = (
    "Retractable Trunk Cargo Cover Compatible for 2018-2024 VW Volkswagen Tiguan "
    "Accessories SUV Rear Storage Shield"
)

async def main():
    listing = {
        "title": SAMPLE,
        "listing_id": None,
        "url": "",
        "sold_price": 45.0,
        "sold_date": "2025-05-01",
    }
    q = clean_query(SAMPLE)
    print("clean_query:", q[:100])
    m = await match_listing(listing, skip_miss_cache=True)
    print("asin:", m.get("amazon_asin"))
    print("confidence:", m.get("match_confidence"))
    print("method:", m.get("match_method"))
    print("reason:", m.get("match_reason") or m.get("no_match_reason"))

asyncio.run(main())
