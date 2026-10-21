def bulk_bonus(order):
    for line in order["lines"]:
        if line["qty"] >= 1:
            line["qty"] += 1
    return order
