import { Shape } from './shape';

export class Circle extends Shape {
  render() {
    return <span>{square(this.radius)}</span>;
  }
}
