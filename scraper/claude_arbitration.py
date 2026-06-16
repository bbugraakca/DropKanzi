"""
Claude arbitration layer — last-resort tie-breaker when multi-signal scoring is ambiguous.

Runs only when FINDER_CLAUDE_ARBITRATION=true (or legacy FINDER_CLAUDE_MATCH), score band 50–75,
and no UPC/MPN signal on the best candidate.
"""

from __future__ import annotations

import asyncio
import contextvars
import hashlib
import json
import logging
import os
import re
from typing import Any, Optional

from asin_util import is_plausible_asin
from claude_client import compute_rank_gap, send_to_claude
from ebay_title_normalize import normalize_ebay_title

logger = logging.getLogger("pricehawk.claude_arbitration")

_SCORE_MIN = int(os.getenv("FINDER_CLAUDE_SCORE_MIN", "50"))
_SCORE_MAX = int(os.getenv("FINDER_CLAUDE_SCORE_MAX", "75"))
_GAP_SOFT = int(os.getenv("FINDER_CLAUDE_GAP_SOFT", "8"))
_MAX_CALLS = int(os.getenv("FINDER_CLAUDE_MAX_CALLS", "20"))
_CLAUDE_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")

_MATCH_TTL = 7 * 86400
_NONE_TTL = 86400

_ASIN_TOKEN_RE = re.compile(r"\b([A-Z0-9]{10})\b")

_run_ctx: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "claude_arbitration_run", default=None
)

_redis_checked = False
_redis_client = None


def reset_run_context() -> None:
    """Call once at the start of each analyze batch."""
    _run_ctx.set({"calls": 0, "asin_counts": {}})


def claude_calls_this_run() -> int:
    return int(_run_state().get("calls") or 0)


def claude_api_sem() -> asyncio.Semaphore:
    """Re-export for backward compatibility."""
    from claude_client import claude_api_sem as _sem

    return _sem()


def _run_state() -> dict[str, Any]:
    ctx = _run_ctx.get()
    if ctx is None:
        ctx = {"calls": 0, "asin_counts": {}}
        _run_ctx.set(ctx)
    return ctx


def claude_arbitration_enabled() -> bool:
    explicit = os.getenv("FINDER_CLAUDE_ARBITRATION")
    if explicit is not None:
        return explicit.strip().lower() in ("1", "true", "yes")
    return False


def _redis():
    global _redis_client, _redis_checked
    if _redis_checked:
        return _redis_client
    _redis_checked = True
    url = os.getenv("REDIS_URL")
    if not url:
        return None
    try:
        import redis  # type: ignore

        _redis_client = redis.from_url(url, decode_responses=True)
        _redis_client.ping()
    except Exception as exc:  # noqa: BLE001
        logger.debug("Claude arbitration cache disabled: %s", exc)
        _redis_client = None
    return _redis_client


def cache_key(
    normalized_title: str,
    *,
    brand: str | None = None,
    mpn: str | None = None,
    seller_id: str | None = None,
) -> str:
    raw = f"{normalized_title}|{brand or ''}|{mpn or ''}|{seller_id or ''}"
    return f"claude_match:{hashlib.sha1(raw.encode()).hexdigest()}"


def _cache_get(key: str) -> dict | None:
    r = _redis()
    if not r:
        return None
    try:
        raw = r.get(key)
        if not raw:
            return None
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except Exception:  # noqa: BLE001
        return None


def _cache_set_match(key: str, payload: dict) -> None:
    r = _redis()
    if not r:
        return
    try:
        r.setex(key, _MATCH_TTL, json.dumps(payload))
    except Exception:  # noqa: BLE001
        pass


def _cache_set_none(key: str) -> None:
    r = _redis()
    if not r:
        return
    try:
        r.setex(key, _NONE_TTL, json.dumps({"_none": True}))
    except Exception:  # noqa: BLE001
        pass


def should_accept_asin_assignment(asin: str) -> bool:
    """Run-scoped 3+ reuse guard. Returns False when this assignment must be rejected."""
    if not asin or not is_plausible_asin(asin):
        return False
    asin = asin.upper()
    state = _run_state()
    counts: dict[str, int] = state.setdefault("asin_counts", {})
    counts[asin] = counts.get(asin, 0) + 1
    if counts[asin] >= 3:
        logger.warning("[claude_arbitration] ASIN %s assigned %d times this run — rejected", asin, counts[asin])
        return False
    return True


def claude_confidence(best_score: int) -> float:
    return round(max(0.82, min(0.88, 0.80 + (best_score - 50) / 250)), 4)


def is_eligible(
    ranked: list[dict],
    *,
    best_score: int,
    gap: int,
    title_clean_success: bool = False,
) -> bool:
    if not ranked:
        return False
    if not claude_arbitration_enabled():
        return False
    if not os.getenv("ANTHROPIC_API_KEY", "").strip():
        return False

    # Successful title clean already produced queries; skip arbitration.
    if title_clean_success:
        return False

    flags = ranked[0].get("signal_flags") or {}
    if flags.get("upc") or flags.get("mpn"):
        return False

    if best_score < _SCORE_MIN or best_score >= _SCORE_MAX:
        return False

    state = _run_state()
    if int(state.get("calls") or 0) >= _MAX_CALLS:
        return False

    # SOFT gap: only skip Claude on upper band when candidates are clearly separated.
    if best_score >= 70 and gap >= _GAP_SOFT:
        return False

    return True


