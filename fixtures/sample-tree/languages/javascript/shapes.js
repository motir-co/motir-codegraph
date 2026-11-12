import { Shape } from './shape.js';

export class Circle extends Shape {
  area() {
    return square(this.radius) * Math.PI;
  }
}
