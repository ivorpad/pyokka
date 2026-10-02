import os
import helper
from dataclasses import dataclass


@dataclass
class Account:
    owner: str
    balance: float = 0.0

    def deposit(self, amount):
        self.balance += amount
        return self.balance


def scale(value, factor):
    scaled = value * factor
    return scaled


base = 3
width = base + 1
area = scale(width, base)  # ?
acct = Account("ivor")
for amount in (10, 20):
    acct.deposit(amount)
acct  # ?+
total = sum(a.balance for a in [acct, Account("guest", 5)])
label = helper.describe(total, os.sep)
count = len(label)
result = helper.combine(area, count)
print(result)
flag = count > 5
preferred = label if flag else None
copy_of_label = label
settings = {"theme": "dark", "size": 3}
missing = settings.get("colour")
absent = label if count > 50 else None
