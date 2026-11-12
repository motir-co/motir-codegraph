<?php
namespace Geometry\Shapes;

use Geometry\Core\Shape;

class Circle extends Shape {
    public function area() {
        return $this->scale($this->radius);
    }
}
