def tier_of(customer, tiers):
    return tiers[customer]


tiers = {"Ana": "gold"}
print(tier_of("Ana", tiers))
print(tier_of("Ben", tiers))
