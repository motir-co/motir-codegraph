import { Shape } from './shape';

export class Circle extends Shape {
  area(): number {
    return square(this.radius) * Math.PI;
  }
}
