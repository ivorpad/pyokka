import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'venv', 'site-packages'))
import helper
import libq


def greet(name):
    # says hello
    msg = "hello " + name
    return msg


class Counter:
    def __init__(self, start):
        self.value = start

    def bump(self, by):
        self.value += by
        return self.value


total = 0
for i in range(3):
    total += helper.double(i)
for j in []:
    total += 1
k = 0
while k < 2:
    k += 1
if (total > 100
        and k > 0):
    big = True
elif total > 5:
    mid = True
else:
    small = True
match total:
    case 0:
        z = 0
    case _:
        z = 1
c = Counter(10)
c.bump(5)
seen = libq.run(lambda n: n * 2)
print(greet("bob"), total)
try:
    helper.fail(total)
except ValueError:
    handled = True
result = helper.fail(total)
