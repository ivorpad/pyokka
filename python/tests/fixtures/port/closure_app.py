import os

config = {"mode": "x"}
top = 1


def outer():
    k = 10

    def inner(a):
        b = a + k + top
        return b

    return inner(5)


outer()
