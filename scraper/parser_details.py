"""Amazon urun sayfasi — aciklama, bullet, olcu ve teknik detay parse."""

import re
from typing import Any

from parsel import Selector

JUNK_BULLET_PATTERNS = re.compile(
    r"^(see more|make sure this fits|learn more|show more|"
    r"important information|note:|disclaimer)",
    re.I,
)


def _clean_text(text: str | None) -> str | None:
    if not text:
        return None
    t = re.sub(r"\s+", " ", text).strip()
    return t if t and len(t) > 1 else None


def _is_valid_bullet(text: str) -> bool:
    if len(text) < 3 or len(text) > 2000:
        return False
    if JUNK_BULLET_PATTERNS.match(text):
        return False
    if text.count("›") > 2:
        return False
    return True


def parse_feature_bullets(sel: Selector) -> list[str]:
    bullets: list[str] = []
    selectors = [
        "#feature-bullets ul.a-unordered-list li span.a-list-item::text",
        "#feature-bullets li.a-spacing-mini span::text",
        "#featurebullets_feature_div li span.a-list-item::text",
    ]
    seen: set[str] = set()
    for css in selectors:
        for raw in sel.css(css).getall():
            t = _clean_text(raw)
            if t and _is_valid_bullet(t) and t not in seen:
                seen.add(t)
                bullets.append(t)
    return bullets


def parse_about_description(sel: Selector) -> str | None:
    parts: list[str] = []

    for css in (
        "#productDescription p::text",
        "#productDescription span::text",
        "#productDescription_feature_div p::text",
        "#aplus_feature_div p::text",
        "#aplus_feature_div h3::text",
    ):
        for raw in sel.css(css).getall():
            t = _clean_text(raw)
            if t and len(t) > 15 and t not in parts:
                parts.append(t)

    if not parts:
        block = sel.css("#productDescription").get()
        if block:
            inner = Selector(text=block)
            for raw in inner.css("::text").getall():
                t = _clean_text(raw)
                if t and len(t) > 20:
                    parts.append(t)

    if not parts:
        return None
    return "\n\n".join(parts[:20])


def parse_detail_bullets_kv(sel: Selector) -> dict[str, str]:
    attrs: dict[str, str] = {}
    for row in sel.css("#detailBullets_feature_div li"):
        label = _clean_text(row.css("span.a-text-bold::text").get())
        value_parts = row.css("span:not(.a-text-bold)::text").getall()
        value = _clean_text(" ".join(value_parts))
        if not value:
            value = _clean_text(row.css("span.po-break-word::text").get())
        if label and value:
            key = label.rstrip(":").strip()
            if key and key not in attrs:
                attrs[key] = value
    return attrs


def parse_tech_spec_tables(sel: Selector) -> dict[str, str]:
    attrs: dict[str, str] = {}
    table_selectors = [
        "#productDetails_techSpec_section_1 tr",
        "#productDetails_techSpec_section_2 tr",
        "#productDetails_detailBullets_sections1 tr",
        "#prodDetails tr",
        "#technicalSpecifications_section_1 tr",
        "table.a-keyvalue tr",
    ]
    for css in table_selectors:
        for row in sel.css(css):
            th = _clean_text(row.css("th::text").get())
            tds = [_clean_text(t) for t in row.css("td::text").getall()]
            tds = [t for t in tds if t]
            if th and tds:
                val = tds[0] if len(tds) == 1 else " ".join(tds)
                if th != val and th not in attrs:
                    attrs[th.rstrip(":")] = val
            elif len(tds) >= 2 and tds[0] not in attrs:
                attrs[tds[0].rstrip(":")] = tds[1]
    return attrs


def parse_po_expander(sel: Selector) -> dict[str, str]:
    attrs: dict[str, str] = {}
    for row in sel.css("#productOverview_feature_div tr"):
        cells = [_clean_text(c) for c in row.css("td::text, th::text").getall()]
        cells = [c for c in cells if c]
        if len(cells) >= 2 and cells[0] not in attrs:
            attrs[cells[0].rstrip(":")] = cells[1]

    for item in sel.css(
        "#productFactsDesktop_feature_div .a-fixed-left-grid, "
        "#productOverview_feature_div .a-spacing-small"
    ):
        label = _clean_text(
            item.css(
                ".a-col-left span::text, span.a-size-base.a-color-secondary::text"
            ).get()
        )
        value = _clean_text(
            item.css(
                ".a-col-right span::text, "
                "span.a-size-base:not(.a-color-secondary)::text"
            ).get()
        )
        if label and value and label not in attrs:
            attrs[label.rstrip(":")] = value
    return attrs


def parse_dimensions_summary(attrs: dict[str, str]) -> str | None:
    keys_hint = ("dimension", "size", "weight", "measure", "olcu", "boyut")
    parts: list[str] = []
    for ak, av in attrs.items():
        if any(h in ak.lower() for h in keys_hint):
            entry = f"{ak}: {av}"
            if entry not in parts:
                parts.append(entry)
    return " | ".join(parts) if parts else None


def parse_images_extended(sel: Selector, html: str) -> list[str]:
    urls: list[str] = []
    seen: set[str] = set()

    def add(src: str | None) -> None:
        if not src:
            return
        src = src.strip()
        if src.startswith("//"):
            src = "https:" + src
        if "sprite" in src or "grey-pixel" in src or "transparent" in src:
            return
        if len(src) < 30:
            return
        hi = re.sub(r"\._[A-Z0-9_]+_\.", "._AC_SL1500_.", src)
        if hi not in seen:
            seen.add(hi)
            urls.append(hi)

    for img in sel.css("#imgTagWrapperId img, #landingImage, #main-image"):
        add(img.attrib.get("data-old-hires") or img.attrib.get("src"))

    for img in sel.css("#altImages img, #imageBlock img"):
        add(
            img.attrib.get("data-old-hires")
            or img.attrib.get("data-a-hires")
            or img.attrib.get("src")
        )

    for m in re.finditer(r'"hiRes"\s*:\s*"([^"]+)"', html):
        add(m.group(1).replace("\\u002F", "/"))

    for m in re.finditer(r'"large"\s*:\s*"([^"]+)"', html):
        add(m.group(1).replace("\\u002F", "/"))

    return urls[:12]


def parse_product_details(html: str) -> dict[str, Any]:
    """Tam urun detay parse — bullet, aciklama, olculer, teknik tablo."""
    sel = Selector(text=html)

    bullets = parse_feature_bullets(sel)
    about = parse_about_description(sel)

    attrs: dict[str, str] = {}
    for chunk in (
        parse_detail_bullets_kv(sel),
        parse_tech_spec_tables(sel),
        parse_po_expander(sel),
    ):
        for k, v in chunk.items():
            if k and v and k not in attrs:
                attrs[k] = v

    dimensions = parse_dimensions_summary(attrs)
    images = parse_images_extended(sel, html)

    description_parts: list[str] = []
    if about:
        description_parts.append(about)
    if bullets:
        description_parts.append("FEATURES:\n" + "\n".join(f"• {b}" for b in bullets))
    if dimensions:
        description_parts.append("DIMENSIONS:\n" + dimensions)

    return {
        "bullet_points": bullets,
        "about_text": about,
        "attributes": attrs,
        "dimensions": dimensions,
        "images": images,
        "description": "\n\n---\n\n".join(description_parts) if description_parts else None,
    }
