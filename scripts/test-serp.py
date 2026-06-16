import asyncio
from amazon_search import search_amazon_candidates, captcha_abort, _content_score

async def main():
    q = "retractable trunk cargo cover tiguan"
    c, proxy = await search_amazon_candidates(q, max_candidates=5)
    print("captcha_abort", captcha_abort())
    print("proxy_used", proxy)
    print("candidates", len(c))
    for i, row in enumerate(c[:3]):
        title = row.get("title", "")[:70]
        score = _content_score(q, title)
        print(i, "score", round(score, 3), title)

asyncio.run(main())
