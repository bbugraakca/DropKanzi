import re

_PACK_PATTERNS = [
    re.compile(r"\b(?:pack|lot|set)\s*of\s*(\d{1,3})\b", re.IGNORECASE),
    re.compile(r"\b(\d{1,3})\s*(?:pack|pcs|pc|pieces|count|ct)\b", re.IGNORECASE),
    re.compile(r"\bx\s*(\d{1,3})\b", re.IGNORECASE),
]


def extract_pack_count(title: str | None) -> int:
    if not title:
        return 1
    text = str(title).strip()
    for rx in _PACK_PATTERNS:
        m = rx.search(text)
        if not m:
            continue
        try:
            val = int(m.group(1))
            if 1 <= val <= 200:
                return val
        except Exception:
            continue
    return 1
