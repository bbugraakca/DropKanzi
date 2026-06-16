"""Aggressive eBay listing title cleanup — removes marketing noise, keeps MPN/brand/model."""

from __future__ import annotations

import re

# Case-insensitive phrase removal (word boundaries). MPN/model tokens are preserved.
_EBAY_NOISE_PATTERNS: tuple[str, ...] = (
    r"\bNEW\b",
    r"\bNIB\b",
    r"\bNWT\b",
    r"\bNWOT\b",
    r"\bSEALED\b",
    r"\bOPEN\s+BOX\b",
    r"\bUSED\b",
    r"\bPRE[- ]?OWNED\b",
    r"\bREFURBISHED\b",
    r"\bLOT\s+OF\s+\d+\b",
    r"\bSET\s+OF\s+\d+\b",
    r"\bPACK\s+OF\s+\d+\b",
    r"\b\d+[- ]?PACK\b",
    r"\b\d+\s+PACK\b",
    r"\bFREE\s+SHIPPING\b",
    r"\bFAST\s+SHIPPING\b",
    r"\bFREE\s+SHIP\b",
    r"\bSHIPS\s+FREE\b",
    r"\bREAD\s+DESCRIPTION\b",
    r"\bREAD\s+DESC\b",
    r"\bSEE\s+PHOTOS\b",
    r"\bSEE\s+DESCRIPTION\b",
    r"\bGENUINE\b",
    r"\bAUTHENTIC\b",
    r"\bBRAND\s+NEW\b",
    r"\bFACTORY\s+SEALED\b",
    r"\bIN\s+HAND\b",
    r"\bSHIPS\s+TODAY\b",
    r"\bUS\s+SELLER\b",
    r"\bFREE\s+RETURNS\b",
    # Legacy patterns kept for compatibility with older clean_query behavior
    r"\bFAST(?:\s+SHIP(?:PING)?)?\b",
    r"\bSAME\s+DAY\b",
)

_OEM_EDGE_RE = re.compile(r"^(?:OEM)\b|\b(?:OEM)$", re.IGNORECASE)
_COMPILED_NOISE = tuple(re.compile(p, re.IGNORECASE) for p in _EBAY_NOISE_PATTERNS)


def normalize_ebay_title(title: str) -> str:
    """Strip eBay marketing junk; preserve model numbers (e.g. HX9023) and brand names."""
    q = (title or "").strip()
    if not q:
        return ""
    for pat in _COMPILED_NOISE:
        q = pat.sub(" ", q)
    q = _OEM_EDGE_RE.sub(" ", q)
    q = re.sub(r"[^\w\s-]", " ", q)
    return " ".join(q.split())
