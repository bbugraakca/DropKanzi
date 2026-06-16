"""Tests for eBay sold-date parsing."""

from datetime import datetime, timezone, timedelta

from ebay_scraper import parse_ebay_date


def test_absolute_sold_date():
    dt = parse_ebay_date("Sold May 14, 2025")
    assert dt is not None
    assert dt.year == 2025 and dt.month == 5 and dt.day == 14


def test_relative_days_ago():
    dt = parse_ebay_date("Sold 3 days ago")
    assert dt is not None
    expected = datetime.now(timezone.utc) - timedelta(days=3)
    assert abs((dt - expected).total_seconds()) < 86400


def test_yesterday():
    dt = parse_ebay_date("Ended yesterday")
    assert dt is not None
    assert dt.date() == (datetime.now(timezone.utc) - timedelta(days=1)).date()


def test_month_day_without_year():
    dt = parse_ebay_date("Sold Mar 5")
    assert dt is not None
    assert dt.month == 3 and dt.day == 5
