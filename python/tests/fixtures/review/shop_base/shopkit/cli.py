"""shopkit report ORDERS.csv --catalog CATALOG.csv"""
import argparse
import sys
from pathlib import Path

from .catalog import load_catalog
from .config import DEFAULT
from .invoices import build_invoice
from .orders import parse_orders
from .report import monthly_report, render


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="shopkit")
    sub = parser.add_subparsers(dest="command", required=True)
    rep = sub.add_parser("report", help="the monthly report")
    rep.add_argument("orders", type=Path)
    rep.add_argument("--catalog", type=Path, required=True)
    args = parser.parse_args(argv)
    catalog = load_catalog(args.catalog.read_text())
    orders = parse_orders(args.orders.read_text(), catalog)
    invoices = [build_invoice(order, DEFAULT) for order in orders]
    print(render(monthly_report(orders, invoices), DEFAULT.currency))
    return 0


if __name__ == "__main__":
    sys.exit(main())
