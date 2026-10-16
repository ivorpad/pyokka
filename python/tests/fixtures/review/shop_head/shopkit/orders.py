"""Orders from the sales export: one line per row, grouped by customer."""
import csv
import io
from dataclasses import dataclass, field

from .catalog import Product
from .money import parse_money


@dataclass
class Line:
    sku: str
    qty: int
    unit_price: float


@dataclass
class Order:
    customer: str
    tier: str | None
    lines: list[Line] = field(default_factory=list)


def parse_orders(csv_text: str, catalog: dict[str, Product]) -> list[Order]:
    """Rows grouped by customer. A row's unit_price (the price charged) overrides the catalog."""
    orders: dict[str, Order] = {}
    for row in csv.DictReader(io.StringIO(csv_text)):
        order = orders.setdefault(row["customer"], Order(row["customer"], row["tier"] or None))
        charged = (row.get("unit_price") or "").strip()
        unit_price = parse_money(charged) if charged else catalog[row["sku"]].price
        order.lines.append(Line(row["sku"], int(row["qty"]), unit_price))
    return list(orders.values())
