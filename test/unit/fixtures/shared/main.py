from billing import Ledger
from catalog import new_order
from promo import bulk_bonus


def main():
    ledger = Ledger()
    ana = new_order("ana")
    bo = new_order("bo")
    bulk_bonus(ana)  # only ana gets the bonus
    ledger.charge(ana)
    bill = ledger.charge(bo)
    print("bo pays", bill, "ledger", ledger.totals)


main()
