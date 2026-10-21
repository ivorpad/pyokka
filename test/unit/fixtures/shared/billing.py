class Ledger:
    def __init__(self):
        self.totals = {}

    def charge(self, order):
        amount = 0
        for line in order["lines"]:
            amount += line["qty"] * line["price"]
        self.totals[order["customer"]] = amount
        return amount
