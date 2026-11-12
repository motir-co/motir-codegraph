use crate::geometry::Shape;

pub struct Circle {
    radius: f64,
}

impl Shape for Circle {
    fn area(&self) -> f64 {
        square(self.radius)
    }
}
