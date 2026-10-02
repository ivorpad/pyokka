"""Debugger e2e target: prints, a handled ValueError inside a call, then one nobody catches."""


def check(n):
    if n > 2:
        raise ValueError("too big: %d" % n)
    return n


def parse(text):
    try:
        return int(text)
    except ValueError:
        return -1


print("start")
print(parse("x"))
total = 0
for i in range(5):
    total += check(i)
print("end", total)
