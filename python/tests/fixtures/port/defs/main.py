import json
from shapes import Circle, area_of
import shapes.units as units
from helpers.text import shout

label = "é🚀"; c = Circle(2)
print(json.dumps(area_of(c)), units.scale(3), shout(label))
print(c.area(), Circle.area(c))
