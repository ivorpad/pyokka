def run(nodes, state):
    return _a(nodes, state)
def _a(n, s):
    return _b(n, s)
def _b(n, s):
    return _c(n, s)
def _c(n, s):
    for f in n:
        s = f(s)
    return s
