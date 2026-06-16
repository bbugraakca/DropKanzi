import asyncio
import sys

from curl_cffi.requests import AsyncSession
from proxy import get_proxy_url


async def main(asin: str):
    proxy = get_proxy_url()
    print("proxy:", proxy[:60] + "..." if proxy else "NONE")
    proxies = {"http": proxy, "https": proxy} if proxy else None

    async with AsyncSession() as s:
        home = await s.get(
            "https://www.amazon.com/",
            proxies=proxies,
            impersonate="chrome120",
            timeout=30,
            headers={"Accept-Language": "en-US,en;q=0.9"},
        )
        print("session home:", home.status_code, len(home.text))

        tests = [
            (
                "AOD",
                "https://www.amazon.com/gp/product/ajax/ref=dp_aod_ALL_mbc",
                {
                    "asin": asin,
                    "experienceId": "aodAjaxMain",
                    "filters": '{"all":true}',
                },
            ),
            (
                "DP",
                f"https://www.amazon.com/dp/{asin}",
                {"language": "en_US", "th": "1", "psc": "1"},
            ),
        ]
        for name, url, params in tests:
            try:
                r = await s.get(
                    url,
                    params=params,
                    proxies=proxies,
                    impersonate="chrome120",
                    timeout=45,
                    headers={
                        "Accept-Language": "en-US,en;q=0.9",
                        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                        "Referer": "https://www.amazon.com/",
                    },
                )
                body = r.text
                print(f"\n=== {name} ===")
                print("status:", r.status_code)
                print("length:", len(body))
                low = body.lower()
                print("captcha:", "captcha" in low or "robot check" in low)
                print("productTitle:", "#productTitle" in body or "productTitle" in body)
                print("aod-offer:", "aod-offer" in body)
                print("snippet:", body[:300].replace("\n", " "))
            except Exception as e:
                print(f"\n=== {name} ERROR ===", e)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "B08N5WRWNW"))
