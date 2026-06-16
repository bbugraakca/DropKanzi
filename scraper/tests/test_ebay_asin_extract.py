"""eBay listing HTML must not yield template tokens as ASINs."""

import pytest

from asin_util import is_ebay_detail_asin, is_plausible_product_asin

EBAY_TEMPLATE_HTML = """
<html><body>
<script>window.__ASIN__ = "JLZNJLC2HE";</script>
<meta name="description" content="ASIN: JLZNJLC2HE">
<span>Amazon Standard Identification Number JLZNJLC2HE</span>
</body></html>
"""

VALID_DP_HTML = """
<p>Also available on
<a href="https://www.amazon.com/dp/B0CP4CG1ZB">Amazon</a>
</p>
"""

GP_PRODUCT_HTML = """
<a href="https://www.amazon.com/gp/product/B08N5WRWNW">Buy on Amazon</a>
"""


def test_extract_asin_ignores_ebay_template_labeled_token():
    from ebay_scraper import _extract_asin_from_html

    assert _extract_asin_from_html(EBAY_TEMPLATE_HTML) is None


def test_extract_asin_from_amazon_dp_link():
    from ebay_scraper import _extract_asin_from_html

    hit = _extract_asin_from_html(VALID_DP_HTML)
    assert hit == {"asin": "B0CP4CG1ZB", "source": "dp_link"}


def test_extract_asin_from_gp_product_link():
    from ebay_scraper import _extract_asin_from_html

    hit = _extract_asin_from_html(GP_PRODUCT_HTML)
    assert hit == {"asin": "B08N5WRWNW", "source": "dp_link"}


def test_jlznjlc2he_is_not_plausible_product_asin():
    assert not is_plausible_product_asin("JLZNJLC2HE")
    assert not is_ebay_detail_asin("JLZNJLC2HE", source="dp_link")


def test_modern_asin_passes_product_check():
    assert is_plausible_product_asin("B0CP4CG1ZB")
    assert is_ebay_detail_asin("B0CP4CG1ZB", source="dp_link")


def test_labeled_source_rejected_for_ebay_detail():
    assert not is_ebay_detail_asin("B0CP4CG1ZB", source="labeled")


def test_strip_suspicious_ebay_detail_dupes():
    from asin_util import reject_suspicious_ebay_detail_dupes

    rows = [
        {"title": f"item-{i}", "amazon_asin": "B0FAKEASIN", "match_method": "ebay_detail"}
        for i in range(4)
    ] + [
        {"title": "serp-ok", "amazon_asin": "B0CP4CG1ZB", "match_method": "search_query_1"},
    ]
    out = reject_suspicious_ebay_detail_dupes(rows)
    rejected = [r for r in out if r.get("match_method") == "ebay_detail_rejected"]
    assert len(rejected) == 4
    serp = [r for r in out if r.get("match_method") == "search_query_1"]
    assert len(serp) == 1
    assert serp[0]["amazon_asin"] == "B0CP4CG1ZB"
