TEMPLATE = {"sku": "apple", "qty": 1, "price": 1.0}


def new_order(customer):
    return {"customer": customer, "lines": [TEMPLATE]}
