"""Profit calculation for matched Product Finder listings."""


def calculate_profit(
    ebay_sold_price: float,
    amazon_price: float,
    ebay_fee_rate: float = 0.1325,   # eBay final value fee
    payment_fee_rate: float = 0.03,  # payment processing
    shipping_cost: float = 0.0,
    additional_fee: float = 0.0,
    vat_rate: float = 0.0,
) -> dict:
    """Net profit, margin %, ROI %."""
    revenue = float(ebay_sold_price)
    ebay_fee = revenue * ebay_fee_rate
    payment_fee = revenue * payment_fee_rate
    total_cost = float(amazon_price) * (1 + vat_rate) + additional_fee + shipping_cost
    net_profit = revenue - ebay_fee - payment_fee - total_cost
    margin = (net_profit / revenue * 100) if revenue > 0 else 0
    roi = (net_profit / total_cost * 100) if total_cost > 0 else 0

    return {
        "revenue": round(revenue, 2),
        "ebay_fee": round(ebay_fee, 2),
        "payment_fee": round(payment_fee, 2),
        "amazon_cost": round(total_cost, 2),
        "net_profit": round(net_profit, 2),
        "margin_percent": round(margin, 2),
        "roi_percent": round(roi, 2),
        "is_profitable": net_profit > 0,
    }


def _vat_rate_from_settings(settings: dict) -> float:
    vat = settings.get("vatDetails") or settings.get("vat") or {}
    enabled = bool(vat.get("vatEnabled", vat.get("enabled")))
    if not enabled:
        return 0.0
    pct = vat.get("vatRatePercent", vat.get("vatPercent", 0)) or 0
    try:
        return float(pct) / 100
    except (TypeError, ValueError):
        return 0.0


def _additional_fee_from_settings(settings: dict) -> float:
    fee = settings.get("additionalFee") or {}
    for key in ("fixedFee", "extraFeeFixed", "amount"):
        val = fee.get(key)
        if val:
            try:
                return float(val)
            except (TypeError, ValueError):
                continue
    return 0.0


def calculate_batch(listings: list[dict], store_settings: dict | None = None) -> list[dict]:
    """Add profit fields to listings that have both Amazon and eBay prices."""
    settings = store_settings or {}
    additional_fee = _additional_fee_from_settings(settings)
    vat_rate = _vat_rate_from_settings(settings)

    result: list[dict] = []
    for listing in listings:
        amazon_price = listing.get("amazon_price")
        sold_price = listing.get("sold_price")
        if amazon_price and sold_price:
            profit = calculate_profit(
                ebay_sold_price=sold_price,
                amazon_price=amazon_price,
                additional_fee=additional_fee,
                vat_rate=vat_rate,
            )
            result.append({**listing, **profit})
        else:
            result.append(
                {
                    **listing,
                    "net_profit": None,
                    "margin_percent": None,
                    "is_profitable": False,
                }
            )
    return result
