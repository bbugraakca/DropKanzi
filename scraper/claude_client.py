"""
Central Anthropic API gateway for Product Finder.

RULE: ALL Anthropic API calls MUST go through send_to_claude().
Direct anthropic client usage (client.messages.create(...)) is FORBIDDEN anywhere
else in the codebase. This guarantees the vision cost guard and concurrency
semaphore apply to every call (title clean, arbitration, vision).
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Optional

logger = logging.getLogger("pricehawk.claude_client")

_CLAUDE_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")
_DEFAULT_TIMEOUT = float(os.getenv("FINDER_CLAUDE_TIMEOUT_SEC", "10"))
_VISION_MATCH = os.getenv("FINDER_VISION_MATCH", "false").lower() in ("1", "true", "yes")
_TITLE_IMAGE = os.getenv("FINDER_CLAUDE_TITLE_IMAGE", "false").lower() in ("1", "true", "yes")

_claude_client: Any = None
_CLAUDE_SEM: asyncio.Semaphore | None = None


class VisionNotAllowedError(RuntimeError):
    """Raised when a vision/image API call is blocked by env guards."""


def claude_api_sem() -> asyncio.Semaphore:
    global _CLAUDE_SEM
    if _CLAUDE_SEM is None:
        n = max(1, int(os.getenv("FINDER_CLAUDE_MAX_CONCURRENCY", "4")))
        _CLAUDE_SEM = asyncio.Semaphore(n)
    return _CLAUDE_SEM


def api_enabled() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY", "").strip())


def get_claude_client() -> Any | None:
    global _claude_client
    if not api_enabled():
        return None
    if _claude_client is None:
        try:
            import anthropic

            _claude_client = anthropic.AsyncAnthropic()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Anthropic client unavailable: %s", exc)
            return None
    return _claude_client


def title_clean_success(parsed: dict | None) -> bool:
    """True only when Claude returned a non-empty search_queries list."""
    if parsed is None:
        return False
    queries = parsed.get("search_queries")
    return isinstance(queries, list) and len(queries) > 0


def compute_rank_gap(ranked: list[dict]) -> tuple[int, int, int]:
    """
    Return (top1_score, top2_score, gap).
    Single candidate: top2 = top1 so gap = 0 (no false 'clear separation').
    """
    if not ranked:
        return 0, 0, 0
    top1 = int(ranked[0].get("match_score") or 0)
    top2 = int(ranked[1].get("match_score") or 0) if len(ranked) >= 2 else top1
    return top1, top2, top1 - top2


def _messages_have_image(messages: list) -> bool:
    for msg in messages:
        content = msg.get("content") if isinstance(msg, dict) else None
        if not isinstance(content, list):
            continue
        for block in content:
            if isinstance(block, dict) and block.get("type") == "image":
                return True
    return False


def _assert_vision_allowed(*, purpose: str, messages: list) -> None:
    has_image = _messages_have_image(messages)
    if not has_image:
        return
    if purpose == "vision" and not _VISION_MATCH:
        raise VisionNotAllowedError("FINDER_VISION_MATCH is disabled")
    if purpose == "title_clean" and not _TITLE_IMAGE:
        raise VisionNotAllowedError("FINDER_CLAUDE_TITLE_IMAGE is disabled")


async def send_to_claude(
    *,
    purpose: str,
    messages: list,
    max_tokens: int,
    system: str | None = None,
    temperature: float | None = None,
    timeout: float | None = None,
    client: Any | None = None,
) -> Any:
    """
    Single entry point for all Anthropic messages.create calls.

    purpose: title_clean | arbitration | vision
    """
    _assert_vision_allowed(purpose=purpose, messages=messages)

    api_client = client or get_claude_client()
    if api_client is None:
        raise RuntimeError("Anthropic client not available")

    kwargs: dict[str, Any] = {
        "model": _CLAUDE_MODEL,
        "max_tokens": max_tokens,
        "messages": messages,
    }
    if system is not None:
        kwargs["system"] = system
    if temperature is not None:
        kwargs["temperature"] = temperature

    wait = timeout if timeout is not None else _DEFAULT_TIMEOUT
    async with claude_api_sem():
        return await asyncio.wait_for(
            api_client.messages.create(**kwargs),
            timeout=wait,
        )
