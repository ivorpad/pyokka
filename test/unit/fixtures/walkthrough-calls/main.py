import runner

def double(s):
    return s * 2

def inc(s):
    return s + 1

def ask(x):
    out = runner.run([double, inc], x)
    return out

def inner(x):
    y = x + 1
    z = y * 2
    return z

def outer(x):
    return inner(x)

def rank(scores):
    ranked = sorted(
        scores.items(),
        key=lambda kv: kv[1],
    )
    return ranked

def main():
    print(ask(3))
    print(outer(4))
    print(rank({"a": 3, "b": 1}))

main()
