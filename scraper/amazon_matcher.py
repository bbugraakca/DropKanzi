"""
Multi-strategy Amazon matching engine (v3).

Pipeline (stop at first match with confidence >= STOP_CONFIDENCE):
  1. Pre-extracted / ASIN in title (verified)
  2. MPN / model number exact search
  3. SigLIP semantic image match + SERP candidates
  4. Claude title clean + multi-query search (optional, needs ANTHROPIC_API_KEY)
  5. Claude Vision + search (optional)
  6. Multi-keyword search fallback (content scoring)

Matches below MIN_MATCH_CONFIDENCE are rejected (no ASIN returned).
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
from collections import Counter
from typing import Any, Optional

from curl_cffi.requests import AsyncSession

import match_cache
from ebay_scraper import get_listing_details
from amazon_search import (
    _content_score,
    captcha_abort,
    clean_query,
    search_amazon_candidates,
    _search_queries,
    extract_model_tokens,
)
from pack_utils import extract_pack_count
from llm_provider import get_llm_client
from vector_cache import lookup_similar, save_match
from asin_util import is_plausible_asin, is_ebay_detail_asin, reject_suspicious_ebay_detail_dupes
from image_match import IMAGE_CHECK_MAX_TEXT, image_match as siglip_match

logger = logging.getLogger("pricehawk.amazon_matcher")

MIN_MATCH_CONFIDENCE = 0.80
STOP_CONFIDENCE = 0.86
_PER_PRODUCT_TIMEOUT = int(os.getenv("FINDER_MATCH_TIMEOUT_SEC", "60"))
_CLAUDE_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")
# Hard ceiling for parallel title matching. Residential proxy rotates IPs per
# request, so this is mostly bounded by proxy bandwidth, not captcha risk.
_MAX_BATCH_CONCURRENCY = int(os.getenv("FINDER_MATCH_MAX_CONCURRENCY", "24"))

_ASIN_IN_TITLE_RE = re.compile(r"\b(B[A-Z0-9]{9})\b")
_MPN_NOISE = frozenset(
    {"FAST", "SHIP", "SHIPS", "FREE", "NEW", "USED", "OPEN", "BOX", "SEALED"}
)

def _claude_enabled() -> bool:
    provider, _client = get_llm_client()
    return provider == "claude"


def _get_claude() -> Any | None:
    provider, client = get_llm_client()
    if provider != "claude":
        return None
    return client


def _parse_json_response(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return json.loads(text)


FINDER_CLAUDE_MATCH = os.getenv("FINDER_CLAUDE_MATCH", "false").lower() in ("1", "true", "yes")
FINDER_VISION_MATCH = os.getenv("FINDER_VISION_MATCH", "false").lower() in ("1", "true", "yes")
FINDER_MAX_SERP_QUERIES = int(os.getenv("FINDER_MAX_SERP_QUERIES", "2"))
FINDER_MAX_MATCH_GROUPS = int(os.getenv("FINDER_MAX_MATCH_GROUPS", "600"))
FINDER_SERP_CANDIDATES = int(os.getenv("FINDER_SERP_CANDIDATES", "8"))
FINDER_LLM_BATCH_SIZE = int(os.getenv("FINDER_LLM_BATCH_SIZE", "25"))
def _identifier_gate_ok(ebay_title: str, amazon_title: str) -> bool:
    e = extract_model_tokens(ebay_title)
    a = extract_model_tokens(amazon_title)
    if not e:
        return True
    return e.issubset(a)


def _dynamic_threshold(title: str, has_exact_partno: bool) -> float:
    t = title.lower()
    if any(k in t for k in ("case", "cover", "protector", "compatible with", "fits for", "replacement for")):
        return 0.90
    if has_exact_partno and any(k in t for k in ("oem", "genuine", "part number", "interchange")):
        return 0.75
    return 0.80


_match_method_stats: dict[str, int] = {
    "regex": 0,
    "ebay_detail": 0,
    "claude": 0,
    "amazon_no_proxy": 0,
    "amazon_proxy": 0,
    "other": 0,
}
_match_total = 0


def _record_match(method: str, *, proxy_used: bool, bytes_used: int, confidence: float) -> None:
    global _match_total  # noqa: PLW0603
    bucket = method
    if method in ("asin_in_title", "pre_extracted", "claude_asin_extract"):
        bucket = "regex"
    elif method == "ebay_detail":
        bucket = "ebay_detail"
    elif method.startswith("claude") or method == "claude_clean":
        bucket = "claude"
    elif method.startswith("search") or method.startswith("mpn"):
        bucket = "amazon_proxy" if proxy_used else "amazon_no_proxy"
    else:
        bucket = "other"
    _match_method_stats[bucket] = _match_method_stats.get(bucket, 0) + 1
    _match_total += 1
    logger.info(
        "match_method=%s confidence=%.2f proxy_used=%s bytes_used=%d",
        method,
        confidence,
        proxy_used,
        bytes_used,
    )
    if _match_total % 50 == 0:
        logger.info(
            "match_summary regex=%d ebay_detail=%d claude=%d amazon_no_proxy=%d amazon_proxy=%d other=%d",
            _match_method_stats.get("regex", 0),
            _match_method_stats.get("ebay_detail", 0),
            _match_method_stats.get("claude", 0),
            _match_method_stats.get("amazon_no_proxy", 0),
            _match_method_stats.get("amazon_proxy", 0),
            _match_method_stats.get("other", 0),
        )


def _valid_asin(asin: str | None) -> bool:
    return is_plausible_asin(asin)


def _apply_match(listing: dict, match: dict) -> dict:
    out = {**listing}
    for key in (
        "amazon_asin",
        "amazon_price",
        "match_confidence",
        "match_method",
        "clean_title",
        "amazon_title",
        "match_title_score",
        "match_image_score",
        "text_score",
        "image_score",
    ):
        if key in match and match[key] is not None:
            out[key] = match[key]
    if out.get("amazon_asin"):
        conf = float(out.get("match_confidence") or 0)
        if conf < MIN_MATCH_CONFIDENCE:
            out["amazon_asin"] = None
            out["amazon_price"] = None
            out["match_confidence"] = conf
        elif out.get("amazon_price") is not None:
            out["price_source"] = match.get("price_source") or "serp"
    return out


def _success(match: dict) -> bool:
    conf = float(match.get("match_confidence") or 0)
    return bool(match.get("amazon_asin")) and conf >= MIN_MATCH_CONFIDENCE


def _stop_early(match: dict) -> bool:
    conf = float(match.get("match_confidence") or 0)
    return _success(match) and conf >= STOP_CONFIDENCE


def extract_identifiers(title: str) -> dict[str, str]:
    identifiers: dict[str, str] = {}

    apple_mpn = re.findall(r"\b([A-Z]{2,4}\d{2,4}[A-Z]{2}/[A-Z])\b", title)
    if apple_mpn:
        identifiers["apple_mpn"] = apple_mpn[0]

    samsung = re.findall(r"\b(SM-[A-Z]\d{3,4}[A-Z]?)\b", title, re.IGNORECASE)
    if samsung:
        identifiers["samsung_model"] = samsung[0].upper()

    mpn_candidates = re.findall(
        r"\b([A-Z]{1,4}-?[A-Z0-9]{3,8}-?[A-Z0-9]{0,4})\b", title
    )
    mpn_candidates = [
        m
        for m in mpn_candidates
        if m not in _MPN_NOISE and len(m) >= 5 and any(c.isdigit() for c in m)
    ]
    if mpn_candidates:
        identifiers["mpn"] = mpn_candidates[0]

    upc = re.findall(r"\b(\d{12,13})\b", title)
    if upc:
        identifiers["upc"] = upc[0]

    asin = _ASIN_IN_TITLE_RE.findall(title)
    if asin:
        identifiers["asin"] = asin[0]

    return identifiers


async def search_by_mpn(
    mpn: str,
    reference_title: str = "",
    serp_cache: dict[str, list[dict]] | None = None,
    serp_session: AsyncSession | None = None,
) -> Optional[dict]:
    candidates, _proxy_used = await search_amazon_candidates(
        mpn, max_candidates=5, serp_cache=serp_cache, session=serp_session
    )
    if not candidates:
        return None
    mpn_l = mpn.lower()
    ref = reference_title or mpn
    for cand in candidates:
        if mpn_l in cand["title"].lower():
            return {
                "amazon_asin": cand["asin"],
                "amazon_price": cand.get("price"),
                "price_source": "serp" if cand.get("price") is not None else None,
                "match_confidence": 0.98,
                "match_method": "mpn_exact",
                "amazon_title": cand["title"].lower(),
            }
    first = candidates[0]
    content = _content_score(ref, first["title"])
    if content >= MIN_MATCH_CONFIDENCE:
        return {
            "amazon_asin": first["asin"],
            "amazon_price": first.get("price"),
            "price_source": "serp" if first.get("price") is not None else None,
            "match_confidence": round(max(content, 0.82), 2),
            "match_method": "mpn_search",
            "amazon_title": first["title"].lower(),
        }
    return None


def _title_content_score(reference_title: str, original_title: str, amazon_title: str) -> float:
    scores = [_content_score(reference_title, amazon_title)]
    if original_title and original_title.lower() != reference_title.lower():
        scores.append(_content_score(original_title, amazon_title))
        scores.append(_content_score(clean_query(original_title), amazon_title))
    return max(scores)


async def _best_from_candidates(
    candidates: list[dict],
    reference_title: str,
    image_url: str | None,
    img_session: AsyncSession | None,
    original_title: str = "",
) -> Optional[dict]:
    if not candidates:
        return None

    ref = reference_title
    orig = original_title or reference_title
    text_best: dict | None = None
    for cand in candidates:
        content = _title_content_score(ref, orig, cand["title"])
        if text_best is None or content > text_best["match_confidence"]:
            text_best = {
                "amazon_asin": cand["asin"],
                "amazon_price": cand.get("price"),
                "price_source": "serp" if cand.get("price") is not None else None,
                "match_confidence": content,
                "match_title_score": content,
                "amazon_title": cand["title"].lower(),
                "match_method": "search",
            }

    text_best_score = float(text_best.get("match_confidence") or 0) if text_best else 0.0

    if text_best_score >= IMAGE_CHECK_MAX_TEXT:
        return text_best

    if image_url:
        candidates_for_image = [
            {
                "asin": c["asin"],
                "image_url": c.get("image", "") or c.get("image_url", ""),
                "text_score": _title_content_score(ref, orig, c["title"]),
                "title": c["title"],
                "price": c.get("price"),
            }
            for c in sorted(
                candidates,
                key=lambda c: _title_content_score(ref, orig, c["title"]),
                reverse=True,
            )
        ]

        image_result = await siglip_match(
            ebay_image_url=image_url,
            candidates=candidates_for_image,
            text_best_score=text_best_score,
        )

        if image_result and image_result["combined_score"] >= 0.72:
            amazon_title = image_result.get("title") or ""
            conf = float(image_result["combined_score"])
            if image_result["image_score"] >= 0.85:
                conf = max(conf, 0.81)
            elif image_result["image_score"] >= 0.75:
                conf = max(conf, 0.80)
            return {
                "amazon_asin": image_result["asin"],
                "amazon_price": image_result.get("price"),
                "price_source": "serp" if image_result.get("price") is not None else None,
                "match_confidence": round(conf, 4),
                "match_title_score": image_result["text_score"],
                "match_image_score": image_result["image_score"],
                "text_score": image_result["text_score"],
                "image_score": image_result["image_score"],
                "match_method": "image_siglip",
                "amazon_title": amazon_title.lower() if amazon_title else text_best.get("amazon_title"),
            }

    return text_best


async def _match_serp_queries(
    queries: list[str],
    reference_title: str,
    image_url: str | None,
    img_session: AsyncSession,
    serp_cache: dict[str, list[dict]] | None,
    brand: str | None = None,
    serp_session: AsyncSession | None = None,
    original_title: str = "",
) -> Optional[dict]:
    seen_q: set[str] = set()
    best_hit: dict | None = None
    queries_tried = 0
    candidates_returned = 0
    title_label = (original_title or reference_title or "")[:40]
    for i, query in enumerate(queries[:FINDER_MAX_SERP_QUERIES]):
        q = re.sub(
            r"\b(new|sealed|fast ship|us seller|lot of \d+|free ship)\b",
            "",
            query,
            flags=re.IGNORECASE,
        )
        q = " ".join(q.split())[:100]
        if not q:
            continue
        search_q = f"{brand} {q}".strip() if brand else q
        key = search_q.lower()
        if key in seen_q:
            continue
        seen_q.add(key)
        candidates, proxy_used = await search_amazon_candidates(
            search_q,
            max_candidates=FINDER_SERP_CANDIDATES,
            serp_cache=serp_cache,
            session=serp_session,
        )
        queries_tried += 1
        candidates_returned = max(candidates_returned, len(candidates))
        logger.info(
            "title=%s queries_tried=%d candidates_returned=%d query=%r proxy=%s",
            title_label,
            queries_tried,
            len(candidates),
            search_q[:80],
            proxy_used,
        )
        hit = await _best_from_candidates(
            candidates,
            reference_title,
            image_url,
            img_session,
            original_title=original_title,
        )
        if hit:
            hit["proxy_used"] = proxy_used
            conf = float(hit.get("match_confidence") or 0)
            if best_hit is None or conf > float(best_hit.get("match_confidence") or 0):
                best_hit = dict(hit)
        if hit and _stop_early(hit):
            hit["match_method"] = f"search_query_{i + 1}"
            return hit
        if hit and _success(hit):
            hit["match_method"] = f"search_query_{i + 1}"
            return hit
        # Try next query variant unless we already have a strong match queued.
        await asyncio.sleep(0.25 if i else 0.08)
    if queries_tried:
        logger.info(
            "serp_summary title=%s queries_tried=%d best_candidates=%d",
            title_label,
            queries_tried,
            candidates_returned,
        )
    if best_hit and _success(best_hit):
        best_hit["match_method"] = best_hit.get("match_method") or "search_best"
        return best_hit
    return None


async def claude_clean_title(title: str, image_url: str | None = None) -> dict:
    clean = clean_query(title)
    fallback = {
        "brand": None,
        "clean_title": clean,
        "search_queries": _search_queries(title) or [clean],
        "asin_if_visible": None,
    }
    if not FINDER_CLAUDE_MATCH:
        return fallback
    client = _get_claude()
    if client is None:
        return fallback

    image_content: list[dict] = []
    if image_url and image_url.startswith("http"):
        image_content = [{"type": "image", "source": {"type": "url", "url": image_url}}]

    text_prompt = f"""Analyze this eBay listing and extract structured product data for Amazon matching.

