require 'geometry/shape'

class Circle < Shape
  def area
    square(radius) * Math::PI
  end
end
