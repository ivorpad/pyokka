# 🚀 Pyokka started automatically on this file.
# 👀 Explore the code below to see the features in action.
# 🧪 Change anything and watch the values update as you type.

# ----- 📝 LOGGING -----

# print() output appears right next to your code
import sys, os, math, random
pyokka = {"is_awesome": True, "python": sys.version.split()[0]}

print(pyokka)

# See the value of a variable simply by typing its name
pyokka

# Use logpoints (F9) or the special comment  # ?  to inspect expressions
# without changing the code
working_dir = os.getcwd()

os.cpu_count()  # ?

# Measure how long an expression takes with  # ?.
sum(i * i for i in range(10_000))  # ?.

# ----- 📊 COVERAGE -----

# Gutter squares show what ran: green = executed, gray = never executed,
# yellow = only part of the line executed (short-circuit / ternary)
print("partial", False and True)

if False:
    print("noCoverage", True)

# ----- 🪲 TIME MACHINE -----

# Press Shift+F5 (or the Time Machine button in the Pyokka panel) on any
# line, then step forward and *backward* with F10 / Ctrl+F10, F11 / Ctrl+F11.


class Point:
    def __init__(self, x, y):
        self.x = x
        self.y = y

    def distance(self, other):
        dx = self.x - other.x
        dy = self.y - other.y
        return math.sqrt(dx * dx + dy * dy)

    def move(self, dx, dy):
        self.x += dx
        self.y += dy


class Rectangle:
    def __init__(self, width, height, position):
        self.width = width
        self.height = height
        self.position = position

    def area(self):
        return self.width * self.height

    def contains(self, point):
        within_x = self.position.x <= point.x <= self.position.x + self.width
        within_y = self.position.y <= point.y <= self.position.y + self.height
        return within_x and within_y


def generate_random_point(max_x, max_y):
    x = random.randrange(max_x)
    y = random.randrange(max_y)
    return Point(x, y)


def rectangles_overlap(r1, r2):
    overlap_x = r1.position.x < r2.position.x + r2.width and r1.position.x + r1.width > r2.position.x
    overlap_y = r1.position.y < r2.position.y + r2.height and r1.position.y + r1.height > r2.position.y
    return overlap_x and overlap_y


point_a = Point(5, 10)
point_b = generate_random_point(100, 100)

rect1 = Rectangle(50, 20, Point(10, 10))
rect2 = Rectangle(30, 30, Point(40, 15))

print({"msg": f"Do rectangles overlap? {rectangles_overlap(rect1, rect2)}", "rect1": rect1, "rect2": rect2})
print({"msg": f"Is point_a inside rect1? {rect1.contains(point_a)}", "rect1": rect1, "point_a": point_a})
print({"msg": f"Distance between A and B: {point_a.distance(point_b)}", "point_a": point_a, "point_b": point_b})

# ----- 🔁 VALUES AS OF THIS STEP -----

# With the Time Machine on, inline values and hovers show what a value was at the
# current step, not at the end of the run: step through this loop with F10 and
# watch `total` grow one iteration at a time.
total = 0
for n in range(1, 4):
    total += n

# ----- 🚨 ERRORS -----

# A red square marks the line that raised, pink squares mark the stack path,
# and the message is shown beside the error
raise ValueError("Kaboom! This is just a test error.")
