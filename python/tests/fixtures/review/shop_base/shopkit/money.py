"""Money helpers: the export's price text as a number, rounding."""

_SYMBOLS = "€$£"


def parse_money(text: str) -> float:
    """The export's price text as a number: '49.90', ' $49.90 ', '"1,249.00"'."""
    t = text.strip().strip('"').lstrip(_SYMBOLS).replace(",", "").strip()
    if not t:
        raise ValueError("empty price")
    return float(t)


def round_money(value: float, places: int = 2) -> float:
    return round(value, places)
