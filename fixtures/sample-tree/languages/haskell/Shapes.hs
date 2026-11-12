module Geometry.Shapes where

import Data.List (sortOn)

data Circle = Circle Double

instance Show Circle where
  show (Circle r) = describe r

area :: Circle -> Double
area (Circle r) = square r * pi
