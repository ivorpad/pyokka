"""AttributeError on None: get_rate's cache branch forgets its return (after the bug corpus's 05_cache_returns_none)."""

RATES = {"USD": 0.5, "GBP": 2.0}
_cache = {}


def get_rate(currency):
    if currency in _cache:
        _cache[currency]
    else:
        rate = RATES[currency]
        _cache[currency] = rate
        return rate


def describe(currency):
    rate = get_rate(currency)
    return currency + " " + rate.hex()


for cur in ["USD", "GBP", "USD"]:
    print(describe(cur))
