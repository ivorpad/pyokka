"""Settings for the monthly report."""
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Settings:
    currency: str = "EUR"
    tax_rate: float = 0.10
    loyalty_rates: dict = field(default_factory=lambda: {"gold": 0.15, "silver": 0.10})
    places: int = 2


DEFAULT = Settings()
