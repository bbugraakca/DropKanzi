import re
import logging
from typing import Any

from parsel import Selector

logger = logging.getLogger("pricehawk.parser")

# Try in order — first match wins (AOD + full-page layouts).
PRICE_SELECTORS = [
    ".apex-pricetopay-accessibility-label::text",
    ".a-price-whole + .a-price-fraction",
    "#aod-price-0 .a-offscreen::text",
    ".centralizedApexPricePriceToPayMargin .a-offscreen::text",
    "#aod-offer-price .a-price .a-offscreen::text",
    "#aod-pinned-offer .a-price .a-offscreen::text",
    "#aod-offer-list .a-price .a-offscreen::text",
    ".aod-price .a-price .a-offscreen::text",
    "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen::text",
    ".apexPriceToPay .a-offscreen::text",
    "#price_inside_buybox .a-offscreen::text",
]

_PRICE_FLOAT_RE = re.compile(r"\$?\s*([\d,]+\.?\d*)")


def _price_from_selector_text(text: str | None) -> float | None:
    if not text:
        return None
    m = _PRICE_FLOAT_RE.search(text.strip())
    if not m:
        return None
    return _parse_price_text(m.group(1))


def _price_from_selector(sel: Selector, css: str) -> float | None:
    if css.endswith("::text"):
        return _price_from_selector_text(sel.css(css).get())
    if ".a-price-whole + .a-price-fraction" in css:
        whole = sel.css("span.a-price-whole::text").get()
        frac = sel.css("span.a-price-fraction::text").get()
        if whole and frac:
            return _parse_price_text(f"${whole.strip()}.{frac.strip()}")
        return None
    return _price_from_selector_text(sel.css(f"{css}::text").get() if "::text" not in css else sel.css(css).get())


def extract_price_from_dollar_signs(html: str) -> float | None:
    anchors = ["corePriceDisplay", "price_inside_buybox", "buybox", "apex_desktop"]
    for anchor in anchors:
        idx = html.find(anchor)
        if idx < 0:
            continue
        chunk = html[idx : idx + 8000]
        m = re.search(r"\$\s*([\d,]+\.\d{2})", chunk)
        if m:
            price = _parse_price_text(m.group(1))
            if price is not None and 1 < price < 50000:
                return price

    for m in re.finditer(r"\$\s*([\d,]+\.\d{2})", html):
        price = _parse_price_text(m.group(1))
        if price is not None and 5 < price < 10000:
            return price
    return None


def extract_price_from_embedded_json(html: str) -> float | None:
    patterns = [
        r'"currencyAmount"\s*:\s*([\d.]+)',
        r'"amount"\s*:\s*([\d.]+)\s*,\s*"currencyCode"\s*:\s*"USD"',
        r'"priceToPay"\s*:\s*\{[^}]{0,200}?"amount"\s*:\s*([\d.]+)',
        r'"buyingPrice"\s*:\s*([\d.]+)',
        r'"displayPrice"\s*:\s*"\$?([\d,]+\.\d{2})"',
        r'"price"\s*:\s*\{\s*"value"\s*:\s*([\d.]+)',
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, html, re.IGNORECASE):
            price = _parse_price_text(match.group(1))
            if price is not None and 0.5 < price < 100000:
                return price
    return None


def _parse_price_text(text: str | None) -> float | None:
    if not text:
        return None
    cleaned = text.strip().replace("$", "").replace(",", "")
    try:
        return float(cleaned)
    except ValueError:
        return None


def _parse_aod_price(sel: Selector, *, asin: str | None = None) -> float | None:
    """AOD uses accessibility label, offscreen, and whole+fraction layouts."""
    for css in PRICE_SELECTORS:
        price = _price_from_selector(sel, css)
        if price is not None:
            return price

    offer_blocks = sel.css(
        "#aod-offer-price, #aod-pinned-offer, #aod-offer-list .aod-offer, .aod-offer"
    )
    for block in offer_blocks:
        whole = block.css("span.a-price-whole::text").get()
        frac = block.css("span.a-price-fraction::text").get()
        if whole and frac:
            price = _parse_price_text(f"${whole.strip()}.{frac.strip()}")
            if price is not None:
                return price

    wholes = sel.css("#aod-offer-list span.a-price-whole::text").getall()
    fracs = sel.css("#aod-offer-list span.a-price-fraction::text").getall()
    for whole, frac in zip(wholes, fracs):
        price = _parse_price_text(f"${whole.strip()}.{frac.strip()}")
        if price is not None:
            return price

    if asin:
        logger.warning("[WARN] price_not_found asin=%s", asin)
    return None


