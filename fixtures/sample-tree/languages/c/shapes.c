#include <math.h>
#include "shape.h"

struct circle {
  double radius;
};

double circle_area(const struct circle *c) {
  return M_PI * square(c->radius);
}
