package geometry.shapes;

import geometry.core.Shape;

class Circle extends Shape {
  double area() {
    return scale(radius);
  }
}