def detect_prime_flags(html: str) -> dict[str, bool]:
    """Detect Prime / Prime Pantry from AOD fragment or full product HTML."""
    low = html.lower()
    compact = re.sub(r"\s+", "", low)
    is_pantry = "prime pantry" in low or "primepantry" in compact
    is_prime = bool(
        re.search(
            r"a-icon-prime|i-prime|prime-badge|aod-prime|"
            r'aria-label="[^"]*prime|prime-exclusive|'
            r"amazonprime|ships from amazon.*prime",
            low,
        )
    )
    if not is_prime and re.search(r'"isprime"\s*:\s*true', compact):
        is_prime = True
    if not is_prime and "free delivery" in low and "prime" in low:
        is_prime = True
    if not is_prime and re.search(r"\bprime\s+member\b", low):
        is_prime = True
    return {"is_prime": is_prime, "is_prime_pantry": is_pantry}


def _parse_aod_offer_prices(sel: Selector) -> list[float]:
    prices: list[float] = []
    for offer in sel.css(".aod-offer, #aod-pinned-offer, #aod-offer-price"):
        p_text = offer.css(".a-price .a-offscreen::text").get()
        p = _parse_price_text(p_text)
        if p is not None:
            prices.append(p)
            continue
        whole = offer.css("span.a-price-whole::text").get()
        frac = offer.css("span.a-price-fraction::text").get()
        if whole and frac:
            p = _parse_price_text(f"${whole.strip()}.{frac.strip()}")
            if p is not None:
                prices.append(p)
    return prices


def _aod_best_price(sel: Selector, html: str, *, asin: str | None = None) -> float | None:
    price = _parse_aod_price(sel, asin=asin)
    if price is not None:
        return price
    offer_prices = _parse_aod_offer_prices(sel)
    if offer_prices:
        return min(offer_prices)
    price = extract_price_from_embedded_json(html)
    if price is not None:
        return price
    return extract_price_from_dollar_signs(html)


def parse_aod(html: str, *, asin: str | None = None) -> dict[str, Any]:
    """Parse AOD ajax fragment (aodAjaxMain endpoint, ~5-120KB)."""
    sel = Selector(text=html)
    price = _aod_best_price(sel, html, asin=asin)

    stock_parts: list[str] = []
    for css in (
        "#aod-offer-availability span::text",
        "#aod-availability span::text",
        ".aod-availability span::text",
        "#aod-pinned-offer .aod-delivery-promise span::text",
        ".aod-delivery-promise span::text",
        "#aod-offer-list .aod-delivery-promise span::text",
        "#aod-offer-price .aod-delivery-promise span::text",
    ):
        for t in sel.css(css).getall():
            t = (t or "").strip()
            if t and t not in stock_parts:
                stock_parts.append(t)
    stock_text = " ".join(stock_parts).strip()

    seller = sel.css("#aod-offer-soldBy a::text").get()
    seller = seller.strip() if seller else None
    if not seller:
        seller = sel.css(".aod-offer-soldBy a::text").get()
        seller = seller.strip() if seller else None
    if not seller:
        seller = sel.css("#aod-offer-list .aod-offer-seller a::text").get()
        seller = seller.strip() if seller else None

    is_amazon = False
    if seller:
        low = seller.lower()
        is_amazon = low in ("amazon.com", "amazon") or "amazon" in low

    low_html = html.lower()
    no_offers = "no featured offers available" in low_html
    oos_phrase = any(
        p in low_html
        for p in (
            "currently unavailable",
            "out of stock",
            "unavailable.",
            "we don't know when",
        )
    )

    is_in_stock = False
    if stock_text:
        st_low = stock_text.lower()
        if "out of stock" in st_low or "unavailable" in st_low:
            is_in_stock = False
        elif "in stock" in st_low or "left in stock" in st_low:
            is_in_stock = True
        elif "usually ships" in st_low or "delivery" in st_low:
            is_in_stock = True
    elif no_offers or oos_phrase:
        is_in_stock = False
    elif price is not None:
        is_in_stock = True

    if no_offers or oos_phrase:
        stock = "Out of Stock"
        is_in_stock = False
    elif stock_text:
        if is_in_stock:
            stock = "In Stock"
        elif "out of stock" in stock_text.lower() or "unavailable" in stock_text.lower():
            stock = "Out of Stock"
        else:
            stock = stock_text
    elif price is not None:
        stock = "In Stock"
        is_in_stock = True
    else:
        stock = "Unknown"

    all_offer_prices = _parse_aod_offer_prices(sel)
    prime = detect_prime_flags(html)

    return {
        "price": price,
        "stock": stock,
        "is_in_stock": is_in_stock,
        "buy_box_seller": seller,
        "is_amazon_fulfilled": is_amazon,
        "all_offer_prices": all_offer_prices,
        **prime,
    }


