defmodule Geometry.Circle do
  alias Geometry.Math
  @behaviour Geometry.Shape

  def area(radius) do
    Math.square(radius) * 3.14159
  end
end
