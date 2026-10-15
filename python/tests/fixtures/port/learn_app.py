greeting = "héllo 🚀"; count = 3


def scale(values, factor):
    total = 0
    for v in values:
        total += v * factor
    with open(__file__, encoding="utf-8") as fh:
        first = fh.readline().strip()
    return total


count = scale([1, 2, 3], count)
print(greeting, count)
