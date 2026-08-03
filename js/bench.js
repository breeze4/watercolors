// Deterministic performance benchmark for the paint engine.
//
// The debug panel is a diagnostic: it watches whatever the user happens to do.
// This is a judge: it runs a fixed, seeded workload so two builds can be
// compared. The difference matters because both audits on 2026-08-02 found the
// panel's own numbers unfit for that job — a scripted stroke and a hand stroke
// disagree 29x on per-stroke cost, and the brush dials that move sustained cost
// 1.5-2.4x were not recorded at all.
//
// Two modes, deliberately not interchangeable:
//
//   engine       Fixed tick counts, no requestAnimationFrame, no wall-clock
//                coupling. Engine state evolves identically on every run, so
//                the only thing that varies between repetitions is how long the
//                machine took. This is the regression gate.
//
//   interaction  Paced pointer events through the real input handlers with rAF
//                driving the simulation. Higher variance, but it is the only
//                mode that measures what a person actually experiences —
//                depletion, velocity-adjusted pressure, undo snapshots, and
//                simulation running *during* a stroke.
//
// A run carries its own correctness fingerprint. Without one, every finding is
// gameable: dropping simulation steps, drying early, skipping regions, or
// rendering less all make the numbers better and the paint worse.

import { engineFor, getDebugTiming, setDebugTiming } from './fluid.js';
import { paintStrokePath, sizePixels } from './brush.js';

export const BENCH_VERSION = 1;

const PASS_KEYS = ['mask', 'evap', 'velocity', 'advect', 'project'];
// Past this the settle loop gives up and says so, rather than hanging a run.
const SETTLE_TICK_CAP = 4000;
// Pointer moves per second in interaction mode. Real pointers deliver 60-120/s;
// the low end is the honest floor and keeps the trace reproducible on slow
// machines that cannot service more.
const POINTER_HZ = 60;

