"""Tests for Claude hardening v3 (title_clean_success, gap, send_to_claude gateway)."""

import pathlib

import pytest

from claude_arbitration import is_eligible
from claude_client import compute_rank_gap, title_clean_success


def test_title_clean_success_requires_nonempty_queries():
    assert not title_clean_success(None)
    assert not title_clean_success({"brand": "Acme", "search_queries": []})
    assert not title_clean_success({"search_queries": "not-a-list"})
    assert title_clean_success({"search_queries": ["acme widget 12oz"]})


def test_empty_queries_arbitration_still_eligible(monkeypatch):
    monkeypatch.setenv("FINDER_CLAUDE_ARBITRATION", "true")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    ranked = [{"match_score": 65, "signal_flags": {}}]
    assert not title_clean_success({"search_queries": []})
    assert is_eligible(ranked, best_score=65, gap=0, title_clean_success=False)


def test_title_clean_success_blocks_arbitration(monkeypatch):
    monkeypatch.setenv("FINDER_CLAUDE_ARBITRATION", "true")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    ranked = [{"match_score": 65, "signal_flags": {}}]
    assert not is_eligible(ranked, best_score=65, gap=0, title_clean_success=True)


def test_single_candidate_gap_is_zero():
    ranked = [{"match_score": 72, "signal_flags": {}}]
    top1, top2, gap = compute_rank_gap(ranked)
    assert top1 == 72
    assert top2 == 72
    assert gap == 0


def test_single_candidate_upper_band_not_skipped_by_gap(monkeypatch):
    """One SERP candidate: gap=0 must not trigger soft-gap skip at score 72."""
    monkeypatch.setenv("FINDER_CLAUDE_ARBITRATION", "true")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    ranked = [{"match_score": 72, "signal_flags": {}}]
    _, _, gap = compute_rank_gap(ranked)
    assert gap == 0
    assert is_eligible(ranked, best_score=72, gap=gap, title_clean_success=False)


def test_no_direct_anthropic_calls_outside_gateway():
    """All client.messages.create / Anthropic() must live in claude_client.py only."""
    root = pathlib.Path(__file__).resolve().parent
    forbidden_snippets = ("messages.create", "Anthropic(")
    offenders: list[str] = []
    for path in root.glob("*.py"):
        if path.name == "claude_client.py" or path.name.startswith("test_"):
            continue
        text = path.read_text(encoding="utf-8")
        for snippet in forbidden_snippets:
            if snippet in text:
                offenders.append(f"{path.name}: {snippet}")
    assert offenders == [], f"Direct Anthropic usage outside gateway: {offenders}"
