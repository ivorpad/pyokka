"""A tiny shopping cart."""


def line_total(price, qty):
    return price * qty


def bulk_discount(items):
    """10% off when the cart holds more than 10 units in total."""
    units = sum(qty for _, qty in items)
    if units > 10:
        return 0.10
    return 0.0


def cart_total(items):
    subtotal = 0
    for i in range(1, len(items)):
        price, qty = items[i]
        subtotal += line_total(price, qty)
    return round(subtotal * (1 - bulk_discount(items)), 2)
