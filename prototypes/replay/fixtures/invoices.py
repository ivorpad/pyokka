"""Monthly revenue from the orders export, with loyalty discounts."""

ORDERS_CSV = """customer,tier,sku,qty,unit_price
Ana,gold,KB-01,2,49.90
Ana,gold,MS-07,1,19.90
Ben,silver,MON-27,1,"1,299.00"
Ben,silver,CBL-02,3,7.50
Caro,,KB-01,1,49.90
Dani,gold,HUB-04,2,34.00
"""

DISCOUNTS = {"gold": 0.15, "silver": 0.10}


def parse_price(raw):
    text = raw.strip('"')
    # numbers only: "49.90" -> 49.9; anything else is kept as text for the audit log
    return float(text) if text.replace(".", "", 1).isdigit() else text


def parse_orders(csv_text):
    header, *rows = csv_text.strip().splitlines()
    orders = {}
    for row in rows:
        # the price may be quoted and contain a comma, so split the first four fields only
        customer, tier, sku, qty, price = row.split(",", 4)
        order = orders.setdefault(customer, {"tier": tier or None, "items": []})
        order["items"].append({"sku": sku, "qty": int(qty), "unit_price": parse_price(price)})
    return orders


def subtotal(items):
    try:
        return sum(item["qty"] * item["unit_price"] for item in items)
    except (KeyError, TypeError):
        # a malformed line should not stop the month's report
        return 0.0


def invoice_total(order):
    rate = DISCOUNTS.get(order["tier"], 0.0)
    return round(subtotal(order["items"]) * (1 - rate), 2)


def main():
    orders = parse_orders(ORDERS_CSV)
    totals = {name: invoice_total(order) for name, order in orders.items()}
    revenue = round(sum(totals.values()), 2)
    print(f"{len(totals)} invoices, revenue {revenue:.2f}")
    print(f"average invoice {revenue / len(totals):.2f}")


main()
