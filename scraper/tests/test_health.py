import importlib

import pytest


def _heavy_deps_available() -> bool:
    for name in ("curl_cffi", "torch", "transformers"):
        try:
            importlib.import_module(name)
        except ImportError:
            return False
    return True


@pytest.mark.skipif(not _heavy_deps_available(), reason="full scraper requirements not installed")
def test_main_app_imports():
    mod = importlib.import_module("main")
    assert hasattr(mod, "app")


@pytest.mark.skipif(not _heavy_deps_available(), reason="full scraper requirements not installed")
def test_health_endpoint():
    from fastapi.testclient import TestClient
    from main import app

    with TestClient(app) as client:
        res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body.get("status") == "ok"
