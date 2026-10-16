"""Loyalty and spend-tier discounts."""
from .config import Settings


def loyalty_rate(tier: str | None, settings: Settings) -> float:
    if tier == "platinum":
        # invite-only; the rate is set per deployment
        return settings.platinum_rate
    return settings.loyalty_rates.get(tier or "", 0.0)


def spend_tier_rate(spend: float, settings: Settings) -> float:
    """The spend-tier discount for a pre-tax subtotal, from settings.spend_tiers."""
    rate = 0.0
    for threshold, tier_rate in settings.spend_tiers:
        if spend > threshold:
            rate = tier_rate
    return rate


def combined_rate(tier: str | None, spend: float, settings: Settings) -> float:
    """Loyalty and spend tier stack, capped at settings.max_discount."""
    return min(loyalty_rate(tier, settings) + spend_tier_rate(spend, settings), settings.max_discount)
