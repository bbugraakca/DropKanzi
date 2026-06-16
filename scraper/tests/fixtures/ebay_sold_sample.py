"""Minimal eBay sold listing HTML for parser tests."""
SAMPLE_SOLD_CARD = """
<ul class="srp-results">
  <li class="s-item" data-listingid="123456789012">
    <a class="s-item__link" href="https://www.ebay.com/itm/123456789012">item</a>
    <div class="s-item__title"><span class="s-item__title--tagblock">Test Widget Pro</span></div>
    <span class="s-item__price">$19.99</span>
    <span class="s-item__subtitle"><span class="POSITIVE">Sold  May 14, 2025</span></span>
    <div class="s-item__details">5 sold</div>
  </li>
</ul>
"""

EMPTY_HTML = "<html><body></body></html>"

BROKEN_HTML = "<li class='s-item'><span class='s-item__price'>not a price</span></li>"
