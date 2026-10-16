"""Money helpers: the export's price text as a number, rounding, formatting."""
import re

_SYMBOLS = "€$£"
_NUMBER = re.compile(r"^\d+(\.\d+)?$")


def parse_money(text: str) -> float | str:
    """The export's price text as a number: '49.90', ' $49.90 ', '"49.90"'.
    Text that is not a number is kept as it is, for the audit log."""
    t = text.strip().strip('"').lstrip(_SYMBOLS).strip()
    if not t:
        raise ValueError("empty price")
    return float(t) if _NUMBER.match(t) else t


def round_money(value: float, places: int = 2) -> float:
    return round(value, places)


def format_money(value: float, currency: str = "EUR") -> str:
    return f"{value:,.2f} {currency}"
