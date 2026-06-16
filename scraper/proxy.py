import os

from dotenv import load_dotenv

load_dotenv()

DEFAULT_HOST = "gw.dataimpulse.com"
DEFAULT_PORT = "823"
DEFAULT_DC_HOST = "dc.dataimpulse.com"
DEFAULT_DC_PORT = "823"


def get_proxy_url() -> str | None:
    user = os.getenv("PROXY_USER")
    password = os.getenv("PROXY_PASS")
    if not user or not password:
        return None
    country = (os.getenv("PROXY_COUNTRY") or "").strip().lower()
    if country and f"__cr.{country}" not in user:
        user = f"{user}__cr.{country}"
    host = os.getenv("PROXY_HOST", DEFAULT_HOST)
    port = os.getenv("PROXY_PORT", DEFAULT_PORT)
    return f"http://{user}:{password}@{host}:{port}"


def get_datacenter_proxy_url() -> str | None:
    user = os.getenv("DC_PROXY_USER") or os.getenv("PROXY_USER")
    password = os.getenv("DC_PROXY_PASS") or os.getenv("PROXY_PASS")
    if not user or not password:
        return None
    host = os.getenv("DC_PROXY_HOST") or os.getenv("PROXY_HOST") or DEFAULT_HOST
    port = os.getenv("DC_PROXY_PORT") or os.getenv("PROXY_PORT") or DEFAULT_PORT
    return f"http://{user}:{password}@{host}:{port}"
