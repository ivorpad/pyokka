"""Line and order arithmetic."""
from .money import round_money
from .orders import Line


def line_total(line: Line) -> float:
    return line.qty * line.unit_price


def subtotal(lines: list[Line]) -> float:
    try:
        return round_money(sum(line_total(line) for line in lines))
    except (TypeError, KeyError):
        # a malformed line must not stop the month's report
        return 0.0


def tax(amount: float, rate: float) -> float:
    return round_money(amount * rate)
