// The fluid paint engine: water and pigment simulated per cell on textured
// paper, after the Rebelle experiment's architecture (see
// docs/research/2026-07-30-02-rebelle-watercolor-technique.md). The visible
// canvas is a rendered composite of sim state; strokes deposit into the sim
// and the sim keeps moving until it dries. Everything derives from stroke
// data, the fixed paper seed, and an integer tick counter — never the clock —
// so the reference replayer stays pixel-deterministic.

import { hexToRgb } from './color.js';
import { hashNoise } from './rng.js';

const MAX_GRID = 1024;
const DENSITY_MAX = 3000;
const PIGMENT_PER_STAMP = 2200;
const WATER_PER_STAMP = 9;
const PAPER_GATE = 0.55;
const EVAP_KEEP = 0.995;
const EVAP_LINEAR = 0.001;
const EVAP_EDGE_BOOST = 50;
const EVAP_FLOOR = 2;
const REDISSOLVE_RATE = 0.0001;
const REDISSOLVE_WATER_GAIN = 50;
const PRESSURE_FLOW = 0.5;
const ACCEL_CLAMP = 0.2;
const PAPER_FLOW = 0.2;
const SMOOTH_WATER_MIN = 0.2;
const VELOCITY_CLAMP = 1;
const HEAVY_PIGMENT = 2000;
const PROJECT_STRENGTH = 0.7;
// Rebelle's default: standing water sags downward slightly, so a soaked
// stroke visibly runs while a damp one holds its shape.
const GRAVITY_Y = 0.005;

// Water control midpoint: at 0.5 the wetness product equals the
// hardness-only calibration that episodes replay against.
export const DEFAULT_WATER = 0.5;
const RELIEF_GAIN = 0.008;
const RELIEF_CLAMP = 40;
const RELIEF_FADE_START = 1000;
const WET_NEIGHBOR_DENSITY = 10;

// Coverage: density → visual opacity, the exponential saturation curve real
// pigment follows (doubling a thin wash darkens it; doubling a heavy one
// barely does).
const COVERAGE = new Float32Array(DENSITY_MAX + 1);
for (let index = 1; index <= DENSITY_MAX; index += 1) {
  COVERAGE[index] = 0.002 + COVERAGE[index - 1] * 0.998;
}

function coverage(density) {
  if (density <= 0) return 0;
  if (density >= DENSITY_MAX) return 1;
  return COVERAGE[density | 0];
}

// Density from coverage — inverse of the table, for rehydrating a rendered
// image back into deposited pigment on undo/load/resize.
function densityFromCoverage(cov) {
  if (cov <= 0) return 0;
  if (cov >= 0.997) return DENSITY_MAX;
  return Math.min(DENSITY_MAX, Math.log(1 - cov) / Math.log(0.998));
}

// Smooth value noise on a lattice: deterministic, position-seeded, no assets.
function smoothNoise(x, y, scale, salt) {
  const gx = x / scale;
  const gy = y / scale;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const n00 = hashNoise(x0, y0, salt);
  const n10 = hashNoise(x0 + 1, y0, salt);
  const n01 = hashNoise(x0, y0 + 1, salt);
  const n11 = hashNoise(x0 + 1, y0 + 1, salt);
  const top = n00 + (n10 - n00) * sx;
  const bottom = n01 + (n11 - n01) * sx;
  return top + (bottom - top) * sy;
}

// Bristle hairs: each stroke gets a 1D profile across the brush width,
// sampled perpendicular to the (smoothed) stroke direction. Because the
// profile is constant along the stroke, each hair draws a continuous line —
// like a real brush dragged through paint. Seeded from the stroke's first
// point so replay is deterministic.
const BRISTLE_LANES = 64;

function buildBristleProfile(seedX, seedY) {
  const profile = new Float32Array(BRISTLE_LANES);
  for (let index = 0; index < BRISTLE_LANES; index += 1) {
    const fine = hashNoise(seedX, seedY, 7000 + index);
    // Blocks of four lanes share a value, so hairs are a few cells wide
    // instead of single-pixel noise.
    const lane = hashNoise(seedX, seedY, 7100 + (index >> 2));
    // The exponent spreads lane values apart — distinct hairs, not a blur.
    let value = Math.pow(0.3 + 0.8 * (0.35 * fine + 0.65 * lane), 1.6);
    // Starved hairs leave genuine tracks of paper through the stroke, and a
    // few thin ones just run lighter.
    if (lane < 0.24) value *= 0.3;
    else if (fine < 0.14) value *= 0.55;
    profile[index] = value;
  }
  return profile;
}

const engines = new WeakMap();

// One engine per surface, rebuilt when the surface's backing store changes
// size; the repaint that survives a rebuild is rehydrated from the canvas.
export function engineFor(surface) {
  const existing = engines.get(surface);
  const dpr = surface.dpr();
  const cssWidth = Math.max(1, Math.round(surface.canvas.width / dpr));
  const cssHeight = Math.max(1, Math.round(surface.canvas.height / dpr));
  if (existing && existing.cssWidth === cssWidth && existing.cssHeight === cssHeight) return existing;
  const engine = createFluidEngine(surface, cssWidth, cssHeight);
  if (existing) engine.rehydrateFromCanvas();
  engines.set(surface, engine);
  return engine;
}

