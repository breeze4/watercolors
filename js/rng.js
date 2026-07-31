// Deterministic position-seeded noise. The reference replayer promises that
// rendering to step K always produces identical pixels, so every "random"
// texture the brush lays down must derive from where it lands, never from
// Math.random or the clock.

export function hashNoise(x, y, salt = 0) {
  let h = (Math.round(x * 8) * 374761393 + Math.round(y * 8) * 668265263 + salt * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
