/** Pixel-space gradient geometry: zero points right, positive angles point up. */
export function gradientAngleCoordinates(angle: number, start: number, end: number): string {
  if (![angle, start, end].every(Number.isFinite)) {
    throw new Error('invalid_arguments: gradient geometry must be finite');
  }
  const radians = (((angle % 360) + 360) % 360) * Math.PI / 180;
  const dx = Math.cos(radians), dy = -Math.sin(radians);
  return `
    var gradientDX = ${Math.abs(dx) < 1e-12 ? 0 : dx};
    var gradientDY = ${Math.abs(dy) < 1e-12 ? 0 : dy};
    var gradientSpan = Math.abs(docW * gradientDX) + Math.abs(docH * gradientDY);
    fromXPx = docW / 2 + gradientDX * gradientSpan * (${start} / 100 - 0.5);
    fromYPx = docH / 2 + gradientDY * gradientSpan * (${start} / 100 - 0.5);
    toXPx = docW / 2 + gradientDX * gradientSpan * (${end} / 100 - 0.5);
    toYPx = docH / 2 + gradientDY * gradientSpan * (${end} / 100 - 0.5);
  `;
}
