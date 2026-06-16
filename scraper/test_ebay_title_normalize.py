"""Tests for aggressive eBay title normalization."""

from ebay_title_normalize import normalize_ebay_title


def test_strips_lot_and_shipping_noise():
    raw = "Lot of 2 Philips Sonicare Brush Heads HX9023 NEW SEALED Free Shipping"
    out = normalize_ebay_title(raw)
    assert "HX9023" in out
    assert "Philips" in out
    assert "Sonicare" in out
    assert "lot of" not in out.lower()
    assert "free shipping" not in out.lower()
    assert "sealed" not in out.lower()


def test_preserves_model_number():
    assert "SM-G991B" in normalize_ebay_title("Samsung Galaxy SM-G991B NIB Fast Shipping")


def test_oem_at_edges_only():
    assert "widget" in normalize_ebay_title("OEM widget part 123").lower()
    assert "OEM" not in normalize_ebay_title("OEM widget 123").upper().split()


def test_read_description_removed():
    out = normalize_ebay_title("Honeywell Filter READ DESCRIPTION HX9000")
    assert "READ" not in out.upper()
    assert "HX9000" in out
