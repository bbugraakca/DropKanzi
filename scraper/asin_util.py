"""Amazon ASIN shape checks — reject 10-letter English words from eBay/SERP noise."""

from __future__ import annotations

import re
from collections import Counter
from typing import Any

_ASIN_SHAPE = re.compile(r"^[A-Z0-9]{10}$")
# Modern product ASINs are B0…; ISBN-10 style ASINs are all digits.
_PRODUCT_ASIN_RE = re.compile(r"^(?:B[0-9A-Z]{9}|[0-9]{10})$")
_ASIN_LABELED_RE = re.compile(
    r"(?:ASIN|Amazon\s*(?:ASIN|Standard\s*Identification\s*Number))[:\s#-]*([A-Z0-9]{10})",
    re.IGNORECASE,
)


def normalize_asin(raw: str | None) -> str | None:
    if not raw:
        return None
    s = raw.strip().upper()
    return s if is_plausible_asin(s) else None


def is_plausible_asin(asin: str | None) -> bool:
    """
    True for real Amazon ASIN shapes.

    Rejects 10-letter words (e.g. EXPERIENCE, GEARWRENCH) that eBay descriptions
    and bad SERP slots match as ``\\b[A-Z0-9]{10}\\b``.
    """
    if not asin:
        return False
    s = asin.strip().upper()
    if not _ASIN_SHAPE.fullmatch(s):
        return False
    if s.isalpha():
        return False
    if s in ("0000000000", "1111111111", "9999999999"):
        return False
    return True


def is_plausible_product_asin(asin: str | None) -> bool:
    """Stricter check for catalog product ASINs (B0… or ISBN-10 digit form)."""
    if not is_plausible_asin(asin):
        return False
    return bool(_PRODUCT_ASIN_RE.fullmatch(asin.strip().upper()))


def is_ebay_detail_asin(asin: str | None, *, source: str) -> bool:
    """
    ASIN extracted from an eBay listing page.

    Only ``dp_link`` (amazon.com/dp/ or /gp/product/) sources are accepted.
    """
    if source != "dp_link":
        return False
    return is_plausible_product_asin(asin)


EBAY_DETAIL_DUPE_THRESHOLD = 3


def reject_suspicious_ebay_detail_dupes(
    matched: list[dict[str, Any]],
    *,
    threshold: int = EBAY_DETAIL_DUPE_THRESHOLD,
) -> list[dict[str, Any]]:
    """Clear ebay_detail when the same ASIN is assigned to many listings (template noise)."""
    ebay_hits = [
        m
        for m in matched
        if m.get("match_method") == "ebay_detail" and m.get("amazon_asin")
    ]
    if not ebay_hits:
        return matched
    counts = Counter(str(m["amazon_asin"]).upper() for m in ebay_hits)
    suspicious = {asin for asin, n in counts.items() if n >= threshold}
    if not suspicious:
        return matched
    out: list[dict[str, Any]] = []
    for m in matched:
        asin = str(m.get("amazon_asin") or "").upper()
        if m.get("match_method") == "ebay_detail" and asin in suspicious:
            cleared = dict(m)
            cleared["amazon_asin"] = None
            cleared["amazon_url"] = None
            cleared["match_confidence"] = 0.0
            cleared["match_method"] = "ebay_detail_rejected"
            out.append(cleared)
        else:
            out.append(m)
    return out
