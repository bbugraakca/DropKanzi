"""Unit tests for Claude arbitration layer."""

import pytest

from claude_arbitration import (
    cache_key,
    claude_arbitration_enabled,
    claude_confidence,
    gap_soft,
    is_eligible,
    reset_run_context,
    score_max,
    score_min,
    should_accept_asin_assignment,
    try_claude_arbitration,
    _parse_claude_asin,
)


def _ranked(score: int, *, upc: bool = False, mpn: bool = False) -> list[dict]:
    return [{"match_score": score, "asin": "B012345678", "title": "Test", "signal_flags": {"upc": upc, "mpn": mpn}}]


@pytest.fixture(autouse=True)
def _reset_ctx():
    reset_run_context()


def test_disabled_by_default(monkeypatch):
    monkeypatch.delenv("FINDER_CLAUDE_ARBITRATION", raising=False)
    monkeypatch.setenv("FINDER_CLAUDE_MATCH", "false")
    assert not claude_arbitration_enabled()


def test_enabled_via_arbitration_flag(monkeypatch):
    monkeypatch.setenv("FINDER_CLAUDE_ARBITRATION", "true")
    assert claude_arbitration_enabled()


def test_cache_key_differs_by_seller():
    k1 = cache_key("Philips brush", brand="philips", mpn="HX9023", seller_id="seller_a")
    k2 = cache_key("Philips brush", brand="philips", mpn="HX9023", seller_id="seller_b")
    assert k1 != k2


def test_eligible_mid_band(monkeypatch):
    monkeypatch.setenv("FINDER_CLAUDE_ARBITRATION", "true")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert is_eligible(_ranked(65), best_score=65, gap=3)


def test_not_eligible_with_mpn(monkeypatch):
    monkeypatch.setenv("FINDER_CLAUDE_ARBITRATION", "true")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert not is_eligible(_ranked(65, mpn=True), best_score=65, gap=3)


def test_not_eligible_below_min(monkeypatch):
    monkeypatch.setenv("FINDER_CLAUDE_ARBITRATION", "true")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert not is_eligible(_ranked(40), best_score=40, gap=10)


def test_not_eligible_at_or_above_max(monkeypatch):
    monkeypatch.setenv("FINDER_CLAUDE_ARBITRATION", "true")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert not is_eligible(_ranked(80), best_score=80, gap=10)


def test_gap_soft_skips_upper_band(monkeypatch):
    monkeypatch.setenv("FINDER_CLAUDE_ARBITRATION", "true")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    ranked = [
        {"match_score": 72, "signal_flags": {}},
        {"match_score": 60, "signal_flags": {}},
    ]
    assert not is_eligible(ranked, best_score=72, gap=gap_soft())


def test_low_band_ignores_gap(monkeypatch):
    monkeypatch.setenv("FINDER_CLAUDE_ARBITRATION", "true")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    ranked = [
        {"match_score": 60, "signal_flags": {}},
        {"match_score": 58, "signal_flags": {}},
    ]
    assert is_eligible(ranked, best_score=60, gap=2)


def test_confidence_calibrated():
    assert claude_confidence(50) == 0.82
    assert claude_confidence(75) == 0.88
    assert 0.82 <= claude_confidence(60) <= 0.88


def test_parse_asin_hallucination_guard():
    allowed = {"B08N5WRWNW"}
    assert _parse_claude_asin("B08N5WRWNW", allowed) == "B08N5WRWNW"
    assert _parse_claude_asin("B000000000", allowed) is None
    assert _parse_claude_asin("NONE", allowed) is None


def test_run_scoped_asin_reuse():
    asin = "B08N5WRWNW"
    assert should_accept_asin_assignment(asin)
    assert should_accept_asin_assignment(asin)
    assert not should_accept_asin_assignment(asin)


@pytest.mark.asyncio
async def test_try_arbitration_no_api_when_disabled(monkeypatch):
    monkeypatch.setenv("FINDER_CLAUDE_ARBITRATION", "false")
    monkeypatch.setenv("FINDER_CLAUDE_MATCH", "false")
    out = await try_claude_arbitration(
        ebay_title="Test item",
        ranked_candidates=_ranked(65),
    )
    assert out is None


@pytest.mark.asyncio
async def test_try_arbitration_mock_claude(monkeypatch):
    monkeypatch.setenv("FINDER_CLAUDE_ARBITRATION", "true")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("REDIS_URL", "")

    class FakeBlock:
        text = "B08N5WRWNW"

    class FakeClient:
        class messages:
            @staticmethod
            async def create(**_kwargs):
                class R:
                    content = [FakeBlock()]

                return R()

    ranked = [
        {"match_score": 65, "asin": "B08N5WRWNW", "title": "Amazon Product", "signal_flags": {}, "price": 19.99},
        {"match_score": 55, "asin": "B07BBBBBBB", "title": "Other", "signal_flags": {}},
    ]
    hit = await try_claude_arbitration(
        ebay_title="eBay listing title",
        ranked_candidates=ranked,
        claude_client=FakeClient(),
    )
    assert hit is not None
    assert hit["amazon_asin"] == "B08N5WRWNW"
    assert hit["match_method"] == "claude_arbitration"
    assert 0.82 <= hit["match_confidence"] <= 0.88


def test_score_band_constants():
    assert score_min() == 50
    assert score_max() == 75
