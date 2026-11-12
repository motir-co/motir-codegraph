package shapes

import "math"

type Shape interface {
	Area() float64
}

type Drawer interface {
	Shape
	Draw()
}

type Circle struct{ Radius float64 }

func (c Circle) Area() float64 {
	return math.Pow(c.Radius, 2) * math.Pi
}
