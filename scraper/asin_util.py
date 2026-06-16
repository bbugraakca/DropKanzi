"""Amazon ASIN shape checks — reject 10-letter English words from eBay/SERP noise."""

from __future__ import annotations

import re

_ASIN_SHAPE = re.compile(r"^[A-Z0-9]{10}$")
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
