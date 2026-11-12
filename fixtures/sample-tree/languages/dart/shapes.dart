import 'package:geometry/shape.dart';

class Circle extends Shape {
  double area() {
    return scale(radius);
  }
}
