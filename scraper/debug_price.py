import asyncio
import re

from curl_cffi.requests import AsyncSession
from proxy import get_proxy_url


async def main():
    from parser import extract_price_from_embedded_json, parse_product_page_offer

    p = get_proxy_url()
    pr = {"http": p, "https": p}
    async with AsyncSession() as s:
        await s.get(
            "https://www.amazon.com/",
            proxies=pr,
            impersonate="chrome120",
            timeout=30,
        )
        r = await s.get(
            "https://www.amazon.com/dp/B0D1XD1ZV3",
            proxies=pr,
            impersonate="chrome120",
            timeout=60,
            headers={"Referer": "https://www.amazon.com/"},
        )
        h = r.text
        print("parsed", parse_product_page_offer(h))
        print("json", extract_price_from_embedded_json(h))
        print("len", len(h))
        for pat in ["priceAmount", "apexPriceToPay", "a-price-whole", "lowPrice"]:
            print(pat, pat in h)
        print("lowPrice", re.findall(r'"lowPrice"\s*:\s*"?([\d.]+)"?', h)[:5])
        print("highPrice", re.findall(r'"highPrice"\s*:\s*"?([\d.]+)"?', h)[:5])
        print("price", re.findall(r'"price"\s*:\s*"?([\d.]+)"?', h)[:10])
        print("dollar", re.findall(r"\$\s*([\d,]+\.\d{2})", h)[:15])
        print("twister", "twister-plus-price" in h)
        for needle in ["corePriceDisplay", "priceToPay", "buybox", "formattedPrice"]:
            print(needle, needle in h)


asyncio.run(main())
