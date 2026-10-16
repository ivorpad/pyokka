"""The monthly report: revenue, average invoice, totals per customer, top products."""
import csv
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from .invoices import Invoice
from .money import format_money, round_money
from .orders import Order


@dataclass(frozen=True)
class Report:
    count: int
    revenue: float
    average: float
    by_customer: dict[str, float]
    top_skus: list[tuple[str, int]]


def monthly_report(orders: list[Order], invoices: list[Invoice]) -> Report:
    revenue = round_money(sum(inv.total for inv in invoices))
    units: Counter = Counter()
    for order in orders:
        for line in order.lines:
            units[line.sku] += line.qty
    average = round_money(revenue / len(invoices)) if invoices else 0.0
    return Report(len(invoices), revenue, average, {inv.customer: inv.total for inv in invoices}, units.most_common(3))


def render(report: Report, currency: str = "EUR") -> str:
    lines = [
        f"{report.count} invoices, revenue {format_money(report.revenue, currency)}",
        f"average invoice {format_money(report.average, currency)}",
    ]
    for customer, total in sorted(report.by_customer.items()):
        lines.append(f"  {customer:<6} {format_money(total, currency)}")
    lines.append("top skus: " + ", ".join(f"{sku} x{qty}" for sku, qty in report.top_skus))
    return "\n".join(lines)


def export_csv(report: Report, path: Path) -> None:
    """One row per customer: customer, total."""
    with path.open("w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["customer", "total"])
        for customer, total in sorted(report.by_customer.items()):
            writer.writerow([customer, f"{total:.2f}"])
