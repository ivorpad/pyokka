LIMIT = 100


def price(qty, unit):
    total = qty * unit
    if total > LIMIT:
        total = total * 0.9
    return total


orders = [{"qty": 3, "unit": 20}, {"qty": 1, "unit": 50}]
totals = []
for o in orders:
    totals.append(price(o["qty"], o["unit"]))
print(sum(totals))
