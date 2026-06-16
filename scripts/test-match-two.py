import asyncio
from amazon_matcher import match_listing

async def main():
  for title in [
    "Retractable Trunk Cargo Cover Compatible for 2018-2024 VW Volkswagen Tiguan",
    "Apple AirPods Pro 2nd Generation with MagSafe Case USB-C",
  ]:
    m = await match_listing({"title": title, "listing_id": None, "url": ""}, skip_miss_cache=True)
    print("---")
    print(title[:60])
    print("asin", m.get("amazon_asin"), "conf", m.get("match_confidence"), "method", m.get("match_method"))

asyncio.run(main())
