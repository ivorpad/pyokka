def line_total(qty, price):
    return qty * price


items = [(2, 5), (3, 4)]
total = 0
for qty, price in items:
    total += line_total(qty, price)
print(total)
