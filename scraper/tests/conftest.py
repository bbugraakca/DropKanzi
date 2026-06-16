"""Test bootstrap: stub optional native deps so parser/unit tests run without full ML stack."""
import sys
from types import ModuleType


def _ensure_module(name: str, factory):
    if name not in sys.modules:
        sys.modules[name] = factory()


def _stub_curl_cffi():
    curl = ModuleType("curl_cffi")
    requests_mod = ModuleType("curl_cffi.requests")

    class AsyncSession:  # noqa: D101 — test stub
        pass

    requests_mod.AsyncSession = AsyncSession
    curl.requests = requests_mod
    sys.modules["curl_cffi"] = curl
    sys.modules["curl_cffi.requests"] = requests_mod


_stub_curl_cffi()
