"""Redis cache for title→ASIN match results (avoids repeat Amazon SERP lookups)."""

import hashlib
import json
import logging
import os

logger = logging.getLogger("pricehawk.match_cache")

_TTL = 7 * 86400  # 7 days — successful matches
_MISS_TTL = int(os.getenv("FINDER_MISS_CACHE_TTL", "172800"))  # 48h — failed lookups
_client = None
_checked = False

logger.info("match_cache miss_ttl=%ds (%dh)", _MISS_TTL, _MISS_TTL // 3600)


def _redis():
    global _client, _checked
    if _checked:
        return _client
    _checked = True
    url = os.getenv("REDIS_URL")
    if not url:
        return None
    try:
        import redis  # type: ignore

        _client = redis.from_url(url, decode_responses=True)
        _client.ping()
    except Exception as exc:  # noqa: BLE001
        logger.debug("Match cache disabled: %s", exc)
        _client = None
    return _client


def _key(clean_title: str) -> str:
    digest = hashlib.sha256(clean_title.lower().encode()).hexdigest()[:24]
    return f"pf:m:{digest}"


def get_match(clean_title: str) -> dict | None:
    r = _redis()
    if not r or not clean_title:
        return None
    try:
        raw = r.get(_key(clean_title))
        if not raw:
            return None
        payload = json.loads(raw)
        return payload if isinstance(payload, dict) else None
    except Exception:  # noqa: BLE001
        return None


def is_cached_miss(payload: dict | None) -> bool:
    return bool(payload and payload.get("_miss"))


def set_miss(clean_title: str) -> None:
    """Remember a failed match so we skip repeat Amazon SERP (saves proxy $)."""
    r = _redis()
    if not r or not clean_title:
        return
    try:
        r.setex(
            _key(clean_title),
            _MISS_TTL,
            json.dumps(
                {
                    "_miss": True,
                    "amazon_asin": None,
                    "match_confidence": 0.0,
                    "match_method": "cached_miss",
                }
            ),
        )
    except Exception:  # noqa: BLE001
        pass


def clear_miss_cache() -> int:
    """Delete cached no-match entries so a fresh scan can retry Amazon SERP."""
    r = _redis()
    if not r:
        return 0
    deleted = 0
    try:
        for key in r.scan_iter("pf:m:*"):
            raw = r.get(key)
            if not raw:
                continue
            try:
                payload = json.loads(raw)
            except Exception:  # noqa: BLE001
                continue
            if payload.get("_miss"):
                r.delete(key)
                deleted += 1
    except Exception:  # noqa: BLE001
        pass
    return deleted


def clear_misses() -> int:
    """Remove stale low-confidence hits (keeps _miss entries to save proxy)."""
    r = _redis()
    if not r:
        return 0
    deleted = 0
    try:
        for key in r.scan_iter("pf:m:*"):
            raw = r.get(key)
            if not raw:
                continue
            try:
                payload = json.loads(raw)
            except Exception:  # noqa: BLE001
                continue
            if payload.get("_miss"):
                continue
            if not payload.get("amazon_asin"):
                continue
            if float(payload.get("match_confidence") or 0) < 0.80:
                r.delete(key)
                deleted += 1
    except Exception:  # noqa: BLE001
        pass
    return deleted


def set_match(clean_title: str, payload: dict) -> None:
    """Cache only successful ASIN matches."""
    if not payload.get("amazon_asin"):
        return
    r = _redis()
    if not r or not clean_title:
        return
    try:
        r.setex(_key(clean_title), _TTL, json.dumps(payload))
    except Exception:  # noqa: BLE001
        pass
