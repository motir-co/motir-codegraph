package geometry.shapes

import geometry.core.Shape

class Circle : Shape() {
    fun area(): Double {
        return square(radius)
    }
}
