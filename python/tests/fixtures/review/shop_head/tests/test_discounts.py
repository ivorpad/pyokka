import unittest

from shopkit.config import DEFAULT
from shopkit.discounts import combined_rate, loyalty_rate, spend_tier_rate


class LoyaltyRate(unittest.TestCase):
    def test_tiers(self):
        self.assertEqual(loyalty_rate("gold", DEFAULT), 0.15)
        self.assertEqual(loyalty_rate("silver", DEFAULT), 0.10)
        self.assertEqual(loyalty_rate(None, DEFAULT), 0.0)


class SpendTierRate(unittest.TestCase):
    def test_below_first_tier(self):
        self.assertEqual(spend_tier_rate(499.0, DEFAULT), 0.0)

    def test_first_tier(self):
        self.assertEqual(spend_tier_rate(501.0, DEFAULT), 0.05)

    def test_second_tier(self):
        self.assertEqual(spend_tier_rate(1001.0, DEFAULT), 0.08)


class CombinedRate(unittest.TestCase):
    def test_stacks(self):
        self.assertAlmostEqual(combined_rate("silver", 1200.0, DEFAULT), 0.18)

    def test_capped(self):
        self.assertAlmostEqual(combined_rate("gold", 5000.0, DEFAULT), 0.23)
