"""
Multi-signal scoring for eBay ↔ Amazon candidate matching (default path).

See CURSOR_SKORLAMA_ESLESTIRME.md — 10-rule scoring system (SigLIP disabled).
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from io import BytesIO
from typing import Any, Optional

import imagehash
import requests as req_sync
from PIL import Image

from asin_util import is_plausible_asin
from ebay_title_normalize import normalize_ebay_title

logger = logging.getLogger("pricehawk.match_score")

SCORE_UPC = 100
SCORE_MPN = 80
SCORE_BRAND = 20
SCORE_BRAND_TITLE_BONUS = 40
SCORE_PHASH = 30
SCORE_TITLE = 20

IMAGE_CHECK_MIN_TEXT = float(os.environ.get("IMAGE_CHECK_MIN_TEXT", "0.38"))
IMAGE_CHECK_MAX_TEXT = float(os.environ.get("IMAGE_CHECK_MAX_TEXT", "0.81"))
IMAGE_TIMEOUT = int(os.environ.get("IMAGE_DOWNLOAD_TIMEOUT", "8"))
MAX_IMAGE_CANDIDATES = int(os.environ.get("FINDER_IMAGE_CANDIDATES", "8"))
TITLE_SIM_THRESHOLD = float(os.environ.get("FINDER_TITLE_SIM_THRESHOLD", "0.8"))
BRAND_TITLE_SIM_BONUS = float(os.environ.get("FINDER_BRAND_TITLE_SIM_BONUS", "0.85"))
TITLE_MODEL = os.environ.get("FINDER_TITLE_MODEL", "all-MiniLM-L6-v2")


def match_score_threshold() -> int:
    return int(os.environ.get("FINDER_MATCH_SCORE_THRESHOLD", "80"))


def phash_max_distance() -> int:
    return int(os.environ.get("FINDER_PHASH_MAX_DISTANCE", "8"))


def match_min_gap() -> int:
    return int(os.environ.get("FINDER_MATCH_MIN_GAP", "10"))


def match_gap_bypass_score() -> int:
    """Scores above this skip top-2 gap rejection (strong UPC+MPN combos)."""
    return int(os.environ.get("FINDER_MATCH_GAP_BYPASS_SCORE", "120"))


# Backward-compat module constants (read at import; use helpers for tests that patch env)
MATCH_SCORE_THRESHOLD = match_score_threshold()
PHASH_MAX_DISTANCE = phash_max_distance()
MULTI_SIGNAL_MIN_SCORE = int(os.environ.get("FINDER_MULTI_SIGNAL_MIN_SCORE", "70"))

_MPN_NOISE = frozenset(
    {
        "FAST", "SHIP", "SHIPS", "FREE", "NEW", "USED", "OPEN", "BOX", "SEALED",
        "PACK", "LOT", "SET", "BLACK", "LARGE", "STEEL", "SMALL", "MEDIUM",
    }
)
_MPN_SAFE_RE = re.compile(r"^(?=.*\d)[A-Z0-9-]{4,}$", re.IGNORECASE)
_PACK_CONTEXT_RE = re.compile(
    r"(?:pack\s+of|lot\s+of|set\s+of|bundle\s+of|qty|quantity|count|"
    r"\d+\s*[- ]?pack|\d+\s*[- ]?piece|\d+\s*[- ]?pc\b)",
    re.IGNORECASE,
)
_QUANTITY_MPN_RE = re.compile(
    r"^(?:X?\d{1,3}|\d{1,3}X|PACKOF\d+|\d+PACK|SETOF\d+|\d+SET|LOT\d+)$",
    re.IGNORECASE,
)
_MPN_LABEL_RE = re.compile(
    r"(?:MPN|Model(?:\s*(?:No|Number|#))?|Part\s*(?:No|Number|#)?)[:\s#-]*"
    r"((?=.*\d)[A-Z0-9][A-Z0-9\-/]{2,14})\b",
    re.IGNORECASE,
)
_MPN_TOKEN_RE = re.compile(
    r"\b((?=.*\d)[A-Z]{0,4}-?[A-Z0-9]{3,}[A-Z0-9\-/]*)\b",
    re.IGNORECASE,
)
_UPC_RE = re.compile(r"\b(\d{12,13})\b")

_phash_cache: dict[str, imagehash.ImageHash] = {}
_phash_cache_lock = asyncio.Lock()
_title_model: Any = None
_title_model_lock = asyncio.Lock()


def normalize_mpn(raw: str) -> str:
    return re.sub(r"[\s\-_/]", "", (raw or "")).upper()


def _valid_mpn_token(raw: str, normalized: str) -> bool:
    if len(normalized) < 4:
        return False
    if not _MPN_SAFE_RE.fullmatch(raw.strip().upper()):
        return False
    if not any(c.isdigit() for c in normalized):
        return False
    if normalized in _MPN_NOISE:
        return False
    if _QUANTITY_MPN_RE.fullmatch(normalized):
        return False
    if re.fullmatch(r"X?\d{1,3}", normalized):
        return False
    if re.fullmatch(r"\d{1,3}X", normalized):
        return False
    if re.fullmatch(r"\d{1,3}PACK", normalized) or re.fullmatch(r"PACK\d{1,3}", normalized):
        return False
    return True


def _mpn_in_pack_context(text: str, start: int, end: int) -> bool:
    window_start = max(0, start - 28)
    window_end = min(len(text), end + 12)
    window = text[window_start:window_end]
    if _PACK_CONTEXT_RE.search(window):
        local = text[max(0, start - 12) : end].strip()
        if re.search(r"(?:pack|lot|set|bundle|qty|quantity|pc)\b", local, re.IGNORECASE):
            return True
        if re.search(r"\bx\s*\d+\b|\d+\s*x\s*\d+", local, re.IGNORECASE):
            return True
    return False


def extract_mpns(text: str) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()
    if not text:
        return found

    for pattern in (_MPN_LABEL_RE, _MPN_TOKEN_RE):
        for m in pattern.finditer(text):
            if _mpn_in_pack_context(text, m.start(1), m.end(1)):
                continue
            raw = m.group(1)
            token = normalize_mpn(raw)
            if _valid_mpn_token(raw, token) and token not in seen:
                seen.add(token)
                found.append(token)

    return found


def extract_upc(text: str) -> Optional[str]:
    m = _UPC_RE.search(text or "")
    return m.group(1) if m else None


def extract_brand(title: str) -> Optional[str]:
    tokens = re.findall(r"[A-Za-z0-9]+", title or "")
    tokens = [t for t in tokens if len(t) >= 2]
    if not tokens:
        return None
    if len(tokens[0]) <= 3 and len(tokens) > 1:
        return f"{tokens[0]} {tokens[1]}".lower()
    return tokens[0].lower()


def mpn_in_title(mpns: list[str], amazon_title: str) -> bool:
    """MPN match in Amazon title or SERP snippet/bullets text."""
    return mpn_in_text(mpns, amazon_title)


def mpn_in_text(mpns: list[str], haystack: str) -> bool:
    hay = normalize_mpn(haystack)
    return any(mpn and mpn in hay for mpn in mpns)


def brand_in_title(brand: Optional[str], amazon_title: str) -> bool:
    return brand_in_text(brand, amazon_title)


def brand_in_text(brand: Optional[str], haystack: str) -> bool:
    if not brand:
        return False
    return brand.lower() in (haystack or "").lower()


def candidate_text_blob(candidate: dict) -> str:
    """Amazon title + any SERP bullet/snippet text available without extra fetch."""
    parts = [str(candidate.get("title") or "")]
    for key in ("bullets", "snippet", "features"):
        extra = candidate.get(key)
        if extra:
            parts.append(str(extra))
    return " ".join(parts)


def upc_matches(ebay_upc: Optional[str], candidate: dict) -> bool:
    if not ebay_upc:
        return False
    blob = candidate_text_blob(candidate)
    cand_upc = str(candidate.get("upc") or "")
    hay_digits = re.sub(r"\D", "", f"{blob} {cand_upc}")
    return ebay_upc in hay_digits or ebay_upc in blob


def phash_hamming(a: imagehash.ImageHash, b: imagehash.ImageHash) -> int:
    return int(a - b)


def qualifies_match(score: int, _signal_count: int = 0) -> bool:
    """MADDE 6: score must meet ENV threshold (signal_count kept for test compat)."""
    return score >= match_score_threshold()


def score_to_confidence(score: int) -> float:
    """MADDE 9: accepted scores (>= threshold) map to [0.80, 0.99] for MIN_MATCH_CONFIDENCE."""
    threshold = match_score_threshold()
    if score < threshold:
        return round(0.5 * score / max(threshold, 1), 4)
    return round(min(0.99, 0.80 + (score - threshold) * 0.19 / 100), 4)


def compute_score(
    *,
    ebay_upc: Optional[str],
    ebay_mpns: list[str],
    ebay_brand: Optional[str],
    phash_distance: Optional[int],
    title_similarity: float,
    candidate: dict,
) -> tuple[int, str, int, dict[str, bool]]:
    """Return (total_score, primary_method, signal_count, signal_flags)."""
    amazon_blob = candidate_text_blob(candidate)
    brand = brand_in_text(ebay_brand, amazon_blob)
    title_hit = title_similarity > TITLE_SIM_THRESHOLD
    brand_title_bonus = brand and title_similarity > BRAND_TITLE_SIM_BONUS

    # MADDE 2: pHash only when brand matches
    max_dist = phash_max_distance()
    phash_hit = (
        brand
        and phash_distance is not None
        and phash_distance <= max_dist
    )

    flags: dict[str, bool] = {
        "upc": upc_matches(ebay_upc, candidate),
        "mpn": mpn_in_text(ebay_mpns, amazon_blob),
        "brand": brand,
        "brand_title_bonus": brand_title_bonus,
        "phash": phash_hit,
        "title": title_hit,
    }

    score = 0
    if flags["upc"]:
        score += SCORE_UPC
    if flags["mpn"]:
        score += SCORE_MPN
    if flags["brand"]:
        score += SCORE_BRAND
    if flags["brand_title_bonus"]:
        score += SCORE_BRAND_TITLE_BONUS
    if flags["phash"]:
        score += SCORE_PHASH
    if flags["title"]:
        score += SCORE_TITLE

    contributors: list[tuple[int, str]] = []
    if flags["upc"]:
        contributors.append((SCORE_UPC, "score_upc"))
    if flags["mpn"]:
        contributors.append((SCORE_MPN, "score_mpn"))
    if flags["brand_title_bonus"]:
        contributors.append((SCORE_BRAND_TITLE_BONUS, "score_brand_title"))
    if flags["phash"]:
        contributors.append((SCORE_PHASH, "score_phash"))
    if flags["title"]:
        contributors.append((SCORE_TITLE, "score_title"))
    if flags["brand"]:
        contributors.append((SCORE_BRAND, "score_brand"))

    primary = "score_multi"
    if contributors:
        primary = max(contributors, key=lambda x: x[0])[1]

    signal_count = sum(1 for f in flags.values() if f)
    return score, primary, signal_count, flags


def _download_image_sync(url: str, timeout: int = 8) -> Optional[Image.Image]:
    if not url or not url.startswith("http"):
        return None
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "image/webp,image/avif,image/*,*/*;q=0.8",
        }
        r = req_sync.get(url, headers=headers, timeout=timeout, stream=True)
        if r.status_code != 200:
            return None
        content_type = r.headers.get("content-type", "")
        if content_type and "image" not in content_type:
            return None
        data = b""
        for chunk in r.iter_content(1024):
            data += chunk
            if len(data) > 1_048_576:
                break
        return Image.open(BytesIO(data)).convert("RGB")
    except Exception as exc:  # noqa: BLE001
        logger.debug("[match_score] Image download failed %s: %s", url, exc)
        return None


async def _download_image(url: str) -> Optional[Image.Image]:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _download_image_sync, url, IMAGE_TIMEOUT)


def get_phash_sync(url: str) -> Optional[imagehash.ImageHash]:
    """MADDE 4+5: cached pHash; None on any download/hash failure (fail-safe)."""
    if not url:
        return None
    if url in _phash_cache:
        return _phash_cache[url]
    try:
        img = _download_image_sync(url, IMAGE_TIMEOUT)
        if img is None:
            return None
        h = imagehash.phash(img)
        _phash_cache[url] = h
        return h
    except Exception as exc:  # noqa: BLE001
        logger.debug("[match_score] get_phash failed %s: %s", url[:80], exc)
        return None


async def get_phash(url: str) -> Optional[imagehash.ImageHash]:
    if not url:
        return None
    if url in _phash_cache:
        return _phash_cache[url]
    async with _phash_cache_lock:
        if url in _phash_cache:
            return _phash_cache[url]
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, get_phash_sync, url)


def clear_phash_cache() -> None:
    _phash_cache.clear()


def phash_cache_size() -> int:
    return len(_phash_cache)


def _load_title_model_sync():
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(TITLE_MODEL)


async def _get_title_model():
    global _title_model
    if _title_model is not None:
        return _title_model
    async with _title_model_lock:
        if _title_model is not None:
            return _title_model
        logger.info("[match_score] Loading title model %s...", TITLE_MODEL)
        t0 = time.time()
        loop = asyncio.get_event_loop()
        _title_model = await loop.run_in_executor(None, _load_title_model_sync)
        logger.info("[match_score] Title model loaded in %.1fs", time.time() - t0)
        return _title_model


def _title_similarity_sync(model, a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    emb = model.encode([a, b], normalize_embeddings=True)
    return float(emb[0] @ emb[1])


async def title_similarity(a: str, b: str) -> float:
    try:
        model = await _get_title_model()
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _title_similarity_sync, model, a, b)
    except Exception as exc:  # noqa: BLE001
        logger.debug("[match_score] title similarity failed: %s", exc)
        return 0.0


async def score_candidates_ranked(
    *,
    ebay_title: str,
    ebay_image_url: Optional[str],
    candidates: list[dict],
    identifiers: Optional[dict[str, str]] = None,
    text_best_score: float = 0.0,
) -> list[dict]:
    """Score all SERP candidates (no threshold/gap filter) — for Claude arbitration."""
    if not candidates:
        return []

    ebay_text = normalize_ebay_title(ebay_title or "")
    ebay_upc = (identifiers or {}).get("upc") or extract_upc(ebay_text)
    ebay_mpns = extract_mpns(ebay_text)
    if identifiers:
        for key in ("mpn", "apple_mpn", "samsung_model"):
            val = identifiers.get(key)
            if val:
                norm = normalize_mpn(val)
                if norm and norm not in ebay_mpns:
                    ebay_mpns.append(norm)
    ebay_brand = (identifiers or {}).get("brand") or extract_brand(ebay_text)

    has_id_signal = bool(ebay_upc or ebay_mpns)
    if text_best_score < IMAGE_CHECK_MIN_TEXT and not ebay_image_url and not has_id_signal:
        return []

    ebay_phash: Optional[imagehash.ImageHash] = None
    ebay_phash_ok = False
    if ebay_image_url:
        ebay_phash = await get_phash(ebay_image_url)
        ebay_phash_ok = ebay_phash is not None

    sorted_cands = sorted(
        candidates,
        key=lambda c: float(c.get("text_score") or 0),
        reverse=True,
    )[:MAX_IMAGE_CANDIDATES]

    scored: list[dict] = []

    for cand in sorted_cands:
        asin = str(cand.get("asin") or "").upper()
        if not is_plausible_asin(asin):
            continue

        sim = await title_similarity(ebay_text, cand.get("title", ""))

        dist: Optional[int] = None
        phash_status = "skipped"
        img_url = cand.get("image_url") or cand.get("image") or ""
        if ebay_phash_ok and img_url:
            amz_phash = await get_phash(img_url)
            if amz_phash is not None and ebay_phash is not None:
                try:
                    dist = phash_hamming(ebay_phash, amz_phash)
                    phash_status = "ok"
                except Exception:  # noqa: BLE001
                    phash_status = "unavailable"
            else:
                phash_status = "unavailable"
        elif ebay_image_url and img_url:
            phash_status = "unavailable"

        score, method, sig_count, flags = compute_score(
            ebay_upc=ebay_upc,
            ebay_mpns=ebay_mpns,
            ebay_brand=ebay_brand,
            phash_distance=dist,
            title_similarity=sim,
            candidate=cand,
        )

        if score <= 0:
            continue

        scored.append(
            {
                **cand,
                "asin": asin,
                "match_score": score,
                "match_method": method,
                "match_confidence": score_to_confidence(score),
                "text_score": float(cand.get("text_score") or sim),
                "title_similarity": round(sim, 4),
                "phash_distance": dist,
                "phash_status": phash_status,
                "signal_flags": flags,
            }
        )

    scored.sort(key=lambda r: r["match_score"], reverse=True)
    return scored


async def score_candidates(
    *,
    ebay_title: str,
    ebay_image_url: Optional[str],
    candidates: list[dict],
    identifiers: Optional[dict[str, str]] = None,
    text_best_score: float = 0.0,
) -> Optional[dict]:
    if not candidates:
        return None

    scored = [
        s
        for s in await score_candidates_ranked(
            ebay_title=ebay_title,
            ebay_image_url=ebay_image_url,
            candidates=candidates,
            identifiers=identifiers,
            text_best_score=text_best_score,
        )
        if qualifies_match(int(s.get("match_score") or 0))
    ]

    if not scored:
        return None

    # MADDE 3: ambiguous when top two are too close (skip for very strong top scores)
    if len(scored) >= 2:
        top_score = scored[0]["match_score"]
        if top_score <= match_gap_bypass_score():
            gap = top_score - scored[1]["match_score"]
            if gap < match_min_gap():
                logger.info(
                    "[match_score] ambiguous match gap=%d top=%d second=%d — NO_MATCH",
                    gap,
                    top_score,
                    scored[1]["match_score"],
                )
                return None

    best = scored[0]
    logger.info(
        "[match_score] asin=%s score=%d method=%s phash=%s title=%.3f",
        best.get("asin"),
        best["match_score"],
        best["match_method"],
        best.get("phash_distance"),
        best.get("title_similarity", 0),
    )
    return best


async def warmup():
    logger.info("[match_score] Warming up title model...")
    await _get_title_model()
    logger.info("[match_score] Warmup complete")