export function createFluidEngine(surface, cssWidth, cssHeight) {
  const scale = Math.min(1, MAX_GRID / Math.max(cssWidth, cssHeight));
  const gridWidth = Math.max(4, Math.round(cssWidth * scale));
  const gridHeight = Math.max(4, Math.round(cssHeight * scale));
  const stride = gridWidth + 2;
  const rows = gridHeight + 2;
  const cells = stride * rows;

  const water = new Float32Array(cells);
  const susDensity = new Float32Array(cells);
  const susR = new Float32Array(cells);
  const susG = new Float32Array(cells);
  const susB = new Float32Array(cells);
  const depDensity = new Float32Array(cells);
  const depR = new Float32Array(cells);
  const depG = new Float32Array(cells);
  const depB = new Float32Array(cells);
  const velX = new Float32Array(cells);
  const velY = new Float32Array(cells);
  const tmpX = new Float32Array(cells);
  const tmpY = new Float32Array(cells);
  const active = new Uint8Array(cells);
  const paper = new Float32Array(cells);
  const strokeBuffer = new Float32Array(cells);
  // Cells that have carried standing water: flow keeps its momentum through
  // recently-wet paper instead of stalling at the first dry cell, which is
  // what lets pigment ride out to a wash's rim and darken it.
  const wetMemory = new Float32Array(cells);

  // Fixed-seed paper: identical for the user canvas, the reference canvas,
  // and every session, so replay and live painting share one sheet.
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < stride; x += 1) {
      const tooth = smoothNoise(x, y, 2.4, 101);
      const fiber = smoothNoise(x, y, 7, 102);
      const wave = smoothNoise(x, y, 23, 103);
      const height = 0.62 + (tooth - 0.5) * 0.4 + (fiber - 0.5) * 0.28 + (wave - 0.5) * 0.2;
      paper[x + y * stride] = Math.min(1, Math.max(0.05, height));
    }
  }

  const offscreen = document.createElement('canvas');
  offscreen.width = gridWidth;
  offscreen.height = gridHeight;
  const offscreenContext = offscreen.getContext('2d', { willReadFrequently: true });
  offscreenContext.fillStyle = '#fff';
  offscreenContext.fillRect(0, 0, gridWidth, gridHeight);
  const frame = offscreenContext.getImageData(0, 0, gridWidth, gridHeight);

  let tickCount = 0;
  let wetCells = 0;
  let maxSpeed = 0;
  // Active bounding box in grid coords (interior cells 1..gridWidth/Height).
  let boxLeft = gridWidth;
  let boxRight = 1;
  let boxTop = gridHeight;
  let boxBottom = 1;
  let dirty = false;
  let lastTickMs = 0;

  let stroke = null;

  function resetBox() {
    boxLeft = gridWidth;
    boxRight = 1;
    boxTop = gridHeight;
    boxBottom = 1;
  }

  function growBox(left, right, top, bottom) {
    if (left < boxLeft) boxLeft = Math.max(1, left);
    if (right > boxRight) boxRight = Math.min(gridWidth, right);
    if (top < boxTop) boxTop = Math.max(1, top);
    if (bottom > boxBottom) boxBottom = Math.min(gridHeight, bottom);
  }

  function hasBox() {
    return boxRight >= boxLeft && boxBottom >= boxTop;
  }

  // --- Deposition -----------------------------------------------------------

  function stampRadius(sizeCss, pressure) {
    return Math.max(1.2, (sizeCss / 2) * (0.48 + 0.8 * pressure) * scale);
  }

  function stamp(gx, gy, radius, pressure, softness, wetness, color) {
    const load = stroke.load;
    // An empty brush marks nothing; before that, the paper gate silences the
    // starved tail naturally rather than cutting it off.
    if (load <= 0.001) return;
    const wetnessNow = wetness * load;
    const amplitude = Math.min(1, 0.28 + 0.95 * pressure) * (0.15 + 0.85 * load);
    const soft2 = softness * softness;
    const reach = Math.ceil(radius);
    const minX = Math.max(1, Math.floor(gx) - reach);
    const maxX = Math.min(gridWidth, Math.floor(gx) + reach);
    const minY = Math.max(1, Math.floor(gy) - reach);
    const maxY = Math.min(gridHeight, Math.floor(gy) + reach);
    growBox(minX - 4, maxX + 4, minY - 4, maxY + 4);
    // Hairs show on a thirsty brush and melt away as water rises — a soaked
    // wash floods the tracks the way real bristle marks disappear when wet.
    const profile = stroke.profile;
    const contrast = Math.min(1, Math.max(0.1, 1.15 - wetnessNow * 0.55));
    const dirX = stroke.dirX;
    const dirY = stroke.dirY;
    // Slow waver along the arc keeps hairs organic instead of ruled.
    const waver = 0.82 + 0.36 * smoothNoise(stroke.arc, 0, 9 * Math.max(1, radius * 0.4), stroke.seedSalt);
    for (let y = minY; y <= maxY; y += 1) {
      const row = y * stride;
      const dy = y - gy;
      for (let x = minX; x <= maxX; x += 1) {
        const dx = x - gx;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > radius) continue;
        let falloff = ((radius - distance) * soft2) / radius;
        falloff = falloff < 1 ? falloff * falloff * (3 - 2 * falloff) : 1;
        const across = (dx * -dirY + dy * dirX) / radius;
        let laneIndex = ((across * 0.5 + 0.5) * (BRISTLE_LANES - 1)) | 0;
        if (laneIndex < 0) laneIndex = 0;
        else if (laneIndex >= BRISTLE_LANES) laneIndex = BRISTLE_LANES - 1;
        const hair = 1 + (profile[laneIndex] * waver - 1) * contrast;
        const value = amplitude * falloff * hair;
        const index = x + row;
        // Paper gate: valleys resist a light touch; deposits follow the tooth.
        const deposit = value - (1 - paper[index]) * PAPER_GATE;
        if (deposit <= 0) continue;
        // Saturating stroke accumulation: overlapping stamps within one stroke
        // converge toward full coverage instead of stacking darker.
        const before = strokeBuffer[index];
        const after = before * (1 - deposit) + deposit;
        const added = after - before;
        if (added <= 0.0005) continue;
        strokeBuffer[index] = after;
        const pigment = added * PIGMENT_PER_STAMP * stroke.pigmentScale * (0.1 + 0.9 * load);
        const existing = susDensity[index];
        const total = existing + pigment;
        susR[index] = (susR[index] * existing + color.r * pigment) / total;
        susG[index] = (susG[index] * existing + color.g * pigment) / total;
        susB[index] = (susB[index] * existing + color.b * pigment) / total;
        susDensity[index] = Math.min(DENSITY_MAX * 2, total);
        water[index] += added * wetnessNow * WATER_PER_STAMP;
        active[index] = 1;
      }
    }
    dirty = true;
    wetCells += 1;
  }

  // Dirty brush: the tip drifts toward the paint it just crossed, so dragging
  // through a wash carries that wash along the stroke.
  function pickupAt(gx, gy, color) {
    const index = (Math.round(gx) | 0) + (Math.round(gy) | 0) * stride;
    if (index < 0 || index >= cells) return color;
    const sus = susDensity[index] - strokeBuffer[index] * PIGMENT_PER_STAMP;
    const source = sus > 200 ? { r: susR[index], g: susG[index], b: susB[index], amount: 0.05 }
      : depDensity[index] > 200 ? { r: depR[index], g: depG[index], b: depB[index], amount: 0.03 }
        : null;
    if (!source) return color;
    return {
      r: color.r + (source.r - color.r) * source.amount,
      g: color.g + (source.g - color.g) * source.amount,
      b: color.b + (source.b - color.b) * source.amount,
    };
  }

  function beginStroke(colorHex, hardness, sizeCss, basePressure, water = DEFAULT_WATER, deplete = false, paint = 0.5) {
    const rgb = hexToRgb(colorHex);
    const clampedWater = Math.min(1, Math.max(0, water));
    const clampedPaint = Math.min(1, Math.max(0, paint));
    stroke = {
      color: { r: rgb.r, g: rgb.g, b: rgb.b },
      hardness,
      sizeCss,
      basePressure,
      // Water is the dial, hardness the brush character: H1 is a soaked soft
      // mop, H6 a firm nearly-dry brush. At the default water the product
      // reproduces the hardness-only wetness episodes were calibrated to.
      wetness: Math.max(0.1, 2 * clampedWater * (1.08 - hardness * 0.14)),
      // A watery load carries less pigment per stamp — runny washes go pale,
      // a thirsty brush lays dense color.
      pigmentScale: 1.25 - 0.5 * clampedWater,
      softness: 0.8 + hardness * 0.35,
      // Live strokes only: replayed episodes author their tapers with
      // per-point pressure instead, so they never deplete.
      deplete,
      // The paint dial is the dip: it alone sets how far a stroke travels
      // before the brush is empty — a fixed distance, and a true zero. A
      // default dip runs bone dry around 600 px; a heavy dip roughly doubles
      // that, a light one halves it. Water plays no part in duration — it
      // only dilutes and spreads what the dip carries.
      tank: (144 + 936 * clampedPaint) * Math.sqrt(sizeCss / 38) * scale,
      load: 1,
      profile: null,
      seedSalt: 0,
      dirX: 1,
      dirY: 0,
      arc: 0,
      points: [],
      leftover: 0,
      minX: gridWidth,
      maxX: 1,
      minY: gridHeight,
      maxY: 1,
    };
  }

  function strokeBoxGrow(gx, gy, radius) {
    const reach = Math.ceil(radius) + 1;
    if (gx - reach < stroke.minX) stroke.minX = Math.max(0, Math.floor(gx - reach));
    if (gx + reach > stroke.maxX) stroke.maxX = Math.min(gridWidth + 1, Math.ceil(gx + reach));
    if (gy - reach < stroke.minY) stroke.minY = Math.max(0, Math.floor(gy - reach));
    if (gy + reach > stroke.maxY) stroke.maxY = Math.min(gridHeight + 1, Math.ceil(gy + reach));
  }

  function stampAlong(from, to) {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const radiusMid = stampRadius(stroke.sizeCss, (from.p + to.p) / 2);
    const spacing = Math.max(1.5, radiusMid * 0.22);
    if (distance > 0.001) {
      // Smoothed heading: the bristle profile rides perpendicular to this,
      // so hairs bend with the stroke instead of snapping per event.
      const nx = (to.x - from.x) / distance;
      const ny = (to.y - from.y) / distance;
      const mixed = stroke.arc === 0 ? 1 : 0.35;
      const dx = stroke.dirX + (nx - stroke.dirX) * mixed;
      const dy = stroke.dirY + (ny - stroke.dirY) * mixed;
      const norm = Math.hypot(dx, dy) || 1;
      stroke.dirX = dx / norm;
      stroke.dirY = dy / norm;
      stroke.arc += distance;
      // Holds early, dries fast at the end, and genuinely empties: past the
      // tank distance the brush carries nothing and marks nothing.
      if (stroke.deplete) stroke.load = Math.pow(Math.max(0, 1 - stroke.arc / stroke.tank), 1.5);
    }
    // A drying brush splays less: the footprint narrows as it drains.
    const loadTaper = 0.75 + 0.25 * stroke.load;
    let travelled = stroke.leftover;
    if (distance === 0) {
      const radius = stampRadius(stroke.sizeCss, to.p) * loadTaper;
      stroke.color = pickupAt(to.x, to.y, stroke.color);
      strokeBoxGrow(to.x, to.y, radius);
      stamp(to.x, to.y, radius, to.p, stroke.softness, stroke.wetness, stroke.color);
      return;
    }
    while (travelled <= distance) {
      const t = travelled / distance;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      const pressure = from.p + (to.p - from.p) * t;
      const radius = stampRadius(stroke.sizeCss, pressure) * loadTaper;
      stroke.color = pickupAt(x, y, stroke.color);
      strokeBoxGrow(x, y, radius);
      stamp(x, y, radius, pressure, stroke.softness, stroke.wetness, stroke.color);
      travelled += spacing;
    }
    stroke.leftover = travelled - distance;
  }

  // Catmull-Rom through the recorded points, flattened to short segments and
  // stamped at fixed arc-length spacing — stroke shape is independent of
  // pointer event rate.
  function emitCurve(p0, p1, p2, p3) {
    const steps = Math.max(1, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / 3));
    let previous = p1;
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const point = {
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
        p: p1.p + (p2.p - p1.p) * t,
      };
      stampAlong(previous, point);
      previous = point;
    }
  }

  function addStrokePoint(cssX, cssY, pressure) {
    if (!stroke) return;
    const point = { x: cssX * scale + 1, y: cssY * scale + 1, p: pressure ?? stroke.basePressure };
    const points = stroke.points;
    if (!stroke.profile) {
      // Hair layout is seeded from where the stroke lands, so the reference
      // replayer grows the same hairs every render.
      stroke.profile = buildBristleProfile(point.x, point.y);
      stroke.seedSalt = 7300 + ((point.x * 31 + point.y * 17) | 0) % 997;
    }
    points.push(point);
    if (points.length === 1) {
      stampAlong(point, point);
      return;
    }
    if (points.length === 2) return;
    const count = points.length;
    const p0 = points[Math.max(0, count - 4)];
    emitCurve(p0, points[count - 3], points[count - 2], points[count - 1]);
    if (points.length > 8) points.splice(0, points.length - 4);
  }

  function endStroke() {
    if (!stroke) return;
    const points = stroke.points;
    if (points.length >= 2) {
      const last = points[points.length - 1];
      emitCurve(points[Math.max(0, points.length - 3)], points[points.length - 2], last, last);
    }
    // The stroke's saturation buffer only means something within one stroke;
    // scrub it so the next stroke glazes over this one instead of merging.
    for (let y = stroke.minY; y <= stroke.maxY; y += 1) {
      const row = y * stride;
      strokeBuffer.fill(0, stroke.minX + row, stroke.maxX + row + 1);
    }
    stroke = null;
  }

  function strokeFromPath(points, colorHex, hardness, sizeCss, basePressure, water = DEFAULT_WATER) {
    if (!Array.isArray(points) || points.length === 0) return;
    beginStroke(colorHex, hardness, sizeCss, basePressure, water);
    for (const point of points) addStrokePoint(point.x, point.y, point.p);
    endStroke();
  }

  // --- Simulation passes ----------------------------------------------------

  function velocityUpdate() {
    maxSpeed = 0;
    for (let y = boxTop; y <= boxBottom; y += 1) {
      const row = y * stride;
      for (let x = boxLeft; x <= boxRight; x += 1) {
        const index = x + row;
        if (active[index] === 0) continue;
        let vx = velX[index];
        let vy = velY[index];
        const left = index - 1;
        const right = index + 1;
        const up = index - stride;
        const down = index + stride;
        // Water piles push outward; paint runs downhill into paper valleys.
        const pushX = (water[left] - water[right]) * PRESSURE_FLOW;
        const pushY = (water[up] - water[down]) * PRESSURE_FLOW;
        vx += Math.min(ACCEL_CLAMP, Math.max(-ACCEL_CLAMP, pushX));
        vy += Math.min(ACCEL_CLAMP, Math.max(-ACCEL_CLAMP, pushY));
        if (susDensity[index] + depDensity[index] < HEAVY_PIGMENT) {
          vx += (paper[left] - paper[right]) * PAPER_FLOW;
          vy += (paper[up] - paper[down]) * PAPER_FLOW;
        }
        if (water[index] > SMOOTH_WATER_MIN) {
          vx = vx * 0.2 + (velX[left] + velX[right] + velX[up] + velX[down]) * 0.2;
          vy = vy * 0.2 + (velY[left] + velY[right] + velY[up] + velY[down]) * 0.2;
        }
        if (water[index] > 3) wetMemory[index] = 1;
        // Flow dies where the paper downstream is dry, but keeps momentum
        // through recently-wet cells — washes creep outward, never squirt.
        const speed = Math.sqrt(vx * vx + vy * vy) + 0.01;
        const lookahead = 4 / speed;
        const aheadX = x + ((vx * lookahead) | 0);
        const aheadY = y + ((vy * lookahead) | 0);
        if (aheadX >= 0 && aheadX <= gridWidth + 1 && aheadY >= 0 && aheadY <= gridHeight + 1) {
          const ahead = aheadX + aheadY * stride;
          const wetness = Math.min(1, Math.max(0.05, water[ahead] + wetMemory[ahead] * 3 - 1.5));
          vx *= wetness;
          vy *= wetness;
        }
        if (vx > maxSpeed) maxSpeed = vx;
        else if (-vx > maxSpeed) maxSpeed = -vx;
        if (vy > maxSpeed) maxSpeed = vy;
        else if (-vy > maxSpeed) maxSpeed = -vy;
        tmpX[index] = Math.min(VELOCITY_CLAMP, Math.max(-VELOCITY_CLAMP, vx));
        tmpY[index] = Math.min(VELOCITY_CLAMP, Math.max(-VELOCITY_CLAMP, vy));
      }
    }
  }

  function velocitySmooth() {
    for (let y = boxTop; y <= boxBottom; y += 1) {
      const row = y * stride;
      for (let x = boxLeft; x <= boxRight; x += 1) {
        const index = x + row;
        if (active[index] === 0) continue;
        if (water[index] > 0.05) {
          tmpX[index] = velX[index] * 0.2 + (velX[index - 1] + velX[index + 1] + velX[index - stride] + velX[index + stride]) * 0.2;
          tmpY[index] = velY[index] * 0.2 + (velY[index - 1] + velY[index + 1] + velY[index - stride] + velY[index + stride]) * 0.2;
        } else {
          tmpX[index] = velX[index];
          tmpY[index] = velY[index];
        }
      }
    }
  }

  // Semi-Lagrangian advection: each cell pulls from where its flow came from,
  // subtracting what it takes so water and pigment are conserved. In-place and
  // order-dependent like the original — deterministic is what matters.
  function advect() {
    for (let y = boxTop; y <= boxBottom; y += 1) {
      const row = y * stride;
      for (let x = boxLeft; x <= boxRight; x += 1) {
        const index = x + row;
        if (active[index] === 0) continue;
        const sourceX = x - tmpX[index];
        const sourceY = y - tmpY[index] - GRAVITY_Y * water[index];
        if (sourceX < 1 || sourceX > gridWidth - 1 || sourceY < 1 || sourceY > gridHeight - 1) {
          velX[index] = 0;
          velY[index] = 0;
          continue;
        }
        const x0 = sourceX | 0;
        const y0 = sourceY | 0;
        const fx = sourceX - x0;
        const fy = sourceY - y0;
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;
        const i00 = x0 + y0 * stride;
        const i10 = i00 + 1;
        const i01 = i00 + stride;
        const i11 = i01 + 1;
        velX[index] = w00 * tmpX[i00] + w10 * tmpX[i10] + w01 * tmpX[i01] + w11 * tmpX[i11];
        velY[index] = w00 * tmpY[i00] + w10 * tmpY[i10] + w01 * tmpY[i01] + w11 * tmpY[i11];
        if (index === i00) continue;
        let take00 = susDensity[i00] * w00;
        let take10 = susDensity[i10] * w10;
        let take01 = susDensity[i01] * w01;
        let take11 = susDensity[i11] * w11;
        const taken = take00 + take10 + take01 + take11;
        if (taken > 0.001) {
          const r = take00 * susR[i00] + take10 * susR[i10] + take01 * susR[i01] + take11 * susR[i11];
          const g = take00 * susG[i00] + take10 * susG[i10] + take01 * susG[i01] + take11 * susG[i11];
          const b = take00 * susB[i00] + take10 * susB[i10] + take01 * susB[i01] + take11 * susB[i11];
          susDensity[i00] -= take00;
          susDensity[i10] -= take10;
          susDensity[i01] -= take01;
          susDensity[i11] -= take11;
          const previous = susDensity[index];
          const total = previous + taken;
          susR[index] = (susR[index] * previous + r) / total;
          susG[index] = (susG[index] * previous + g) / total;
          susB[index] = (susB[index] * previous + b) / total;
          susDensity[index] = total;
        }
        const water00 = water[i00] * w00;
        const water10 = water[i10] * w10;
        const water01 = water[i01] * w01;
        const water11 = water[i11] * w11;
        const waterTaken = water00 + water10 + water01 + water11;
        if (waterTaken > 0.0001) {
          water[i00] -= water00;
          water[i10] -= water10;
          water[i01] -= water01;
          water[i11] -= water11;
          water[index] += waterTaken;
        }
      }
    }
  }

  function project() {
    for (let y = boxTop; y <= boxBottom; y += 1) {
      const row = y * stride;
      for (let x = boxLeft; x <= boxRight; x += 1) {
        const index = x + row;
        if (active[index] === 0) continue;
        tmpY[index] = velX[index - 1] - velX[index + 1] + velY[index - stride] - velY[index + stride];
      }
    }
    for (let y = boxTop; y <= boxBottom; y += 1) {
      const row = y * stride;
      for (let x = boxLeft; x <= boxRight; x += 1) {
        const index = x + row;
        if (active[index] === 0) continue;
        tmpX[index] = (tmpY[index] + (tmpY[index - 1] + tmpY[index + 1] + tmpY[index - stride] + tmpY[index + stride]) * 0.25) * 0.25;
      }
    }
    for (let y = boxTop; y <= boxBottom; y += 1) {
      const row = y * stride;
      for (let x = boxLeft; x <= boxRight; x += 1) {
        const index = x + row;
        if (active[index] === 0) continue;
        velX[index] -= 0.5 * (tmpX[index + 1] - tmpX[index - 1]) * PROJECT_STRENGTH;
        velY[index] -= 0.5 * (tmpX[index + stride] - tmpX[index - stride]) * PROJECT_STRENGTH;
      }
    }
  }

  function settlePigment(index, lostFraction) {
    const moved = susDensity[index] * lostFraction;
    if (moved <= 0) return;
    const depositedCov = coverage(depDensity[index]);
    const movedCov = coverage(moved);
    if (depositedCov > 0) {
      const keep = depositedCov * (1 - movedCov);
      const norm = 1 / (keep + movedCov);
      depR[index] = (keep * depR[index] + susR[index] * movedCov) * norm;
      depG[index] = (keep * depG[index] + susG[index] * movedCov) * norm;
      depB[index] = (keep * depB[index] + susB[index] * movedCov) * norm;
    } else {
      depR[index] = susR[index];
      depG[index] = susG[index];
      depB[index] = susB[index];
    }
    depDensity[index] = Math.min(DENSITY_MAX * 2, depDensity[index] + moved);
    susDensity[index] -= moved;
    if (susDensity[index] < 0.5) susDensity[index] = 0;
  }

  function evaporateAndSettle() {
    wetCells = 0;
    for (let y = boxTop; y <= boxBottom; y += 1) {
      const row = y * stride;
      for (let x = boxLeft; x <= boxRight; x += 1) {
        const index = x + row;
        if (active[index] === 0) continue;
        const amount = water[index];
        if (amount > 0) {
          // The heart of the look: wash boundaries dry far faster than
          // interiors, so water flows outward carrying pigment that settles
          // at the edge — blooms and dark rims emerge, nothing draws them.
          let wetNeighbors = 0;
          if (susDensity[index - 1] > WET_NEIGHBOR_DENSITY || water[index - 1] > 0.1) wetNeighbors += 1;
          if (susDensity[index + 1] > WET_NEIGHBOR_DENSITY || water[index + 1] > 0.1) wetNeighbors += 1;
          if (susDensity[index - stride] > WET_NEIGHBOR_DENSITY || water[index - stride] > 0.1) wetNeighbors += 1;
          if (susDensity[index + stride] > WET_NEIGHBOR_DENSITY || water[index + stride] > 0.1) wetNeighbors += 1;
          const edge = 1 - wetNeighbors / 4;
          let remaining = amount * EVAP_KEEP - EVAP_LINEAR * (edge * EVAP_EDGE_BOOST + EVAP_FLOOR);
          if (remaining < 0.001) remaining = 0;
          const lostFraction = amount > 0 ? Math.min(1, Math.max(0, 1 - remaining / amount)) : 0;
          water[index] = remaining;
          if (lostFraction > 0 && susDensity[index] > 0) settlePigment(index, lostFraction);
          if (remaining > 0) wetCells += 1;
        }
        // Fresh water over dried paint lifts it back into suspension —
        // glazing softens, deliberate scrubbing re-wets.
        if (water[index] > 0 && depDensity[index] > 0) {
          const excess = water[index] - coverage(susDensity[index]);
          if (excess > 0) {
            const rate = Math.min(1, REDISSOLVE_RATE * (1 + excess * REDISSOLVE_WATER_GAIN));
            const lifted = depDensity[index] * rate;
            const liftedCov = coverage(lifted) ;
            const susCov = coverage(susDensity[index]);
            if (susCov > 0) {
              const keep = susCov * (1 - liftedCov);
              const norm = 1 / (keep + liftedCov);
              susR[index] = (susR[index] * keep + depR[index] * liftedCov) * norm;
              susG[index] = (susG[index] * keep + depG[index] * liftedCov) * norm;
              susB[index] = (susB[index] * keep + depB[index] * liftedCov) * norm;
            } else {
              susR[index] = depR[index];
              susG[index] = depG[index];
              susB[index] = depB[index];
            }
            susDensity[index] += lifted;
            depDensity[index] -= lifted;
          }
        }
      }
    }
  }

  // Rebuild the activity mask and shrink the bounding box to what is still
  // wet, so an idle painting costs nothing.
  function updateMask() {
    let left = gridWidth;
    let right = 1;
    let top = gridHeight;
    let bottom = 1;
    const scanLeft = Math.max(1, boxLeft - 2);
    const scanRight = Math.min(gridWidth, boxRight + 2);
    const scanTop = Math.max(1, boxTop - 2);
    const scanBottom = Math.min(gridHeight, boxBottom + 2);
    for (let y = scanTop; y <= scanBottom; y += 1) {
      const row = y * stride;
      for (let x = scanLeft; x <= scanRight; x += 1) {
        active[x + row] = 0;
      }
    }
    let wet = 0;
    for (let y = scanTop; y <= scanBottom; y += 1) {
      const row = y * stride;
      for (let x = scanLeft; x <= scanRight; x += 1) {
        const index = x + row;
        if (water[index] > 0.001 || susDensity[index] > 0.5) {
          wet += 1;
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
      }
    }
    wetCells = wet;
    if (wet === 0) {
      resetBox();
      return;
    }
    boxLeft = Math.max(1, left - 4);
    boxRight = Math.min(gridWidth, right + 4);
    boxTop = Math.max(1, top - 4);
    boxBottom = Math.min(gridHeight, bottom + 4);
    for (let y = boxTop; y <= boxBottom; y += 1) {
      const row = y * stride;
      for (let x = boxLeft; x <= boxRight; x += 1) {
        const index = x + row;
        if (water[index] > 0.001 || susDensity[index] > 0.5) {
          active[index - 1] = 1;
          active[index] = 1;
          active[index + 1] = 1;
          active[index - stride] = 1;
          active[index + stride] = 1;
        }
      }
    }
  }

  function tick(count = 1) {
    const started = performance.now();
    for (let step = 0; step < count; step += 1) {
      if (!hasBox()) break;
      tickCount += 1;
      if (tickCount % 8 === 0) updateMask();
      if (!hasBox()) break;
      // Lively water dries on the fast cadence; a calm settling wash dries
      // slowly, giving pigment time to drift to the edges before it fixes.
      const evapEvery = maxSpeed < 0.5 ? 6 : 3;
      if (tickCount % evapEvery === 0) evaporateAndSettle();
      if (tickCount % 4 === 0) velocityUpdate();
      else velocitySmooth();
      advect();
      if (tickCount % 3 === 1) project();
      dirty = true;
    }
    lastTickMs = performance.now() - started;
  }

  function isActive() {
    return hasBox() && (wetCells > 0 || stroke !== null);
  }

  // --- Rendering ------------------------------------------------------------

  function renderRegion(left, right, top, bottom) {
    const data = frame.data;
    for (let y = top; y <= bottom; y += 1) {
      const row = y * stride;
      for (let x = left; x <= right; x += 1) {
        const index = x + row;
        const height = paper[index];
        const totalHere = susDensity[index] + depDensity[index];
        // Paper shading: grain shows through washes; relief lighting gives
        // strokes a faint dimensionality that fades under heavy pigment.
        let pigmentShade = height * 100 - 40;
        const totalRight = susDensity[index + 1] + depDensity[index + 1];
        const totalLeft = susDensity[index - 1] + depDensity[index - 1];
        const totalDown = susDensity[index + stride] + depDensity[index + stride];
        const totalUp = susDensity[index - stride] + depDensity[index - stride];
        let relief = ((totalRight - totalLeft) * 0.5 + (totalDown - totalUp)) * RELIEF_GAIN;
        relief = Math.min(RELIEF_CLAMP, Math.max(-RELIEF_CLAMP, relief));
        if (totalHere > RELIEF_FADE_START) {
          const fade = Math.min(1, (totalHere - RELIEF_FADE_START) / 2000);
          pigmentShade *= 1 - fade;
        }
        pigmentShade += relief;
        const paperShade = height * 30 - 30;
        let red = 255 + paperShade;
        let green = 255 + paperShade;
        let blue = 255 + paperShade;
        let opacity = 1;
        const deposited = depDensity[index];
        if (deposited > 0) {
          const cov = coverage(deposited);
          const keep = opacity * (1 - cov);
          opacity = keep + cov;
          const norm = 1 / opacity;
          red = (red * keep + (depR[index] + pigmentShade) * cov) * norm;
          green = (green * keep + (depG[index] + pigmentShade) * cov) * norm;
          blue = (blue * keep + (depB[index] + pigmentShade) * cov) * norm;
        }
        const suspended = susDensity[index];
        if (suspended > 0) {
          const cov = coverage(suspended);
          const keep = opacity * (1 - cov);
          opacity = keep + cov;
          const norm = 1 / opacity;
          red = (red * keep + (susR[index] + pigmentShade) * cov) * norm;
          green = (green * keep + (susG[index] + pigmentShade) * cov) * norm;
          blue = (blue * keep + (susB[index] + pigmentShade) * cov) * norm;
        }
        const offset = ((x - 1) + (y - 1) * gridWidth) * 4;
        data[offset] = red < 0 ? 0 : red > 255 ? 255 : red;
        data[offset + 1] = green < 0 ? 0 : green > 255 ? 255 : green;
        data[offset + 2] = blue < 0 ? 0 : blue > 255 ? 255 : blue;
        data[offset + 3] = 255;
      }
    }
  }

  function render(full = false) {
    if (!dirty && !full) return;
    let left = 1;
    let right = gridWidth;
    let top = 1;
    let bottom = gridHeight;
    if (!full && hasBox()) {
      left = boxLeft;
      right = boxRight;
      top = boxTop;
      bottom = boxBottom;
    }
    renderRegion(left, right, top, bottom);
    offscreenContext.putImageData(frame, 0, 0, left - 1, top - 1, right - left + 1, bottom - top + 1);
    const { context } = surface;
    context.save();
    const dpr = surface.dpr();
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.imageSmoothingEnabled = true;
    context.drawImage(offscreen, 0, 0, cssWidth, cssHeight);
    context.restore();
    dirty = false;
  }

  // --- Lifecycle ------------------------------------------------------------

  function reset() {
    water.fill(0);
    susDensity.fill(0);
    depDensity.fill(0);
    velX.fill(0);
    velY.fill(0);
    tmpX.fill(0);
    tmpY.fill(0);
    active.fill(0);
    strokeBuffer.fill(0);
    wetMemory.fill(0);
    stroke = null;
    wetCells = 0;
    resetBox();
    dirty = true;
    render(true);
  }

  // Everything wet settles instantly: suspended pigment becomes deposited,
  // water and motion are gone. The canonical between-steps state for replay.
  function dryAll() {
    for (let index = 0; index < cells; index += 1) {
      if (susDensity[index] > 0) settlePigment(index, 1);
      water[index] = 0;
      velX[index] = 0;
      velY[index] = 0;
    }
    active.fill(0);
    wetMemory.fill(0);
    wetCells = 0;
    resetBox();
    dirty = true;
  }

  // Rebuild deposited pigment from whatever the canvas shows: undo, slot
  // loads, and resizes restore a dried painting. The estimate un-blends each
  // pixel from the shaded paper it sits on, so bare grain does not read as
  // pigment and washes keep their color.
  function rehydrateFromCanvas() {
    water.fill(0);
    susDensity.fill(0);
    depDensity.fill(0);
    velX.fill(0);
    velY.fill(0);
    active.fill(0);
    strokeBuffer.fill(0);
    wetMemory.fill(0);
    stroke = null;
    wetCells = 0;
    resetBox();
    offscreenContext.save();
    offscreenContext.fillStyle = '#fff';
    offscreenContext.fillRect(0, 0, gridWidth, gridHeight);
    offscreenContext.drawImage(surface.canvas, 0, 0, gridWidth, gridHeight);
    offscreenContext.restore();
    const pixels = offscreenContext.getImageData(0, 0, gridWidth, gridHeight).data;
    for (let y = 1; y <= gridHeight; y += 1) {
      const row = y * stride;
      for (let x = 1; x <= gridWidth; x += 1) {
        const offset = ((x - 1) + (y - 1) * gridWidth) * 4;
        const index = x + row;
        const bare = 255 + paper[index] * 30 - 30;
        const ratio = Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) / bare;
        const cov = Math.min(0.98, Math.max(0, 1 - ratio));
        if (cov < 0.03) continue;
        const shade = paper[index] * 100 - 40;
        const keep = 1 - cov;
        depR[index] = Math.min(255, Math.max(0, (pixels[offset] - bare * keep) / cov - shade));
        depG[index] = Math.min(255, Math.max(0, (pixels[offset + 1] - bare * keep) / cov - shade));
        depB[index] = Math.min(255, Math.max(0, (pixels[offset + 2] - bare * keep) / cov - shade));
        depDensity[index] = densityFromCoverage(cov);
      }
    }
    dirty = true;
  }

  return {
    cssWidth,
    cssHeight,
    gridWidth,
    gridHeight,
    scale,
    beginStroke,
    addStrokePoint,
    endStroke,
    strokeFromPath,
    tick,
    render,
    isActive,
    reset,
    dryAll,
    rehydrateFromCanvas,
    stats() {
      return {
        tick: tickCount,
        wetCells,
        activeBox: hasBox() ? { left: boxLeft, right: boxRight, top: boxTop, bottom: boxBottom } : null,
        lastTickMs,
        grid: { width: gridWidth, height: gridHeight },
      };
    },
  };
}
