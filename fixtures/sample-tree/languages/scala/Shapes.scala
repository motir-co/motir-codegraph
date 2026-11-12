package geometry.shapes

import geometry.core.Shape

class Circle extends Shape {
  def area(): Double = square(radius)
}
