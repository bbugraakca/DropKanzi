import json
import os
from typing import Any

_redis_client = None


def _redis():
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    url = os.getenv("REDIS_URL")
    if not url:
        return None
    try:
        import redis  # type: ignore

        _redis_client = redis.from_url(url, decode_responses=True)
        _redis_client.ping()
    except Exception:
        _redis_client = None
    return _redis_client


def publish_progress(job_id: str | None, payload: dict[str, Any]) -> None:
    if not job_id:
        return
    r = _redis()
    if not r:
        return
    try:
        r.publish(f"pf:progress:{job_id}", json.dumps(payload, ensure_ascii=False))
    except Exception:
        pass


def cancel_key(job_id: str) -> str:
    return f"pf:cancel:{job_id}"


def request_cancel(job_id: str) -> None:
    r = _redis()
    if not r:
        return
    try:
        r.setex(cancel_key(job_id), 3600, "1")
    except Exception:
        pass


def is_cancelled(job_id: str | None) -> bool:
    if not job_id:
        return False
    r = _redis()
    if not r:
        return False
    try:
        return bool(r.get(cancel_key(job_id)))
    except Exception:
        return False
