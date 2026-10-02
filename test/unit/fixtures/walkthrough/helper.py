def double(x):
    y = x * 2
    return y


def fail(n):
    if n > 100:
        return n
    raise ValueError("too small: %d" % n)
