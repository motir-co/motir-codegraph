from geometry.core import Shape


class Circle(Shape):
    def area(self):
        return square(self.radius) * 3.14159