def parse_product_page_offer(html: str) -> dict[str, Any]:
    """Buy box price/stock from full product page when AOD is unavailable."""
    sel = Selector(text=html)

    price = None
    for css in PRICE_SELECTORS:
        price = _price_from_selector(sel, css)
        if price is not None:
            break

    if price is None:
        for pattern in (
            r'a-price-whole[^>]*>([\d,]+)</span>[\s\S]{0,120}?a-price-fraction[^>]*>(\d{2})',
            r'"priceAmount"\s*:\s*([\d.]+)',
            r'"price"\s*:\s*"([\d.]+)"',
            r'"lowPrice"\s*:\s*([\d.]+)',
            r'data-asin-price="([\d.]+)"',
            r'class="a-price-whole"[^>]*>([\d,]+)<',
        ):
            m = re.search(pattern, html, re.IGNORECASE)
            if m:
                if len(m.groups()) == 2:
                    price = _parse_price_text(f"${m.group(1)}.{m.group(2)}")
                else:
                    price = _parse_price_text(m.group(1))
                if price is not None:
                    break

    if price is None:
        for off in sel.css(".a-price .a-offscreen::text").getall():
            price = _parse_price_text(off)
            if price is not None and price > 0:
                break

    if price is None:
        price = extract_price_from_embedded_json(html)

    if price is None:
        price = extract_price_from_dollar_signs(html)

    availability = sel.css("#availability span::text").get() or ""
    availability = availability.strip()
    seller = sel.css("#sellerProfileTriggerId::text").get() or sel.css("#tabular-buybox .tabular-buybox-text a::text").get()
    seller = seller.strip() if seller else None
    if not seller:
        merchant = sel.css("#merchant-info a::text").get()
        seller = merchant.strip() if merchant else None

    is_amazon = seller is not None and "amazon" in seller.lower()
    is_in_stock = "in stock" in availability.lower() or "left in stock" in availability.lower()

    if not availability:
        stock = "Unknown"
    elif is_in_stock:
        stock = "In Stock"
    elif "unavailable" in availability.lower() or "out of stock" in availability.lower():
        stock = "Out of Stock"
    else:
        stock = availability

    prime = detect_prime_flags(html)
    return {
        "price": price,
        "stock": stock,
        "is_in_stock": is_in_stock,
        "buy_box_seller": seller,
        "is_amazon_fulfilled": is_amazon,
        **prime,
    }


def parse_full_page(html: str) -> dict[str, Any]:
    from parser_details import parse_product_details

    sel = Selector(text=html)
    details = parse_product_details(html)

    title = sel.css("#productTitle::text").get()
    title = title.strip() if title else None

    bullets = details["bullet_points"]
    description = details["description"]
    images = details["images"] or []

    rating_text = sel.css(".a-icon-star span.a-icon-alt::text, #acrPopover span.a-icon-alt::text").get()
    rating = None
    if rating_text:
        m = re.search(r"([\d.]+)", rating_text)
        if m:
            try:
                rating = float(m.group(1))
            except ValueError:
                rating = None

    reviews_text = sel.css("#acrCustomerReviewText::text").get() or ""
    reviews_count = None
    m = re.search(r"([\d,]+)", reviews_text.replace(",", ""))
    if m:
        try:
            reviews_count = int(m.group(1).replace(",", ""))
        except ValueError:
            reviews_count = None

    brand = sel.css("#bylineInfo::text").get()
    brand = brand.strip() if brand else None

    offer = parse_product_page_offer(html)

    return {
        "title": title,
        "description": description,
        "about_text": details.get("about_text"),
        "bullet_points": bullets,
        "attributes": details.get("attributes") or {},
        "dimensions": details.get("dimensions"),
        "images": images,
        "rating": rating,
        "reviews_count": reviews_count,
        "brand": brand,
        **offer,
    }


def is_captcha_html(html: str) -> bool:
    low = html.lower()
    return (
        "captcha" in low
        or "robot check" in low
        or "type the characters you see" in low
        or "automated access" in low
        or "sorry, we just need to make sure you're not a robot" in low
    )


def is_blocked_html(html: str, *, partial: bool = False) -> bool:
    """Detect Amazon bot/captcha pages. partial=True skips size heuristics (streaming buffers)."""
    if is_captcha_html(html):
        return True
    if partial:
        return False
    low = html.lower()
    if has_aod_signals(html):
        return False
    # Amazon generic 404 HTML (~2KB) — not a bot wall
    if len(html) < 15000 and "page not found" in low:
        return False
    if len(html) < 50000 and "producttitle" not in low:
        return True
    return False


def has_aod_signals(html: str) -> bool:
    """AOD ajax fragment — do not apply full-page size heuristics."""
    if len(html) < 400:
        return False
    low = html.lower()
    return (
        "aod-container" in low
        or "aod-offer" in low
        or "aod-offer-list" in low
        or "aod-pinned-offer" in low
        or "aod-ajax" in low
    )


def has_product_signals(html: str) -> bool:
    if has_aod_signals(html):
        return True
    if len(html) < 50000:
        return False
    return (
        "productTitle" in html
        or "aod-offer" in html
        or "corePrice" in html
        or "twister-plus-price" in html
    )
