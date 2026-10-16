import unittest

from shopkit.catalog import load_catalog
from shopkit.orders import parse_orders

CATALOG = "sku,name,price\nKB-01,Keyboard,49.90\nMS-07,Mouse,19.90\n"
ORDERS = "customer,tier,sku,qty,unit_price\nAna,gold,KB-01,2,\nAna,gold,MS-07,1,15.00\nCaro,,KB-01,1,\n"


class ParseOrders(unittest.TestCase):
    def setUp(self):
        self.orders = parse_orders(ORDERS, load_catalog(CATALOG))

    def test_grouped_by_customer(self):
        self.assertEqual([o.customer for o in self.orders], ["Ana", "Caro"])
        self.assertEqual(len(self.orders[0].lines), 2)

    def test_charged_price_overrides_catalog(self):
        self.assertEqual(self.orders[0].lines[1].unit_price, 15.0)
        self.assertEqual(self.orders[0].lines[0].unit_price, 49.9)

    def test_missing_tier_is_none(self):
        self.assertIsNone(self.orders[1].tier)
