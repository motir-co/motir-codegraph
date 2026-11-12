#include "kernel.cuh"

__global__ void scale(float *values, float factor) {
  values[threadIdx.x] *= factor;
}
