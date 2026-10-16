"""The product catalog, from the warehouse export."""
import csv
import io
from dataclasses import dataclass

from .money import parse_money


@dataclass(frozen=True)
class Product:
    sku: str
    name: str
    price: float


def load_catalog(csv_text: str) -> dict[str, Product]:
    products: dict[str, Product] = {}
    for row in csv.DictReader(io.StringIO(csv_text)):
        products[row["sku"]] = Product(row["sku"], row["name"], parse_money(row["price"]))
    return products