def _parse_claude_asin(text: str, allowed: set[str]) -> Optional[str]:
    text = (text or "").strip().upper()
    if not text or text == "NONE":
        return None
    if text.split()[0] == "NONE":
        return None
    m = _ASIN_TOKEN_RE.search(text)
    if not m:
        return None
    asin = m.group(1).upper()
    if not is_plausible_asin(asin) or asin not in allowed:
        return None
    return asin


async def _call_claude_api(
    *,
    ebay_title: str,
    top_candidates: list[dict],
    client: Any | None = None,
) -> str:
    lines = ["CANDIDATES:"]
    for i, c in enumerate(top_candidates[:3], start=1):
        title = str(c.get("title") or "")[:120]
        asin = str(c.get("asin") or "").upper()
        lines.append(f"{i}. ASIN: {asin} | TITLE: {title}")
    user_msg = f"EBAY_TITLE: {ebay_title[:200]}\n" + "\n".join(lines)

    response = await send_to_claude(
        purpose="arbitration",
        client=client,
        max_tokens=20,
        temperature=0,
        system=(
            "You match an eBay product to the correct Amazon ASIN. "
            "Reply ONLY with the matching ASIN (10 chars) or NONE. No explanation."
        ),
        messages=[{"role": "user", "content": user_msg}],
    )
    block = response.content[0]
    return getattr(block, "text", str(block)).strip()


async def try_claude_arbitration(
    *,
    ebay_title: str,
    ranked_candidates: list[dict],
    brand: str | None = None,
    mpn: str | None = None,
    seller_id: str | None = None,
    claude_client: Any | None = None,
    title_clean_success: bool = False,
) -> Optional[dict]:
    """
    Attempt Claude tie-break. Returns match dict or None.
    Caller must still run should_accept_asin_assignment via _apply_match.
    """
    if not ranked_candidates:
        return None

    ranked = sorted(ranked_candidates, key=lambda c: int(c.get("match_score") or 0), reverse=True)
    best_score, _top2, gap = compute_rank_gap(ranked)

    if not is_eligible(
        ranked,
        best_score=best_score,
        gap=gap,
        title_clean_success=title_clean_success,
    ):
        return None

    normalized = normalize_ebay_title(ebay_title)
    key = cache_key(normalized, brand=brand, mpn=mpn, seller_id=seller_id)

    cached = _cache_get(key)
    if cached:
        if cached.get("_none"):
            return None
        asin = str(cached.get("amazon_asin") or "").upper()
        if is_plausible_asin(asin):
            return {
                "amazon_asin": asin,
                "amazon_price": cached.get("amazon_price"),
                "match_confidence": float(cached.get("match_confidence") or claude_confidence(best_score)),
                "match_method": "claude_arbitration",
                "amazon_title": cached.get("amazon_title"),
            }

    if claude_client is None:
        from claude_client import get_claude_client

        claude_client = get_claude_client()
        if claude_client is None:
            logger.warning("claude_failed client_init")
            return None

    top3 = ranked[:3]
    allowed = {str(c.get("asin") or "").upper() for c in top3 if c.get("asin")}

    state = _run_state()
    state["calls"] = int(state.get("calls") or 0) + 1
    call_n = state["calls"]

    logger.info(
        "claude_call title=%r score=%d gap=%d candidates=%s n=%d",
        normalized[:60],
        best_score,
        gap,
        sorted(allowed),
        call_n,
    )
    if call_n >= _MAX_CALLS:
        logger.info("Claude call budget reached n=%d", call_n)

    try:
        raw = await _call_claude_api(
            ebay_title=normalized,
            top_candidates=top3,
            client=claude_client,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("claude_failed error=%s", exc)
        return None

    text = raw.strip().upper()
    if text == "NONE" or text.startswith("NONE"):
        _cache_set_none(key)
        return None

    asin = _parse_claude_asin(text, allowed)
    if not asin:
        return None

    pick = next((c for c in top3 if str(c.get("asin")).upper() == asin), top3[0])
    conf = claude_confidence(best_score)
    hit = {
        "amazon_asin": asin,
        "amazon_price": pick.get("price"),
        "price_source": "serp" if pick.get("price") is not None else None,
        "match_confidence": conf,
        "match_method": "claude_arbitration",
        "amazon_title": str(pick.get("title") or "").lower(),
    }
    _cache_set_match(
        key,
        {
            "amazon_asin": asin,
            "amazon_price": pick.get("price"),
            "match_confidence": conf,
            "amazon_title": hit["amazon_title"],
        },
    )
    return hit


# Test helpers
def score_min() -> int:
    return _SCORE_MIN


def score_max() -> int:
    return _SCORE_MAX


def gap_soft() -> int:
    return _GAP_SOFT


def max_calls() -> int:
    return _MAX_CALLS
