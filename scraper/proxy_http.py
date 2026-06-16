import os
from typing import Literal

from proxy import get_proxy_url, get_datacenter_proxy_url

FORCE_PROXY = os.getenv("FORCE_PROXY", "false").lower() in ("1", "true", "yes")


class ProxyRequiredError(RuntimeError):
    pass


def pick_proxy(tier: Literal["datacenter", "residential"]) -> str | None:
    if tier == "datacenter":
        return get_datacenter_proxy_url()
    return get_proxy_url()


def ensure_proxy(tier: Literal["datacenter", "residential"]) -> dict | None:
    url = pick_proxy(tier)
    if FORCE_PROXY and not url:
        raise ProxyRequiredError(f"Missing {tier} proxy while FORCE_PROXY=true")
    return {"http": url, "https": url} if url else None
