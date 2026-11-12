local geometry = require("geometry")

local function area(radius)
  return geometry.square(radius) * math.pi
end

function describe(circle)
  return area(circle.radius)
end