// mulberry32: small, fast, and identical across engines — the trace must be a
// pure function of the seed or "same workload" is a claim rather than a fact.
function makeRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a over whatever we are fingerprinting. Not cryptographic — it only has
// to make an unintended change in the output visible.
function hashBytes(view, stride = 1) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < view.length; index += stride) {
    hash ^= view[index] & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function hashFloats(array, quantum, stride) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < array.length; index += stride) {
    // Quantized on purpose: float noise in the last bits is not a behavior
    // change, and a fingerprint that trips on it would cry wolf every run.
    const value = Math.round(array[index] / quantum) | 0;
    hash ^= value & 0xffff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function quantiles(values) {
  if (values.length === 0) return { count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const mean = total / sorted.length;
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length;
  const stdDev = Math.sqrt(variance);
  return {
    count: sorted.length,
    total: +total.toFixed(3),
    mean: +mean.toFixed(4),
    median: +at(0.5).toFixed(4),
    p90: +at(0.9).toFixed(4),
    p95: +at(0.95).toFixed(4),
    p99: +at(0.99).toFixed(4),
    min: +sorted[0].toFixed(4),
    max: +sorted[sorted.length - 1].toFixed(4),
    stdDev: +stdDev.toFixed(4),
    // Coefficient of variation is the variance gate's input: a mean with no
    // dispersion beside it cannot say whether a 4% delta is signal.
    cv: mean > 0 ? +(stdDev / mean).toFixed(4) : 0,
  };
}

// Built-in profiles. These are the workload identity — changing one changes
// what every stored run means, so bump `version` when you do.
export const PROFILES = {
  'engine-default': {
    id: 'engine-default',
    version: 1,
    mode: 'engine',
    label: 'Engine, default dials',
    seed: 20260802,
    strokes: 40,
    ticksPerStroke: 12,
    settle: true,
    dials: { size: 'm', hardness: 3, pressure: 0.5, water: 0.5, paint: 0.5 },
  },
  'engine-wet': {
    id: 'engine-wet',
    version: 1,
    mode: 'engine',
    label: 'Engine, soaked brush (worst sustained case)',
    seed: 20260802,
    strokes: 40,
    ticksPerStroke: 12,
    settle: true,
    dials: { size: 'l', hardness: 1, pressure: 1, water: 1, paint: 1 },
  },
  'engine-dry': {
    id: 'engine-dry',
    version: 1,
    mode: 'engine',
    label: 'Engine, thirsty brush (cheapest case)',
    seed: 20260802,
    strokes: 40,
    ticksPerStroke: 12,
    settle: true,
    dials: { size: 's', hardness: 6, pressure: 0.2, water: 0, paint: 0 },
  },
  'engine-sparse': {
    id: 'engine-sparse',
    version: 1,
    mode: 'engine',
    label: 'Engine, corner strokes (box-versus-wet over-iteration)',
    seed: 4242,
    strokes: 8,
    ticksPerStroke: 40,
    settle: true,
    // The shape the whole slice-2 argument rests on: a little wet paint spread
    // far apart, so the bounding box is enormous and nearly all of it is dry.
    placement: 'corners',
    dials: { size: 'm', hardness: 3, pressure: 0.5, water: 1, paint: 0.5 },
  },
  'interaction-default': {
    id: 'interaction-default',
    version: 1,
    mode: 'interaction',
    label: 'Interaction, paced pointer at 1 stroke/sec',
    seed: 20260802,
    strokes: 12,
    // 1/sec: at this rate the box-versus-wet gap is visible. At 4+/sec the
    // canvas floods, box hits 100%, and the distinction disappears.
    rateHz: 1,
    strokeMs: 600,
    settle: true,
    dials: { size: 'm', hardness: 3, pressure: 0.5, water: 0.5, paint: 0.5 },
  },
};

export function listProfiles() {
  return Object.values(PROFILES).map((profile) => ({
    id: profile.id,
    mode: profile.mode,
    label: profile.label,
    version: profile.version,
    strokes: profile.strokes,
  }));
}

// Shared by the browser judge and the Node-only core profiler. Keeping trace
// generation pure means both tools can exercise identical geometry without a
// browser, a recorded pointer file, or a second workload implementation.
export function buildBenchTrace(profile, width, height) {
  const random = makeRandom(profile.seed);
  const strokes = [];
  for (let index = 0; index < profile.strokes; index += 1) {
    let cx;
    let cy;
    if (profile.placement === 'corners') {
      const corner = index % 4;
      cx = (corner === 0 || corner === 3 ? 0.12 : 0.88) * width;
      cy = (corner === 0 || corner === 1 ? 0.12 : 0.88) * height;
    } else {
      const margin = 20;
      cx = margin + random() * Math.max(40, width - margin * 2);
      cy = margin + random() * Math.max(40, height - margin * 2);
    }
    const angle = random() * Math.PI * 2;
    const length = 70 + random() * 150;
    const wobble = 8 + random() * 14;
    const segments = 12;
    const originX = cx - Math.cos(angle) * (length / 2);
    const originY = cy - Math.sin(angle) * (length / 2);
    const jitter = 0.78 + random() * 0.44;
    const points = [];
    for (let seg = 0; seg <= segments; seg += 1) {
      const along = (seg / segments) * length;
      points.push({
        x: originX + Math.cos(angle) * along + Math.cos(angle + Math.PI / 2) * Math.sin(seg / 2) * wobble,
        y: originY + Math.sin(angle) * along + Math.sin(angle + Math.PI / 2) * Math.sin(seg / 2) * wobble,
        jitter,
      });
    }
    strokes.push({ points, lengthHint: length });
  }
  return strokes;
}

export function createBench({ getSurface, getCanvas, setDials, readDials, resetCanvas, getUndoInfo }) {
  let running = false;

  const sleep = (ms) => new Promise((resolve) => { window.setTimeout(resolve, ms); });
  const nextFrame = () => new Promise((resolve) => { window.requestAnimationFrame(resolve); });

  function passDelta(previous, current) {
    const delta = {};
    for (const key of PASS_KEYS) delta[key] = +Math.max(0, (current[key] || 0) - (previous[key] || 0)).toFixed(4);
    return delta;
  }

  // Everything an optimization is not allowed to change. Read after the canvas
  // is forced dry so the comparison is against a settled sheet, not a moving one.
  function fingerprint(engine, canvas) {
    engine.dryAll();
    engine.render(true);
    const state = engine.exportState();
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    return {
      // Sampled every 17th byte: dense enough to catch a region that stopped
      // rendering, cheap enough not to dominate the run on a big canvas.
      image: hashBytes(pixels, 17),
      // Deposited pigment is the painting. Quantized to 1 density unit out of
      // a 3000-unit scale.
      deposited: hashFloats(state.depDensity, 1, 7),
      grid: { width: state.gridWidth, height: state.gridHeight },
      pixelBytes: pixels.length,
    };
  }

  async function quiesce(engine) {
    for (let guard = 0; guard < 600 && engine.isActive(); guard += 1) await sleep(25);
  }

// The render ablation ladder.
//
//   0  simulate only, render() never called
//   1  + shade pixels into the ImageData
//   2  + upload the dirty rect to the offscreen canvas
//   3  + composite to the visible canvas — production
//
// Each stage's cost is the difference between two adjacent whole-run totals.
// Timing them individually does not work on the devices that matter: their
// clocks are clamped, and drawImage into a GPU-backed canvas largely enqueues
// work rather than doing it, so a per-frame timer captures the enqueue.
//
// The levels are produced by suppressing the two canvas calls the engine's
// render target makes, for the duration of the render call only. No production
// engine code changes, and nothing that writes simulation state is touched —
// shading, upload and composite are all pure output, which is why the deposited
// pigment fingerprint must come out identical at every level.
const RENDER_LEVEL_PRODUCTION = 3;

function renderAtLevel(engine, level, flush, surface) {
  if (level <= 0) return;
  if (level >= RENDER_LEVEL_PRODUCTION && !flush) { engine.render(); return; }

  const proto = CanvasRenderingContext2D.prototype;
  const realPut = proto.putImageData;
  const realDraw = proto.drawImage;
  if (level < 3) proto.drawImage = function suppressed() {};
  if (level < 2) proto.putImageData = function suppressed() {};
  try {
    engine.render();
  } finally {
    proto.putImageData = realPut;
    proto.drawImage = realDraw;
  }

  // A synchronous read forces the browser to finish what drawImage queued.
  // Without it the timer stops at the enqueue and the composite looks free.
  if (flush && surface && surface.context) surface.context.getImageData(0, 0, 1, 1);
}

  async function runEngineMode(profile, canvas, surface) {
    const width = canvas.getBoundingClientRect().width;
    const height = canvas.getBoundingClientRect().height;
    const trace = buildBenchTrace(profile, width, height);
    const engine = engineFor(surface);
    const dials = readDials();
    const brush = { deplete: true, paint: dials.paint };
    const frames = [];
    const strokes = [];
    const curve = [];
    let previousPasses = { ...engine.stats().passes };
    let tickIndex = 0;

    for (let index = 0; index < trace.length; index += 1) {
      const entry = trace[index];
      const points = entry.points.map((point) => ({
        x: point.x,
        y: point.y,
        p: Math.min(1, Math.max(0.15, dials.pressureEffective * point.jitter)),
      }));
      const depositStarted = performance.now();
      paintStrokePath(surface, points, dials.color, dials.hardness, sizePixels[dials.size], dials.pressureEffective, dials.waterEffective, brush);
      const depositMs = performance.now() - depositStarted;
      const engineStroke = engine.lastStroke();

      let strokeTickMs = 0;
      let strokeRenderMs = 0;
      const renderLevel = Number.isInteger(profile.renderLevel) ? profile.renderLevel : RENDER_LEVEL_PRODUCTION;
      const flush = Boolean(profile.flush);
      for (let step = 0; step < profile.ticksPerStroke; step += 1) {
        const tickStarted = performance.now();
        engine.tick(2);
        const renderStarted = performance.now();
        renderAtLevel(engine, renderLevel, flush, surface);
        const finished = performance.now();
        const stats = engine.stats();
        const boxCells = stats.activeBox
          ? (stats.activeBox.right - stats.activeBox.left + 1) * (stats.activeBox.bottom - stats.activeBox.top + 1)
          : 0;
        const passes = passDelta(previousPasses, stats.passes);
        previousPasses = { ...stats.passes };
        const tickMs = renderStarted - tickStarted;
        const renderMs = finished - renderStarted;
        strokeTickMs += tickMs;
        strokeRenderMs += renderMs;
        frames.push({
          i: tickIndex,
          stroke: index + 1,
          phase: 'stroke',
          tickMs: +tickMs.toFixed(4),
          renderMs: +renderMs.toFixed(4),
          frameMs: +(tickMs + renderMs).toFixed(4),
          wetCells: stats.wetCells,
          boxCells,
          ...passes,
        });
        curve.push({ t: tickIndex, wet: stats.wetCells, box: boxCells });
        tickIndex += 1;
      }
      strokes.push({
        n: index + 1,
        inputPath: 'scripted',
        lengthCss: engineStroke ? +engineStroke.lengthCss.toFixed(2) : 0,
        stamps: engineStroke ? engineStroke.stamps : 0,
        depositMs: +depositMs.toFixed(4),
        simMs: +(strokeTickMs + strokeRenderMs).toFixed(4),
        // Only meaningful against other scripted strokes — the whole point of
        // carrying `inputPath`.
        msPer100: engineStroke && engineStroke.lengthCss > 0
          ? +(((depositMs + strokeTickMs + strokeRenderMs) / engineStroke.lengthCss) * 100).toFixed(4)
          : 0,
      });
    }

    let settleTicks = 0;
    let settleComplete = true;
    if (profile.settle) {
      while (engine.isActive()) {
        if (settleTicks >= SETTLE_TICK_CAP) {
          settleComplete = false;
          break;
        }
        const tickStarted = performance.now();
        engine.tick(2);
        const renderStarted = performance.now();
        engine.render();
        const finished = performance.now();
        const stats = engine.stats();
        const boxCells = stats.activeBox
          ? (stats.activeBox.right - stats.activeBox.left + 1) * (stats.activeBox.bottom - stats.activeBox.top + 1)
          : 0;
        const passes = passDelta(previousPasses, stats.passes);
        previousPasses = { ...stats.passes };
        frames.push({
          i: tickIndex,
          stroke: null,
          phase: 'settle',
          tickMs: +(renderStarted - tickStarted).toFixed(4),
          renderMs: +(finished - renderStarted).toFixed(4),
          frameMs: +(finished - tickStarted).toFixed(4),
          wetCells: stats.wetCells,
          boxCells,
          ...passes,
        });
        curve.push({ t: tickIndex, wet: stats.wetCells, box: boxCells });
        tickIndex += 1;
        settleTicks += 1;
      }
    }

    return { frames, strokes, curve, settleTicks, settleComplete, engineTicks: engine.stats().tick };
  }

  async function runInteractionMode(profile, canvas, surface) {
    const box = () => canvas.getBoundingClientRect();
    const bounds = box();
    const trace = buildBenchTrace(profile, bounds.width, bounds.height);
    const engine = engineFor(surface);
    const dials = readDials();
    const strokes = [];
    const curve = [];
    let pointerId = 9000;
    const frameLog = [];

    // rAF frames are sampled by a shadow loop rather than by hooking the
    // studio's ticker: the benchmark must not change the code path it measures.
    let watching = true;
    let lastFrameAt = performance.now();
    const watch = () => {
      if (!watching) return;
      const now = performance.now();
      const stats = engine.stats();
      const boxCells = stats.activeBox
        ? (stats.activeBox.right - stats.activeBox.left + 1) * (stats.activeBox.bottom - stats.activeBox.top + 1)
        : 0;
      frameLog.push({
        i: frameLog.length,
        intervalMs: +(now - lastFrameAt).toFixed(3),
        tickMs: +stats.lastTickMs.toFixed(4),
        wetCells: stats.wetCells,
        boxCells,
      });
      curve.push({ t: frameLog.length, wet: stats.wetCells, box: boxCells });
      lastFrameAt = now;
      window.requestAnimationFrame(watch);
    };
    window.requestAnimationFrame(watch);

    const strokeMs = profile.strokeMs || 600;
    const steps = Math.max(4, Math.round((strokeMs / 1000) * POINTER_HZ));
    const gapMs = Math.max(0, (1000 / (profile.rateHz || 1)) - strokeMs);

    for (let index = 0; index < trace.length; index += 1) {
      const entry = trace[index];
      const bound = box();
      const id = pointerId += 1;
      const pressure = Math.min(1, Math.max(0.05, dials.pressure));
      const at = (fraction) => {
        const position = fraction * (entry.points.length - 1);
        const low = entry.points[Math.floor(position)];
        const high = entry.points[Math.min(entry.points.length - 1, Math.ceil(position))];
        const blend = position - Math.floor(position);
        return {
          clientX: bound.left + low.x + (high.x - low.x) * blend,
          clientY: bound.top + low.y + (high.y - low.y) * blend,
        };
      };
      const options = (fraction) => ({
        pointerId: id, pointerType: 'mouse', pressure, bubbles: true, isPrimary: true, ...at(fraction),
      });
      const startedAt = performance.now();
      const before = frameLog.length;
      canvas.dispatchEvent(new PointerEvent('pointerdown', options(0)));
      for (let step = 1; step <= steps; step += 1) {
        await sleep(strokeMs / steps);
        canvas.dispatchEvent(new PointerEvent('pointermove', options(step / steps)));
      }
      window.dispatchEvent(new PointerEvent('pointerup', options(1)));
      const durationMs = performance.now() - startedAt;
      const engineStroke = engine.lastStroke();
      strokes.push({
        n: index + 1,
        inputPath: 'pointer',
        lengthCss: engineStroke ? +engineStroke.lengthCss.toFixed(2) : 0,
        stamps: engineStroke ? engineStroke.stamps : 0,
        durationMs: +durationMs.toFixed(2),
        framesDuringStroke: frameLog.length - before,
        pointerEvents: steps + 2,
      });
      if (gapMs > 0) await sleep(gapMs);
    }

    if (profile.settle) await quiesce(engine);
    watching = false;
    await nextFrame();

    const frames = frameLog.map((frame) => ({
      ...frame,
      // In interaction mode the render cost is inside the studio's own ticker,
      // so it cannot be split out without instrumenting the path under test.
      // The honest report is the frame interval, and render is not collected.
      frameMs: frame.intervalMs,
      renderMs: null,
    }));
    return { frames, strokes, curve, settleTicks: null, settleComplete: true, engineTicks: engine.stats().tick };
  }

  async function run(profileId, overrides = {}) {
    if (running) throw new Error('a benchmark is already running');
    const base = PROFILES[profileId];
    if (!base) throw new Error(`unknown profile: ${profileId}`);
    const profile = { ...base, ...overrides, dials: { ...base.dials, ...(overrides.dials || {}) } };
    running = true;
    const startedAtIso = new Date().toISOString();
    const wallStarted = performance.now();
    const previousDials = readDials();
    const previousTiming = getDebugTiming();
    try {
      const canvas = getCanvas();
      const surface = getSurface();
      setDebugTiming(true);
      resetCanvas();
      const engine = engineFor(surface);
      await quiesce(engine);
      setDials(profile.dials);
      const dials = readDials();

      const result = profile.mode === 'interaction'
        ? await runInteractionMode(profile, canvas, surface)
        : await runEngineMode(profile, canvas, surface);

      const frameMs = result.frames.map((frame) => frame.frameMs).filter((value) => Number.isFinite(value));
      const tickMs = result.frames.map((frame) => frame.tickMs).filter((value) => Number.isFinite(value));
      const renderMs = result.frames.map((frame) => frame.renderMs).filter((value) => Number.isFinite(value));
      const boxCells = result.frames.map((frame) => frame.boxCells);
      const wetCells = result.frames.map((frame) => frame.wetCells);
      const gridCells = engine.stats().grid.width * engine.stats().grid.height;
      const boxArea = boxCells.reduce((sum, value) => sum + value, 0);
      const wetArea = wetCells.reduce((sum, value) => sum + value, 0);

      const marks = fingerprint(engine, canvas);
      const undo = getUndoInfo ? getUndoInfo() : null;

      return {
        benchVersion: BENCH_VERSION,
        profile: {
          id: profile.id,
          version: profile.version,
          mode: profile.mode,
          label: profile.label,
          seed: profile.seed,
          strokes: profile.strokes,
          ticksPerStroke: profile.ticksPerStroke ?? null,
          rateHz: profile.rateHz ?? null,
          strokeMs: profile.strokeMs ?? null,
          placement: profile.placement || 'random',
          settle: Boolean(profile.settle),
          dials: profile.dials,
          // A run at anything but the production level measured less drawing
          // than the app does. Recorded so it can never be quoted as a frame
          // cost without the qualifier travelling with it.
          renderLevel: Number.isInteger(profile.renderLevel) ? profile.renderLevel : 3,
          flush: Boolean(profile.flush),
        },
        // What was actually in force, not what was requested — a dial the studio
        // clamped differently would otherwise be invisible.
        effective: dials,
        geometry: {
          cssWidth: Math.round(canvas.getBoundingClientRect().width),
          cssHeight: Math.round(canvas.getBoundingClientRect().height),
          backingWidth: canvas.width,
          backingHeight: canvas.height,
          devicePixelRatio: window.devicePixelRatio || 1,
          grid: engine.stats().grid,
          gridCells,
        },
        timing: {
          startedAt: startedAtIso,
          wallMs: +(performance.now() - wallStarted).toFixed(1),
        },
        metrics: {
          frameMs: quantiles(frameMs),
          tickMs: quantiles(tickMs),
          renderMs: renderMs.length ? quantiles(renderMs) : { count: 0, collected: false },
          depositMs: quantiles(result.strokes.map((stroke) => stroke.depositMs).filter(Number.isFinite)),
          msPer100: quantiles(result.strokes.map((stroke) => stroke.msPer100).filter(Number.isFinite)),
          settleTicks: result.settleTicks,
          settleComplete: result.settleComplete,
          engineTicks: result.engineTicks,
          // The over-iteration ratio: how many cells the simulation walked for
          // every cell that actually held water. This is the number slice 2
          // exists to move.
          boxOverWet: wetArea > 0 ? +(boxArea / wetArea).toFixed(2) : null,
          meanBoxPct: gridCells > 0 && boxCells.length ? +((boxArea / boxCells.length / gridCells) * 100).toFixed(2) : 0,
          meanWetPct: gridCells > 0 && wetCells.length ? +((wetArea / wetCells.length / gridCells) * 100).toFixed(2) : 0,
          undoSnapshots: undo ? undo.count : null,
          undoBytes: undo ? undo.bytes : null,
          heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
        },
        correctness: {
          ...marks,
          // Only engine mode can carry a correctness gate. Interaction mode is
          // paced by the wall clock, so the number of animation frames landing
          // between two pointer events varies run to run and the physics
          // legitimately differs — measured across three repetitions of one
          // build, three different fingerprints. The fingerprint is still
          // recorded (a wild change is still worth seeing) but comparing it
          // between candidates would fail every time and mean nothing.
          comparable: profile.mode !== 'interaction',
          uncomparableReason: profile.mode === 'interaction'
            ? 'interaction mode is wall-clock paced, so its physics is not reproducible; run an engine profile for the correctness gate'
            : null,
          // The curve digest catches an optimization that produces the same
          // final image by a different physical route — drying early, for
          // instance, lands the same pigment from a different wet history.
          curveHash: hashFloats(Float32Array.from(result.curve.map((point) => point.wet)), 16, 1),
          boxCurveHash: hashFloats(Float32Array.from(result.curve.map((point) => point.box)), 64, 1),
          engineTicks: result.engineTicks,
        },
        frames: result.frames,
        strokes: result.strokes,
        curve: result.curve,
      };
    } finally {
      running = false;
      setDebugTiming(previousTiming);
      setDials(previousDials);
    }
  }

  return {
    run,
    listProfiles,
    profiles: () => listProfiles(),
    isRunning: () => running,
    version: BENCH_VERSION,
  };
}
