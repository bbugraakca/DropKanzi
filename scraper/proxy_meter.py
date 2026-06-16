"""Per-request proxy bandwidth / cost meter with per-stage breakdown."""

import contextvars
import json
import os
from datetime import datetime, timezone
from pathlib import Path

_meter: contextvars.ContextVar[dict | None] = contextvars.ContextVar(
    "proxy_meter", default=None
)
_stage: contextvars.ContextVar[str] = contextvars.ContextVar(
    "proxy_stage", default="other"
)

_STATS_PATH = Path(os.getenv("BANDWIDTH_STATS_FILE", "/tmp/pricehawk_bandwidth.json"))


def start() -> dict:
    """Begin a fresh meter for the current request context."""
    counter = {"bytes": 0, "requests": 0, "stages": {}}
    _meter.set(counter)
    _stage.set("other")
    return counter


def stage(name: str) -> None:
    """Mark the pipeline stage that subsequent proxied traffic belongs to."""
    _stage.set(name)


def _load_persistent_stats() -> dict:
    if not _STATS_PATH.exists():
        return {"days": {}, "months": {}}
    try:
        return json.loads(_STATS_PATH.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {"days": {}, "months": {}}


def _save_persistent_stats(data: dict) -> None:
    try:
        _STATS_PATH.parent.mkdir(parents=True, exist_ok=True)
        _STATS_PATH.write_text(json.dumps(data), encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


def _record_persistent_bytes(num_bytes: int) -> None:
    if num_bytes <= 0:
        return
    now = datetime.now(timezone.utc)
    day_key = now.strftime("%Y-%m-%d")
    month_key = now.strftime("%Y-%m")
    data = _load_persistent_stats()
    days = data.setdefault("days", {})
    months = data.setdefault("months", {})
    days[day_key] = int(days.get(day_key, 0)) + num_bytes
    months[month_key] = int(months.get(month_key, 0)) + num_bytes
    _save_persistent_stats(data)


def add(num_bytes: int | None) -> None:
    if not num_bytes:
        return
    counter = _meter.get()
    if counter is None:
        return
    n = int(num_bytes)
    counter["bytes"] += n
    counter["requests"] += 1
    bucket = counter["stages"].setdefault(_stage.get(), {"bytes": 0, "requests": 0})
    bucket["bytes"] += n
    bucket["requests"] += 1
    _record_persistent_bytes(n)


def add_response(resp) -> None:
    """Record the byte size of a proxied curl_cffi response (best effort)."""
    try:
        body = getattr(resp, "content", None)
        if body is not None:
            add(len(body))
    except Exception:  # noqa: BLE001
        pass


def cost_per_gb() -> float:
    try:
        return float(os.getenv("PROXY_COST_PER_GB", "1.0"))
    except (TypeError, ValueError):
        return 1.0


def _cost(num_bytes: int) -> float:
    return round(num_bytes / (1024**3) * cost_per_gb(), 4)


def _bytes_to_gb(num_bytes: int) -> float:
    return round(num_bytes / (1024**3), 4)


def get_bandwidth_totals() -> dict:
    """Rolling today + calendar month bandwidth from persistent counter."""
    now = datetime.now(timezone.utc)
    day_key = now.strftime("%Y-%m-%d")
    month_key = now.strftime("%Y-%m")
    data = _load_persistent_stats()
    today_bytes = int(data.get("days", {}).get(day_key, 0))
    month_bytes = int(data.get("months", {}).get(month_key, 0))
    return {
        "today_gb": _bytes_to_gb(today_bytes),
        "today_cost_usd": _cost(today_bytes),
        "month_gb": _bytes_to_gb(month_bytes),
        "month_cost_usd": _cost(month_bytes),
    }


def summarize(extra_bytes: int = 0) -> dict:
    counter = _meter.get() or {"bytes": 0, "requests": 0, "stages": {}}
    total = counter["bytes"] + max(0, int(extra_bytes or 0))
    if extra_bytes and int(extra_bytes) > 0:
        _record_persistent_bytes(int(extra_bytes))
    stage_costs = {
        name: {
            "bytes": s["bytes"],
            "requests": s["requests"],
            "cost_usd": _cost(s["bytes"]),
        }
        for name, s in counter["stages"].items()
    }
    return {
        "proxy_bytes": total,
        "proxy_mb": round(total / (1024 * 1024), 2),
        "proxy_requests": counter["requests"],
        "proxy_cost_usd": _cost(total),
        "proxy_cost_per_gb": cost_per_gb(),
        "proxy_stages": stage_costs,
        "bytes_downloaded": total,
    }
