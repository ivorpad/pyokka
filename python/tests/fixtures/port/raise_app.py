def check(n):
    if n > 2:
        raise ValueError("too big: %d" % n)
    return n


def f(items):
    total = 0
    for n in items:
        total += check(n)
    return total


f([1, 2, 3])
