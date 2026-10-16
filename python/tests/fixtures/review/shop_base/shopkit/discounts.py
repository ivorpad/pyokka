"""Loyalty discounts."""
from .config import Settings


def loyalty_rate(tier: str | None, settings: Settings) -> float:
    return settings.loyalty_rates.get(tier or "", 0.0)
