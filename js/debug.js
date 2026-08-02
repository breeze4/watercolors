// Debug stats panel: live engine metrics overlaid on the studio, off by
// default and costing nothing until enabled (?debug=1 or studio.debug).
// The panel is an instrument, not a tin: monospace text plus one sparkline
// of normalized per-stroke cost — the number that should stay flat as a
// painting accumulates strokes.

import { setDebugTiming } from './fluid.js';

const FRAME_WINDOW = 120;
const STROKE_HISTORY = 200;
const TEXT_REFRESH_MS = 250;
const SPARK_WIDTH = 220;
const SPARK_HEIGHT = 46;

export function createDebugPanel({ getUndoInfo, getEngineStats }) {
  let enabled = false;
  let panel = null;
  let textNode = null;
  let spark = null;
  let idleTimer = null;
  let lastTextAt = 0;
  let lastPasses = null;
  let latestStats = null;

  const frames = [];
  const strokes = [];
  let strokeCount = 0;
  // The stroke being painted right now; sim frame time lands here until
  // strokeEnd closes it out.
  let openStroke = null;

  function ensurePanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.className = 'debug-panel';
    panel.setAttribute('aria-hidden', 'true');
    textNode = document.createElement('pre');
    spark = document.createElement('canvas');
    spark.width = SPARK_WIDTH;
    spark.height = SPARK_HEIGHT;
    panel.append(textNode, spark);
    document.body.append(panel);
  }

  function frameRollup() {
    if (frames.length === 0) return { fps: 0, tickMsAvg: 0, renderMsAvg: 0, lastTickMs: 0, lastRenderMs: 0, count: 0 };
    let tickTotal = 0;
    let renderTotal = 0;
    for (const frame of frames) {
      tickTotal += frame.tickMs;
      renderTotal += frame.renderMs;
    }
    const last = frames[frames.length - 1];
    const span = last.at - frames[0].at;
    return {
      fps: frames.length > 1 && span > 0 ? ((frames.length - 1) * 1000) / span : 0,
      tickMsAvg: tickTotal / frames.length,
      renderMsAvg: renderTotal / frames.length,
      lastTickMs: last.tickMs,
      lastRenderMs: last.renderMs,
      count: frames.length,
    };
  }

  // Pass counters are cumulative per engine (and reset when a resize rebuilds
  // the engine), so the panel shows the delta since the last refresh and
  // clamps a rebuild's backward jump to zero.
  function passDelta(passes) {
    const delta = {};
    for (const name of Object.keys(passes)) {
      delta[name] = lastPasses ? Math.max(0, passes[name] - (lastPasses[name] || 0)) : 0;
    }
    lastPasses = { ...passes };
    return delta;
  }

  function heapLine() {
    const undo = getUndoInfo();
    const undoMb = (undo.bytes / (1024 * 1024)).toFixed(1);
    const heap = performance.memory ? ` heap ${(performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(0)}MB` : '';
    return `undo ${undo.count} snaps ${undoMb}MB${heap}`;
  }

  function refreshText() {
    if (!enabled || !textNode) return;
    lastTextAt = performance.now();
    const rollup = frameRollup();
    const stats = latestStats || getEngineStats();
    const lines = [];
    lines.push(`fps ${rollup.fps.toFixed(0)}  tick ${rollup.tickMsAvg.toFixed(2)}ms  render ${rollup.renderMsAvg.toFixed(2)}ms`);
    const box = stats.activeBox ? `${stats.activeBox.right - stats.activeBox.left + 1}×${stats.activeBox.bottom - stats.activeBox.top + 1}` : 'dry';
    lines.push(`wet ${stats.wetCells}  box ${box}  grid ${stats.grid.width}×${stats.grid.height}`);
    if (stats.passes) {
      const delta = passDelta(stats.passes);
      lines.push(`pass mask ${delta.mask.toFixed(1)} evap ${delta.evap.toFixed(1)} vel ${delta.velocity.toFixed(1)}`);
      lines.push(`     adv ${delta.advect.toFixed(1)} proj ${delta.project.toFixed(1)} (ms/refresh)`);
    }
    const stroke = strokes[strokes.length - 1];
    if (stroke) {
      lines.push(`stroke #${stroke.n}: ${stroke.lengthCss.toFixed(0)}px ${stroke.stamps} stamps`);
      lines.push(`  undo ${stroke.undoMs.toFixed(1)} deposit ${stroke.depositMs.toFixed(1)} sim ${stroke.simMs.toFixed(1)}ms`);
      lines.push(`  cost ${stroke.msPer100.toFixed(1)} ms/100px`);
    }
    lines.push(heapLine());
    textNode.textContent = lines.join('\n');
  }

  function drawSparkline() {
    if (!spark) return;
    const brush = spark.getContext('2d');
    brush.clearRect(0, 0, SPARK_WIDTH, SPARK_HEIGHT);
    if (strokes.length === 0) return;
    let max = 0;
    for (const stroke of strokes) {
      if (stroke.msPer100 > max) max = stroke.msPer100;
    }
    if (max <= 0) return;
    const barWidth = Math.max(1, Math.floor(SPARK_WIDTH / STROKE_HISTORY));
    brush.fillStyle = '#4db6ac';
    strokes.forEach((stroke, index) => {
      const height = Math.max(1, (stroke.msPer100 / max) * (SPARK_HEIGHT - 12));
      brush.fillRect(index * barWidth, SPARK_HEIGHT - height, barWidth, height);
    });
    brush.fillStyle = '#d6e4ea';
    brush.font = '9px ui-monospace, Menlo, monospace';
    brush.fillText(`ms/100px  max ${max.toFixed(1)}`, 2, 9);
  }

  function recordFrame(tickMs, renderMs, stats) {
    if (!enabled) return;
    frames.push({ at: performance.now(), tickMs, renderMs });
    if (frames.length > FRAME_WINDOW) frames.splice(0, frames.length - FRAME_WINDOW);
    latestStats = stats;
    if (openStroke) openStroke.simMs += tickMs + renderMs;
    if (performance.now() - lastTextAt > TEXT_REFRESH_MS) refreshText();
  }

  function strokeBegin(undoMs) {
    if (!enabled) return;
    openStroke = { undoMs, depositMs: 0, simMs: 0 };
  }

  function addDepositTime(ms) {
    if (openStroke) openStroke.depositMs += ms;
  }

  function strokeEnd(engineStroke) {
    if (!enabled || !openStroke) return;
    strokeCount += 1;
    const lengthCss = engineStroke ? engineStroke.lengthCss : 0;
    const totalMs = openStroke.undoMs + openStroke.depositMs + openStroke.simMs;
    strokes.push({
      n: strokeCount,
      lengthCss,
      stamps: engineStroke ? engineStroke.stamps : 0,
      undoMs: openStroke.undoMs,
      depositMs: openStroke.depositMs,
      simMs: openStroke.simMs,
      totalMs,
      msPer100: (totalMs / Math.max(1, lengthCss)) * 100,
    });
    if (strokes.length > STROKE_HISTORY) strokes.splice(0, strokes.length - STROKE_HISTORY);
    openStroke = null;
    drawSparkline();
    refreshText();
  }

  function show() {
    if (enabled) return;
    enabled = true;
    setDebugTiming(true);
    ensurePanel();
    panel.hidden = false;
    refreshText();
    // The ticker only runs while wet, so a slow refresh keeps the memory and
    // undo lines honest on an idle canvas.
    idleTimer = window.setInterval(refreshText, 1000);
  }

  function hide() {
    if (!enabled) return;
    enabled = false;
    setDebugTiming(false);
    if (panel) panel.hidden = true;
    if (idleTimer !== null) {
      window.clearInterval(idleTimer);
      idleTimer = null;
    }
  }

  function getMetrics() {
    return {
      enabled,
      frames: frameRollup(),
      strokes: strokes.map((stroke) => ({ ...stroke })),
      memory: { ...getUndoInfo(), heapUsed: performance.memory ? performance.memory.usedJSHeapSize : null },
    };
  }

  return {
    enabled: () => enabled,
    recordFrame,
    strokeBegin,
    addDepositTime,
    strokeEnd,
    api: {
      show,
      hide,
      toggle() { (enabled ? hide : show)(); return enabled; },
      isEnabled: () => enabled,
      getMetrics,
    },
  };
}