eBay title: "{title}"

Return ONLY valid JSON, no markdown:
{{
  "brand": "brand name or null",
  "clean_title": "product name without eBay junk",
  "search_queries": ["specific query", "medium query", "broad query"],
  "asin_if_visible": "ASIN if in title or null"
}}"""

    try:
        response = await client.messages.create(
            model=_CLAUDE_MODEL,
            max_tokens=400,
            messages=[
                {"role": "user", "content": image_content + [{"type": "text", "text": text_prompt}]}
            ],
        )
        data = _parse_json_response(response.content[0].text)
        if not data.get("search_queries"):
            data["search_queries"] = [data.get("clean_title") or title]
        return data
    except Exception as exc:  # noqa: BLE001
        logger.warning("Claude title clean failed: %s", exc)
        clean = clean_query(title)
        return {
            "clean_title": clean,
            "search_queries": _search_queries(title) or [clean],
            "brand": None,
            "asin_if_visible": None,
        }


async def claude_clean_titles_batch(titles: list[str], batch_size: int = FINDER_LLM_BATCH_SIZE) -> list[dict]:
    client = _get_claude()
    if client is None or not titles:
        return [await claude_clean_title(t) for t in titles]
    out: list[dict] = []
    for i in range(0, len(titles), max(1, batch_size)):
        chunk = titles[i : i + max(1, batch_size)]
        numbered = "\n".join(f"{idx+1}. {t}" for idx, t in enumerate(chunk))
        prompt = (
            "Convert each eBay title to clean Amazon search info. "
            "Return only JSON array with objects {clean_title,search_queries,brand,asin_if_visible}.\n"
            f"Titles:\n{numbered}"
        )
        try:
            resp = await client.messages.create(
                model=_CLAUDE_MODEL,
                max_tokens=1200,
                messages=[{"role": "user", "content": [{"type": "text", "text": prompt}]}],
            )
            arr = json.loads(resp.content[0].text.strip())
            if not isinstance(arr, list):
                raise ValueError("batch response not array")
            for idx, title in enumerate(chunk):
                obj = arr[idx] if idx < len(arr) and isinstance(arr[idx], dict) else {}
                clean = obj.get("clean_title") or clean_query(title)
                out.append(
                    {
                        "clean_title": clean,
                        "search_queries": obj.get("search_queries") or _search_queries(title) or [clean],
                        "brand": obj.get("brand"),
                        "asin_if_visible": obj.get("asin_if_visible"),
                    }
                )
        except Exception:
            for title in chunk:
                out.append(await claude_clean_title(title))
    return out


async def match_by_image_vision(
    img_session: AsyncSession,
    image_url: str,
    title: str,
    serp_cache: dict[str, list[dict]] | None,
) -> Optional[dict]:
    if not FINDER_VISION_MATCH:
        return None
    client = _get_claude()
    if client is None or not image_url or not image_url.startswith("http"):
        return None

    try:
        r = await img_session.get(image_url, timeout=10, impersonate="chrome120")
        if r.status_code != 200 or not r.content:
            return None

        content_type = (r.headers.get("content-type") or "image/jpeg").lower()
        if "png" in content_type:
            media_type = "image/png"
        elif "webp" in content_type:
            media_type = "image/webp"
        else:
            media_type = "image/jpeg"

        image_b64 = base64.standard_b64encode(r.content).decode("utf-8")
        response = await client.messages.create(
            model=_CLAUDE_MODEL,
            max_tokens=220,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": image_b64,
                            },
                        },
                        {
                            "type": "text",
                            "text": (
                                f'eBay title: "{title}"\n\n'
                                "Identify the product. Return ONLY JSON:\n"
                                '{"product_identified":"name",'
                                '"amazon_search_query":"query","confidence":0.0-1.0}'
                            ),
                        },
                    ],
                }
            ],
        )
        vision = _parse_json_response(response.content[0].text)
        if float(vision.get("confidence") or 0) < 0.6:
            return None

        search_result = await _match_serp_queries(
            [vision.get("amazon_search_query") or title],
            title,
            image_url,
            img_session,
            serp_cache,
        )
        if not search_result:
            return None

        combined = float(vision["confidence"]) * 0.6 + float(
            search_result["match_confidence"]
        ) * 0.4
        return {
            "amazon_asin": search_result["amazon_asin"],
            "match_confidence": round(combined, 2),
            "match_method": "image_vision",
            "amazon_title": search_result.get("amazon_title"),
            "match_title_score": search_result.get("match_title_score"),
        }
    except Exception as exc:  # noqa: BLE001
        logger.debug("Vision match failed: %s", exc)
    return None


async def _match_listing_inner(
    listing: dict,
    img_session: AsyncSession,
    serp_session: AsyncSession,
    serp_cache: dict[str, list[dict]] | None = None,
    skip_miss_cache: bool = False,
) -> dict:
    title = listing.get("title") or ""
    image_url = listing.get("image") or ""
    clean = clean_query(title)
    listing["ebay_pack_count"] = extract_pack_count(title)

    base: dict = {
        "clean_title": clean,
        "amazon_asin": None,
        "match_confidence": 0.0,
        "match_method": None,
    }

    cached = match_cache.get_match(clean)
    if cached and not skip_miss_cache:
        if match_cache.is_cached_miss(cached):
            return _apply_match(
                listing,
                {**base, "match_method": "cached_miss", "match_confidence": 0.0},
            )
        conf = float(cached.get("match_confidence") or 0)
        if cached.get("amazon_asin") and conf >= MIN_MATCH_CONFIDENCE:
            return _apply_match(listing, {**cached, "clean_title": clean})
    elif cached and skip_miss_cache and match_cache.is_cached_miss(cached):
        logger.info(
            "[match_cache] skip_miss_cache — retrying Amazon for %r",
            clean[:60],
        )

    vhit = lookup_similar(clean, min_cosine=0.93)
    if vhit and _valid_asin(str(vhit.get("asin") or "")):
        cand_title = str(vhit.get("amazon_title") or "")
        if _identifier_gate_ok(title, cand_title):
            return _apply_match(
                listing,
                {
                    **base,
                    "amazon_asin": str(vhit["asin"]).upper(),
                    "match_confidence": float(vhit.get("confidence") or 0.93),
                    "match_method": "vector_cache",
                    "amazon_title": cand_title.lower(),
                },
            )
    if listing.get("amazon_asin") and _valid_asin(listing["amazon_asin"]):
        hit = {
            **base,
            "amazon_asin": listing["amazon_asin"].upper(),
            "match_confidence": 1.0,
            "match_method": "pre_extracted",
        }
        return _apply_match(listing, hit)

    identifiers = extract_identifiers(title)

    if identifiers.get("asin") and _valid_asin(identifiers["asin"]):
        hit = {
            **base,
            "amazon_asin": identifiers["asin"],
            "match_confidence": 0.99,
            "match_method": "asin_in_title",
        }
        match_cache.set_match(clean, hit)
        _record_match("asin_in_title", proxy_used=False, bytes_used=0, confidence=0.99)
        return _apply_match(listing, hit)

    listing_id = listing.get("listing_id") or listing.get("item_id")
    if not listing_id and listing.get("url"):
        m = re.search(r"/itm/(\d+)", str(listing["url"]))
        listing_id = m.group(1) if m else None
    if listing_id:
        detail = await get_listing_details(str(listing_id), serp_session)
        detail_asin = detail.get("asin")
        detail_source = str(detail.get("source") or "")
        if detail_asin and is_ebay_detail_asin(detail_asin, source=detail_source):
            conf = 0.99 if detail_source == "dp_link" else 0.0
            hit = {
                **base,
                "amazon_asin": detail_asin.upper(),
                "match_confidence": conf,
                "match_method": "ebay_detail",
            }
            match_cache.set_match(clean, hit)
            _record_match("ebay_detail", proxy_used=False, bytes_used=0, confidence=conf)
            return _apply_match(listing, hit)

    for id_type in ("apple_mpn", "samsung_model", "mpn", "upc"):
        mpn = identifiers.get(id_type)
        if not mpn:
            continue
        mpn_hit = await search_by_mpn(
            mpn,
            reference_title=title,
            serp_cache=serp_cache,
            serp_session=serp_session,
        )
        if mpn_hit and _stop_early(mpn_hit):
            match_cache.set_match(clean, mpn_hit)
            return _apply_match(listing, {**base, **mpn_hit})
        if mpn_hit and _success(mpn_hit):
            match_cache.set_match(clean, mpn_hit)
            return _apply_match(listing, {**base, **mpn_hit})

    prefetched = listing.get("_prefetched_claude")
    if isinstance(prefetched, dict):
        claude_data = prefetched
    else:
        claude_data = await claude_clean_title(title, image_url or None)
    clean_title = claude_data.get("clean_title") or clean
    base["clean_title"] = clean_title
    search_queries = claude_data.get("search_queries") or _search_queries(title) or [clean_title]
    brand = claude_data.get("brand")

    if claude_data.get("asin_if_visible") and _valid_asin(claude_data["asin_if_visible"]):
        hit = {
            **base,
            "amazon_asin": claude_data["asin_if_visible"].upper(),
            "match_confidence": 0.98,
            "match_method": "claude_asin_extract",
        }
        match_cache.set_match(clean, hit)
        return _apply_match(listing, hit)

    search_hit = await _match_serp_queries(
        search_queries,
        clean_title,
        image_url or None,
        img_session,
        serp_cache,
        brand=brand,
        serp_session=serp_session,
        original_title=title,
    )
    if search_hit and _success(search_hit):
        amazon_title = str(search_hit.get("amazon_title") or "")
        if not _identifier_gate_ok(title, amazon_title):
            search_hit["amazon_asin"] = None
            search_hit["match_confidence"] = 0.0
        else:
            ebay_pack = float(listing.get("ebay_pack_count") or 1)
            amazon_pack = float(extract_pack_count(amazon_title))
            search_hit["amazon_pack_count"] = amazon_pack
            threshold = _dynamic_threshold(title, bool(extract_identifiers(title)))
            if float(search_hit.get("match_confidence") or 0) < threshold:
                search_hit["amazon_asin"] = None
                search_hit["match_confidence"] = 0.0
            elif amazon_pack > 0 and (ebay_pack / amazon_pack) > 4:
                search_hit["amazon_asin"] = None
                search_hit["match_confidence"] = 0.0
        match_cache.set_match(clean, search_hit)
        _record_match(
            str(search_hit.get("match_method") or "search"),
            proxy_used=bool(search_hit.get("proxy_used")),
            bytes_used=0,
            confidence=float(search_hit.get("match_confidence") or 0),
        )
        out = _apply_match(listing, {**base, **search_hit})
        if out.get("amazon_asin"):
            save_match(
                clean,
                str(out.get("amazon_asin")),
                str(out.get("amazon_title") or ""),
                float(out.get("match_confidence") or 0),
                str(out.get("match_method") or "search"),
            )
        return out

    if image_url:
        vision_hit = await match_by_image_vision(
            img_session, image_url, clean_title, serp_cache
        )
        if vision_hit and _success(vision_hit):
            match_cache.set_match(clean, vision_hit)
            return _apply_match(listing, {**base, **vision_hit})

    if not captcha_abort():
        match_cache.set_miss(clean)
    return _apply_match(listing, base)


async def match_listing(
    listing: dict,
    img_session: AsyncSession | None = None,
    serp_session: AsyncSession | None = None,
    serp_cache: dict[str, list[dict]] | None = None,
    skip_miss_cache: bool = False,
) -> dict:
    if listing.get("amazon_asin") and listing.get("match_method") == "description":
        return {**listing, "match_confidence": 1.0}

    try:
        if img_session is not None and serp_session is not None:
            return await asyncio.wait_for(
                _match_listing_inner(
                    listing, img_session, serp_session, serp_cache, skip_miss_cache
                ),
                timeout=_PER_PRODUCT_TIMEOUT,
            )
        async with AsyncSession() as img_sess, AsyncSession() as serp_sess:
            return await asyncio.wait_for(
                _match_listing_inner(
                    listing, img_sess, serp_sess, serp_cache, skip_miss_cache
                ),
                timeout=_PER_PRODUCT_TIMEOUT,
            )
    except asyncio.TimeoutError:
        logger.warning("Match timeout for %r", (listing.get("title") or "")[:60])
    except Exception as exc:  # noqa: BLE001
        logger.warning("Match error: %s", exc)

    return _apply_match(
        listing,
        {
            "amazon_asin": None,
            "match_confidence": 0.0,
            "clean_title": clean_query(listing.get("title", "")),
            "match_method": "no_match",
        },
    )


def _copy_match_fields(src: dict, dst: dict) -> dict:
    for key in (
        "amazon_asin",
        "amazon_price",
        "amazon_stock",
        "price_source",
        "match_confidence",
        "match_title_score",
        "match_image_score",
        "text_score",
        "image_score",
        "match_method",
        "amazon_title",
        "clean_title",
    ):
        if key in src and src[key] is not None:
            dst[key] = src[key]
    if src.get("amazon_asin") and not dst.get("amazon_url"):
        dst["amazon_url"] = f"https://www.amazon.com/dp/{src['amazon_asin']}"
    return dst


async def match_listings_batch(
    listings: list[dict],
    concurrency: int = 5,
    max_groups: int | None = None,
    skip_miss_cache: bool = False,
) -> tuple[list[dict], dict]:
    """Match unique titles; returns (listings, stats)."""
    if not listings:
        return [], {"groups_total": 0, "groups_attempted": 0, "groups_skipped": 0}

    from amazon_search import captcha_abort

    groups: dict[str, list[int]] = {}
    for i, listing in enumerate(listings):
        key = clean_query(listing.get("title", "")).lower()
        if not key:
            continue
        groups.setdefault(key, []).append(i)

    all_keys = list(groups.keys())

    def _newest_sold(key: str) -> str:
        idx = groups[key][0]
        return listings[idx].get("sold_date") or ""

    all_keys.sort(key=lambda k: (_newest_sold(k), k), reverse=True)

    cap = max_groups if max_groups is not None else FINDER_MAX_MATCH_GROUPS
    keys = all_keys[:cap] if cap > 0 and len(all_keys) > cap else all_keys
    representatives = [listings[groups[k][0]] for k in keys]
    if FINDER_CLAUDE_MATCH and representatives:
        batch_clean = await claude_clean_titles_batch([r.get("title", "") for r in representatives])
        for rep, cleaned in zip(representatives, batch_clean):
            rep["_prefetched_claude"] = cleaned

    logger.info(
        "total_listings=%d unique_titles=%d groups_attempted=%d groups_skipped=%d",
        len(listings),
        len(groups),
        len(keys),
        max(0, len(all_keys) - len(keys)),
    )
    if representatives:
        sample = representatives[0].get("title", "")
        logger.info(
            "clean_query_sample in=%r out=%r",
            sample[:80],
            clean_query(sample),
        )

    serp_cache: dict[str, list[dict]] = {}
    effective = min(concurrency, _MAX_BATCH_CONCURRENCY)
    semaphore = asyncio.Semaphore(effective)
    stats_counters = {"cached_miss": 0, "raw_matched": 0, "captcha_abort": 0}

    async with AsyncSession() as img_session, AsyncSession() as serp_session:

        async def _match_rep(rep: dict) -> dict:
            if captcha_abort():
                stats_counters["captcha_abort"] += 1
                return _apply_match(
                    rep,
                    {
                        "amazon_asin": None,
                        "match_confidence": 0.0,
                        "match_method": "captcha_abort",
                        "clean_title": clean_query(rep.get("title", "")),
                    },
                )
            async with semaphore:
                res = await match_listing(
                    rep,
                    img_session=img_session,
                    serp_session=serp_session,
                    serp_cache=serp_cache,
                    skip_miss_cache=skip_miss_cache,
                )
                method = res.get("match_method")
                if method == "cached_miss":
                    stats_counters["cached_miss"] += 1
                elif res.get("amazon_asin"):
                    stats_counters["raw_matched"] += 1
                await asyncio.sleep(0.22 if _claude_enabled() else 0.05)
                return res

        matched_reps = await asyncio.gather(*[_match_rep(r) for r in representatives])

    matched_reps = reject_suspicious_ebay_detail_dupes(list(matched_reps))
    rejected = sum(1 for m in matched_reps if m.get("match_method") == "ebay_detail_rejected")
    if rejected:
        logger.warning(
            "Rejected %d ebay_detail match(es) — same ASIN on 3+ listings (template noise)",
            rejected,
        )

    rep_by_key = {
        clean_query(rep.get("title", "")).lower(): matched
        for rep, matched in zip(representatives, matched_reps)
    }
    out = list(listings)
    for key in keys:
        template = rep_by_key.get(key, {})
        for idx in groups[key]:
            out[idx] = _copy_match_fields(template, dict(listings[idx]))

    method_counts = Counter(m.get("match_method") for m in matched_reps)
    logger.info("match_method_distribution %s", dict(method_counts))

    stats = {
        "groups_total": len(all_keys),
        "groups_attempted": len(keys),
        "groups_skipped": max(0, len(all_keys) - len(keys)),
        "captcha_aborted": captcha_abort(),
        "match_cached_miss": stats_counters["cached_miss"],
        "match_raw_before_filter": stats_counters["raw_matched"],
        "match_methods": dict(method_counts),
    }
    return out, stats
