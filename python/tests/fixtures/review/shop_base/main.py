"""The October report, from the checked-in exports."""
from pathlib import Path

from shopkit.catalog import load_catalog
from shopkit.config import DEFAULT
from shopkit.invoices import build_invoice
from shopkit.orders import parse_orders
from shopkit.report import monthly_report, render

DATA = Path(__file__).parent / "data"


def main() -> None:
    catalog = load_catalog((DATA / "catalog.csv").read_text())
    orders = parse_orders((DATA / "orders.csv").read_text(), catalog)
    invoices = [build_invoice(order, DEFAULT) for order in orders]
    print(render(monthly_report(orders, invoices), DEFAULT.currency))


if __name__ == "__main__":
    main()
