import os
from typing import Any

_client: Any = None
_provider: str | None = None


def get_llm_client() -> tuple[str | None, Any | None]:
    global _client, _provider
    if _client is not None:
        return _provider, _client

    primary = os.getenv("FINDER_LLM_PRIMARY", "claude").strip().lower()
    fallback = os.getenv("FINDER_LLM_FALLBACK", "").strip().lower()
    for provider in (primary, fallback):
        if provider == "claude":
            key = os.getenv("ANTHROPIC_API_KEY", "").strip()
            if not key:
                continue
            try:
                import anthropic

                _client = anthropic.AsyncAnthropic(api_key=key)
                _provider = "claude"
                return _provider, _client
            except Exception:
                continue
        if provider == "gemini":
            key = os.getenv("GEMINI_API_KEY", "").strip()
            if not key:
                continue
            try:
                import google.generativeai as genai  # type: ignore

                genai.configure(api_key=key)
                _client = genai
                _provider = "gemini"
                return _provider, _client
            except Exception:
                continue
    return None, None
