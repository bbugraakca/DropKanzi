"""Unit tests for multi-signal match scoring (10-rule system)."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import imagehash
import pytest
from PIL import Image

from asin_util import is_plausible_asin
from match_score import (
    PHASH_MAX_DISTANCE,
    SCORE_BRAND,
    SCORE_BRAND_TITLE_BONUS,
    SCORE_MPN,
    SCORE_PHASH,
    SCORE_TITLE,
    SCORE_UPC,
    clear_phash_cache,
    compute_score,
    extract_brand,
    extract_mpns,
    extract_upc,
    get_phash_sync,
    mpn_in_title,
    mpn_in_text,
    candidate_text_blob,
    match_gap_bypass_score,
    normalize_mpn,
    phash_cache_size,
    phash_hamming,
    qualifies_match,
    score_to_confidence,
    upc_matches,
)


def test_normalize_mpn_separators():
    assert normalize_mpn("14-227") == "14227"
    assert normalize_mpn("14 227") == "14227"
    assert normalize_mpn("14/227") == "14227"


def test_extract_mpns_from_title():
    mpns = extract_mpns("SKIL Part # 14-227 Circular Saw Blade")
    assert "14227" in mpns


def test_extract_mpns_rejects_black_steel_words():
    mpns = extract_mpns("BLACK STEEL LARGE Widget Part # 14-227")
    assert "BLACK" not in mpns
    assert "STEEL" not in mpns
    assert "LARGE" not in mpns
    assert "14227" in mpns


def test_extract_mpns_ignores_pack_quantity():
    mpns = extract_mpns("Milwaukee Pack of 2 x2 Impact Socket Set Model 48-32-5033")
    assert "X2" not in mpns
    assert "2PACK" not in mpns
    assert any("5033" in m for m in mpns)


def test_extract_mpns_pack_of_does_not_block_labeled_part():
    mpns = extract_mpns("Pack of 2 SKIL Part # 14-227 Circular Saw Blade")
    assert "14227" in mpns


def test_phash_unavailable_does_not_block_upc():
    score, _, _, flags = compute_score(
        ebay_upc="012345678905",
        ebay_mpns=[],
        ebay_brand=None,
        phash_distance=None,
        title_similarity=0.0,
        candidate={"title": "x", "upc": "012345678905"},
    )
    assert flags["phash"] is False
    assert score == SCORE_UPC
    assert qualifies_match(score)


def test_extract_upc():
    assert extract_upc("Widget UPC 012345678905 extra") == "012345678905"


def test_upc_match():
    assert upc_matches("012345678905", {"title": "Product", "upc": "012345678905"})


def test_mpn_in_title():
    assert mpn_in_title(["14227"], "SKIL 14-227 Premium Blade")


def test_compute_score_upc_only():
    score, method, _, flags = compute_score(
        ebay_upc="012345678905",
        ebay_mpns=[],
        ebay_brand=None,
        phash_distance=None,
        title_similarity=0.0,
        candidate={"title": "x", "upc": "012345678905"},
    )
    assert score == SCORE_UPC
    assert method == "score_upc"
    assert flags["upc"]


def test_compute_score_mpn_only_qualifies_at_default_threshold():
    score, _, _, _ = compute_score(
        ebay_upc=None,
        ebay_mpns=["14227"],
        ebay_brand=None,
        phash_distance=None,
        title_similarity=0.0,
        candidate={"title": "SKIL 14227 blade"},
    )
    assert score == SCORE_MPN
    assert qualifies_match(score)


def test_madde1_brand_title_bonus_skala():
    """MPN'siz: brand+title bonus+phash = 110."""
    score, method, _, flags = compute_score(
        ebay_upc=None,
        ebay_mpns=[],
        ebay_brand="skil",
        phash_distance=5,
        title_similarity=0.90,
        candidate={"title": "SKIL circular saw blade"},
    )
    assert flags["brand_title_bonus"]
    assert score == SCORE_BRAND + SCORE_TITLE + SCORE_BRAND_TITLE_BONUS + SCORE_PHASH
    assert score == 110
    assert qualifies_match(score)
    assert method == "score_brand_title"


