// The brush contract: how strokes reach the paint engine. Since v3 the paint
// itself lives in the fluid simulation (fluid.js); this module keeps the
// stable stroke-level API that main, the replayer, and episodes share.

import { DEFAULT_WATER, engineFor } from './fluid.js';

export const sizePixels = { s: 20, m: 38, l: 64 };

// Calibration anchor: a default-pressure stroke keeps roughly the footprint
// v1/v2 episodes were authored for; schemaVersion 1 episodes (no per-point
// pressure) replay at the same scale.
export const DEFAULT_PRESSURE = 0.65;
export const MIN_PRESSURE = 0.15;

export function clampPressure(pressure) {
  if (!Number.isFinite(pressure)) return DEFAULT_PRESSURE;
  return Math.min(1, Math.max(MIN_PRESSURE, pressure));
}

// One complete stroke deposited into the surface's fluid engine. Deposit
// only — callers own undo snapshots, settling ticks, and rendering, because
// live painting, agent painting, and canonical replay each pace those
// differently.
//
// `brush` carries the two properties that only a live brush has: `deplete`
// (the dip empties as the stroke travels) and `paint` (how big that dip is).
// They default off because the replayer must not have them — episodes author
// their tapers with per-point pressure and depend on non-depleting strokes for
// pixel determinism. The studio's own paint path passes them, so a scripted
// stroke and a hand stroke lay down the same paint; without that, the paint
// dial measured as having no effect at all while it moves active box area 3.6x.
export function paintStrokePath(surface, points, color, hardness, size, basePressure = DEFAULT_PRESSURE, water = DEFAULT_WATER, brush = {}) {
  if (!Array.isArray(points) || points.length === 0) return;
  const engine = engineFor(surface);
  const mapped = points.map((point) => ({ ...point, p: clampPressure(point.p ?? basePressure) }));
  engine.strokeFromPath(mapped, color, hardness, size, clampPressure(basePressure), water, brush);
}
