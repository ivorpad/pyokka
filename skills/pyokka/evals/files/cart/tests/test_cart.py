from cart import cart_total


def test_small_cart():
    assert cart_total([(2.0, 3), (5.0, 1)]) == 11.0


def test_bulk_cart_gets_discount():
    assert cart_total([(1.0, 6), (1.0, 6)]) == 10.8
