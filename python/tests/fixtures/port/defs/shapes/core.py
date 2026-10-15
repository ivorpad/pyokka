import math


class Circle:
    def __init__(self, r):
        self.r = r

    def area(self):
        return math.pi * self.r ** 2


def area_of(shape):
    return shape.area()
