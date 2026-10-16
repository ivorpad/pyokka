import unittest

from shopkit.orders import Line
from shopkit.pricing import line_total, subtotal, tax


class Pricing(unittest.TestCase):
    def test_line_total(self):
        self.assertEqual(line_total(Line("KB-01", 2, 49.9)), 99.8)

    def test_subtotal(self):
        self.assertEqual(subtotal([Line("KB-01", 2, 49.9), Line("MS-07", 1, 19.9)]), 119.7)

    def test_tax(self):
        self.assertEqual(tax(119.7, 0.10), 11.97)
