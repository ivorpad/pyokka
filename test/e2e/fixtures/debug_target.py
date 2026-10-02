"""Debugger e2e target: a loop calling a small function, a dict mutated on every pass."""


def bump(store, i):
    store["x"] = i
    return store["x"] * 2


payload = {"x": 0, "items": []}
total = 0
for i in range(4):
    d = bump(payload, i)
    total += d
    payload["items"].append(i)
print(total)
