def double(n):
    # twice n
    return n * 2


def apply_all(fn, values):
    total = 0
    for v in values:
        total += fn(v)
    return total


print(apply_all(double, [1, 2, 3]))
