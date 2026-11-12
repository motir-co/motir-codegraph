using System;
using Geometry.Core;

namespace Geometry.Shapes
{
    public class Circle : Shape
    {
        public double Area(Shape other)
        {
            return other.Scale(2.0);
        }
    }
}
