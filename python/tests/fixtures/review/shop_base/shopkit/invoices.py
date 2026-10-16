"""An invoice per order: subtotal, discount, tax, total."""
from dataclasses import dataclass

from .config import Settings
from .discounts import loyalty_rate
from .money import round_money
from .orders import Order
from .pricing import subtotal, tax


@dataclass(frozen=True)
class Invoice:
    customer: str
    subtotal: float
    discount: float
    tax: float
    total: float


def build_invoice(order: Order, settings: Settings) -> Invoice:
    sub = subtotal(order.lines)
    discount = round_money(sub * loyalty_rate(order.tier, settings))
    taxed = tax(sub - discount, settings.tax_rate)
    return Invoice(order.customer, sub, discount, taxed, round_money(sub - discount + taxed))
