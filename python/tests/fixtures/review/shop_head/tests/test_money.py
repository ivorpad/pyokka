import unittest

from shopkit.money import format_money, parse_money, round_money


class ParseMoney(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(parse_money("49.90"), 49.9)

    def test_symbol_and_spaces(self):
        self.assertEqual(parse_money(" $49.90 "), 49.9)

    def test_quoted(self):
        self.assertEqual(parse_money('"49.90"'), 49.9)

    def test_text_is_kept_for_the_audit_log(self):
        self.assertEqual(parse_money("n/a"), "n/a")

    def test_empty(self):
        with self.assertRaises(ValueError):
            parse_money("  ")


class RoundMoney(unittest.TestCase):
    def test_two_places(self):
        self.assertEqual(round_money(1.005 * 100), 100.5)


class FormatMoney(unittest.TestCase):
    def test_thousands(self):
        self.assertEqual(format_money(1258.79), "1,258.79 EUR")
