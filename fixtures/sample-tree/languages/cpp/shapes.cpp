#include <cmath>
#include "shape.hpp"

class Circle : public Shape {
 public:
  double area() const { return 3.14159 * radius * radius; }

 private:
  double radius;
};
