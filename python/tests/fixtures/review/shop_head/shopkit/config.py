"""Settings for the monthly report."""
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Settings:
    currency: str = "EUR"
    tax_rate: float = 0.10
    loyalty_rates: dict = field(default_factory=lambda: {"gold": 0.15, "silver": 0.10})
    # spend tiers: (pre-tax subtotal threshold, rate), ascending
    spend_tiers: tuple = ((500.0, 0.05), (1000.0, 0.08))
    max_discount: float = 0.25
    places: int = 2


DEFAULT = Settings()
