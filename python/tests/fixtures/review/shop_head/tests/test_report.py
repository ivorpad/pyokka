import tempfile
import unittest
from pathlib import Path

from shopkit.invoices import Invoice
from shopkit.orders import Line, Order
from shopkit.report import export_csv, monthly_report, render


class Report(unittest.TestCase):
    def setUp(self):
        self.orders = [Order("Ana", "gold", [Line("KB-01", 2, 49.9)]), Order("Caro", None, [Line("KB-01", 1, 49.9)])]
        self.invoices = [Invoice("Ana", 99.8, 14.97, 8.48, 93.31), Invoice("Caro", 49.9, 0.0, 4.99, 54.89)]

    def test_totals(self):
        report = monthly_report(self.orders, self.invoices)
        self.assertEqual(report.count, 2)
        self.assertEqual(report.revenue, 148.2)
        self.assertEqual(report.average, 74.1)
        self.assertEqual(report.top_skus, [("KB-01", 3)])

    def test_render(self):
        text = render(monthly_report(self.orders, self.invoices))
        self.assertIn("2 invoices, revenue 148.20 EUR", text)
        self.assertIn("  Ana    93.31 EUR", text)

    def test_export_csv(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "report.csv"
            export_csv(monthly_report(self.orders, self.invoices), out)
            self.assertEqual(out.read_text().splitlines(), ["customer,total", "Ana,93.31", "Caro,54.89"])
