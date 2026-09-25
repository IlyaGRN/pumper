// Average along discrete lines at the requested angle. Sliding sums make this
// linear in image size, with no per-sample Canvas rounding or blur-radius cost.
// Alpha weights exclude the subject; normalizing coverage avoids dark borders.
export function motionBlurPixels(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  amount: number,
  angle: number,
) {
  const result = new Uint8ClampedArray(source.length);
  const radians = (angle * Math.PI) / 180;
  const horizontal = Math.abs(Math.cos(radians)) >= Math.abs(Math.sin(radians));
  const majorDirection = horizontal ? Math.cos(radians) : Math.sin(radians);
  const minorDirection = horizontal ? Math.sin(radians) : Math.cos(radians);
  const slope = Math.abs(minorDirection / majorDirection);
  const reverse = minorDirection / majorDirection < 0;
  const major = horizontal ? width : height;
  const minor = horizontal ? height : width;
  const radius = Math.max(0, Math.round((amount * Math.abs(majorDirection)) / 2));
  const shift = Int32Array.from({ length: major }, (_, i) => Math.floor(i * slope + 1e-9));
  const lowerBound = (value: number) => {
    let low = 0,
      high = major;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (shift[middle] < value) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  for (let line = -shift[major - 1]; line < minor; line++) {
    const start = lowerBound(-line),
      end = lowerBound(minor - line);
    if (start === end) continue;
    const index = (u: number) => {
      const v = reverse ? minor - 1 - line - shift[u] : line + shift[u];
      return 4 * (horizontal ? v * width + u : u * width + v);
    };
    let red = 0,
      green = 0,
      blue = 0,
      alpha = 0;
    const accumulate = (u: number, direction: number) => {
      const i = index(u),
        weight = source[i + 3] * direction;
      red += source[i] * weight;
      green += source[i + 1] * weight;
      blue += source[i + 2] * weight;
      alpha += weight;
    };
    for (let u = start; u <= Math.min(end - 1, start + radius); u++) accumulate(u, 1);
    for (let u = start; u < end; u++) {
      const i = index(u);
      if (alpha > 0) {
        result[i] = red / alpha;
        result[i + 1] = green / alpha;
        result[i + 2] = blue / alpha;
        result[i + 3] = 255;
      }
      if (u - radius >= start) accumulate(u - radius, -1);
      if (u + radius + 1 < end) accumulate(u + radius + 1, 1);
    }
  }
  return result;
}
