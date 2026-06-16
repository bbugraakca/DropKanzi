import importlib

import pytest

from tests.fixtures.ebay_sold_sample import BROKEN_HTML, EMPTY_HTML, SAMPLE_SOLD_CARD


def test_parse_sold_listings_extracts_title_and_price():
    from ebay_scraper import parse_sold_listings

    items = parse_sold_listings(SAMPLE_SOLD_CARD)
    assert len(items) == 1
    row = items[0]
    assert "Test Widget Pro" in row["title"]
    assert row["sold_price"] == pytest.approx(19.99)
    assert row.get("listing_id") == "123456789012"


def test_parse_sold_listings_empty_html():
    from ebay_scraper import parse_sold_listings

    assert parse_sold_listings(EMPTY_HTML) == []


def test_parse_sold_listings_broken_card_skipped():
    from ebay_scraper import parse_sold_listings

    assert parse_sold_listings(BROKEN_HTML) == []


def test_force_proxy_raises_when_proxy_missing(monkeypatch):
    monkeypatch.setenv("FORCE_PROXY", "true")
    proxy_http = importlib.reload(importlib.import_module("proxy_http"))
    monkeypatch.setattr(proxy_http, "get_proxy_url", lambda: None)
    monkeypatch.setattr(proxy_http, "get_datacenter_proxy_url", lambda: None)

    with pytest.raises(proxy_http.ProxyRequiredError):
        proxy_http.ensure_proxy("residential")


def test_force_proxy_allows_no_proxy_when_disabled(monkeypatch):
    monkeypatch.setenv("FORCE_PROXY", "false")
    proxy_http = importlib.reload(importlib.import_module("proxy_http"))
    monkeypatch.setattr(proxy_http, "get_proxy_url", lambda: None)

    assert proxy_http.ensure_proxy("residential") is None
