import unittest

from shopkit.money import parse_money, round_money


class ParseMoney(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(parse_money("49.90"), 49.9)

    def test_symbol_and_spaces(self):
        self.assertEqual(parse_money(" $49.90 "), 49.9)

    def test_quoted(self):
        self.assertEqual(parse_money('"49.90"'), 49.9)

    def test_empty(self):
        with self.assertRaises(ValueError):
            parse_money("  ")


class RoundMoney(unittest.TestCase):
    def test_two_places(self):
        self.assertEqual(round_money(1.005 * 100), 100.5)
