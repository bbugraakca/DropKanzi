"""One-off SERP diagnostic — run: python debug_serp.py"""
import asyncio

from curl_cffi.requests import AsyncSession
from parsel import Selector

from amazon_search import (
    AMAZON_SEARCH_HEADERS,
    _parse_serp_candidates,
    _proxies,
    search_amazon_candidates,
)


async def main() -> None:
    q = "Apple AirPods Pro 2nd Generation"
    print("proxy configured:", bool(_proxies()))

    streamed = await search_amazon_candidates(q, max_candidates=6)
    print("search_amazon_candidates (stream path):", len(streamed))

    async with AsyncSession() as session:
        r = await session.get(
            "https://www.amazon.com/s",
            params={"k": q, "ref": "sr_pg_1", "language": "en_US"},
            headers=AMAZON_SEARCH_HEADERS,
            proxies=_proxies(),
            impersonate="chrome120",
            timeout=25,
        )
    text = r.text
    print("full GET status:", r.status_code, "bytes:", len(text))
    print("captcha:", "captcha" in text.lower() or "automated access" in text.lower())

    sel = Selector(text=text)
    print("selectors full page:")
    print("  div.s-result-item[data-asin]:", len(sel.css("div.s-result-item[data-asin]")))
    print(
        "  div[data-component-type=s-search-result][data-asin]:",
        len(sel.css('div[data-component-type="s-search-result"][data-asin]')),
    )

    for cap in (65536, 100000, 150000, 200000, len(text)):
        parsed = _parse_serp_candidates(text[:cap], 6)
        pos = text[:cap].find("s-result-item")
        print(f"  truncate {cap}: parsed={len(parsed)} first s-result-item @ {pos}")


if __name__ == "__main__":
    asyncio.run(main())