def test_madde2_phash_only_with_brand():
    score_no_brand, _, _, flags_nb = compute_score(
        ebay_upc=None,
        ebay_mpns=[],
        ebay_brand="nike",
        phash_distance=3,
        title_similarity=0.0,
        candidate={"title": "Adidas running shoe"},
    )
    assert not flags_nb["phash"]
    assert score_no_brand == 0

    score_brand, _, _, flags_b = compute_score(
        ebay_upc=None,
        ebay_mpns=[],
        ebay_brand="nike",
        phash_distance=3,
        title_similarity=0.0,
        candidate={"title": "Nike running shoe"},
    )
    assert flags_b["phash"]
    assert score_brand == SCORE_BRAND + SCORE_PHASH


def test_single_weak_signal_rejected():
    assert not qualifies_match(SCORE_TITLE)
    assert not qualifies_match(SCORE_PHASH)


def test_madde9_confidence_formula():
    assert score_to_confidence(80) == 0.8
    assert score_to_confidence(100) == 0.838
    assert score_to_confidence(130) == 0.895
    assert score_to_confidence(200) == 0.99


def test_mpn_score_qualifies_at_default_threshold():
    assert qualifies_match(SCORE_MPN)


def test_mpn_match_in_serp_bullets_not_title():
    score, _, _, flags = compute_score(
        ebay_upc=None,
        ebay_mpns=["HPA300"],
        ebay_brand="honeywell",
        phash_distance=None,
        title_similarity=0.5,
        candidate={
            "title": "Replacement Air Filter",
            "bullets": "Compatible with Honeywell HPA300 series",
        },
    )
    assert flags["mpn"]
    assert score >= SCORE_MPN


def test_match_gap_bypass_threshold():
    assert match_gap_bypass_score() == 120


def test_phash_distance_identical_images():
    img = Image.new("RGB", (64, 64), color=(120, 80, 40))
    h1 = imagehash.phash(img)
    h2 = imagehash.phash(img.copy())
    assert phash_hamming(h1, h2) <= PHASH_MAX_DISTANCE


def test_madde4_phash_cache(monkeypatch):
    clear_phash_cache()
    calls = {"n": 0}

    def fake_download(url: str, timeout: int = 8):
        calls["n"] += 1
        return Image.new("RGB", (32, 32), color=(10, 20, 30))

    monkeypatch.setattr("match_score._download_image_sync", fake_download)
    url = "https://example.com/img.jpg"
    assert get_phash_sync(url) is not None
    assert get_phash_sync(url) is not None
    assert calls["n"] == 1
    assert phash_cache_size() == 1
    clear_phash_cache()


def test_madde5_get_phash_returns_none_on_error(monkeypatch):
    clear_phash_cache()

    def boom(_url: str, _timeout: int = 8):
        raise OSError("SSL error")

    monkeypatch.setattr("match_score._download_image_sync", boom)
    assert get_phash_sync("https://broken.example/x.jpg") is None
    clear_phash_cache()


def test_invalid_asin_rejected():
    assert not is_plausible_asin("EXPERIENCE")
    assert is_plausible_asin("B08N5WRWNW")


def test_extract_brand():
    assert extract_brand("SKIL 14-227 Circular Saw") == "skil"


@pytest.mark.asyncio
async def test_madde3_ambiguous_gap_rejects_match():
    from match_score import score_candidates

    candidates = [
        {"asin": "B08N5WRWNW", "title": "SKIL blade A", "image_url": "", "text_score": 0.5},
        {"asin": "B07FZ8S74R", "title": "SKIL blade B", "image_url": "", "text_score": 0.5},
    ]

    async def fake_sim(a: str, b: str) -> float:
        return 0.90

    with patch("match_score.title_similarity", fake_sim):
        with patch("match_score.get_phash", AsyncMock(return_value=None)):
            result = await score_candidates(
                ebay_title="SKIL circular saw blade",
                ebay_image_url=None,
                candidates=candidates,
                text_best_score=0.5,
            )
    assert result is None
