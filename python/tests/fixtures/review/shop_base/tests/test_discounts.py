import unittest

from shopkit.config import DEFAULT
from shopkit.discounts import loyalty_rate


class LoyaltyRate(unittest.TestCase):
    def test_tiers(self):
        self.assertEqual(loyalty_rate("gold", DEFAULT), 0.15)
        self.assertEqual(loyalty_rate("silver", DEFAULT), 0.10)
        self.assertEqual(loyalty_rate(None, DEFAULT), 0.0)
