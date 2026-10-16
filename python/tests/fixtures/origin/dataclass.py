"""A dataclass field holding text: parse_cents keeps one price as str, and line_total fails on it (after the review smoke's shopkit).

Line and Cart are dataclasses, so their reprs print their fields; Shop is a plain class, so its repr
prints none, and `shop.name` is the attribute origin cannot read.
"""

from dataclasses import dataclass


@dataclass
class Line:
    sku: str
    qty: int
    unit_cents: int


@dataclass
class Cart:
    owner: str
    lines: list


class Shop:
    def __init__(self, name, carts):
        self.name = name
        self.carts = carts


def parse_cents(text):
    t = text.strip()
    if "," in t:
        return t
    return int(float(t) * 100)


def line_total(line):
    return line.qty * line.unit_cents / 100


def subtotal(cart):
    total = 0.0
    for line in cart.lines:
        total += line_total(line)
    return total


rows = [("KB-01", 2, "49.90"), ("MON-27", 1, "1,249.00"), ("CBL-02", 3, "7.50")]
lines = []
for sku, qty, price in rows:
    lines.append(Line(sku, qty, parse_cents(price)))
shop = Shop("Pyokka", [Cart("Ana", lines)])
print(subtotal(shop.carts[0]))
