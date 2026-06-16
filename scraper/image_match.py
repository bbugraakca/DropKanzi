"""
Public matching API — routes to scoring (default) or SigLIP legacy (rollback).

MADDE 10: SigLIP code lives in image_match_siglip.py; NOT loaded unless
FINDER_VISION_MATCH=true.
"""

from __future__ import annotations

import os
from typing import Optional

from match_score import (
    IMAGE_CHECK_MAX_TEXT,
    IMAGE_CHECK_MIN_TEXT,
    MATCH_SCORE_THRESHOLD,
    PHASH_MAX_DISTANCE,
    MULTI_SIGNAL_MIN_SCORE,
    clear_phash_cache,
    compute_score,
    extract_brand,
    extract_mpns,
    extract_upc,
    get_phash,
    get_phash_sync,
    match_min_gap,
    match_score_threshold,
    mpn_in_title,
    normalize_mpn,
    phash_cache_size,
    phash_hamming,
    phash_max_distance,
    qualifies_match,
    score_candidates as _score_candidates,
    score_to_confidence,
    title_similarity,
    upc_matches,
    warmup as _score_warmup,
)

FINDER_VISION_MATCH = os.getenv("FINDER_VISION_MATCH", "false").lower() in ("1", "true", "yes")


def vision_match_enabled() -> bool:
    return FINDER_VISION_MATCH


async def score_candidates(
    *,
    ebay_title: str,
    ebay_image_url: Optional[str],
    candidates: list[dict],
    identifiers: Optional[dict] = None,
    text_best_score: float = 0.0,
) -> Optional[dict]:
    if FINDER_VISION_MATCH:
        from image_match_siglip import image_match as siglip_match

        if not ebay_image_url:
            return None
        result = await siglip_match(
            ebay_image_url,
            candidates,
            text_best_score,
            ebay_title=ebay_title,
            identifiers=identifiers,
        )
        if not result:
            return None
        conf = float(result.get("combined_score") or 0)
        return {
            **result,
            "asin": result.get("asin"),
            "match_score": int(conf * 100),
            "match_confidence": conf,
            "match_method": "image_siglip",
        }
    return await _score_candidates(
        ebay_title=ebay_title,
        ebay_image_url=ebay_image_url,
        candidates=candidates,
        identifiers=identifiers,
        text_best_score=text_best_score,
    )


async def image_match(
    ebay_image_url: str,
    candidates: list[dict],
    text_best_score: float,
    *,
    ebay_title: str = "",
    identifiers: Optional[dict] = None,
) -> Optional[dict]:
    if FINDER_VISION_MATCH:
        from image_match_siglip import image_match as siglip_match

        return await siglip_match(
            ebay_image_url,
            candidates,
            text_best_score,
            ebay_title=ebay_title,
            identifiers=identifiers,
        )

    result = await _score_candidates(
        ebay_title=ebay_title,
        ebay_image_url=ebay_image_url,
        candidates=candidates,
        identifiers=identifiers,
        text_best_score=text_best_score,
    )
    if not result:
        return None

    max_dist = phash_max_distance()
    return {
        **result,
        "image_score": (
            max(0.0, 1.0 - (result["phash_distance"] or max_dist + 1) / (max_dist + 1))
            if result.get("phash_distance") is not None
            else None
        ),
        "combined_score": result["match_confidence"],
    }


async def warmup():
    if FINDER_VISION_MATCH:
        from image_match_siglip import warmup as siglip_warmup

        await siglip_warmup()
    else:
        await _score_warmup()


__all__ = [
    "IMAGE_CHECK_MAX_TEXT",
    "IMAGE_CHECK_MIN_TEXT",
    "MATCH_SCORE_THRESHOLD",
    "PHASH_MAX_DISTANCE",
    "MULTI_SIGNAL_MIN_SCORE",
    "FINDER_VISION_MATCH",
    "vision_match_enabled",
    "clear_phash_cache",
    "compute_score",
    "extract_brand",
    "extract_mpns",
    "extract_upc",
    "get_phash",
    "get_phash_sync",
    "image_match",
    "match_min_gap",
    "match_score_threshold",
    "mpn_in_title",
    "normalize_mpn",
    "phash_cache_size",
    "phash_hamming",
    "phash_max_distance",
    "qualifies_match",
    "score_candidates",
    "score_to_confidence",
    "title_similarity",
    "upc_matches",
    "warmup",
]
