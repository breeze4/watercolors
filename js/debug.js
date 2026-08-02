// Debug perf panel: live engine metrics overlaid on the studio, off by
// default and costing nothing until enabled (?debug=1 or studio.debug).
// Readable by humans: full-word labels, one time-series chart per moving
// metric, and an auto-stroke generator for repeatable soak runs. Sessions
// post themselves to the backend's debug-stats API (where one exists) so a
// run on any device can be read and analyzed later.

import { setDebugTiming } from './fluid.js';

// Caps bound what the *panel* holds for drawing. Reporting is append-only, so
// the server keeps the whole run; a cap may only drop records the server has
// already acknowledged (see trimSent).
const TIMELINE_CAP = 3600;
const STROKE_CAP = 1000;
const SAMPLE_MS = 1000;
const REPORT_EVERY_MS = 60 * 1000;
// Volume triggers, not just the timer. Both sendBeacon and keepalive fetch
// refuse bodies past roughly 64KB, and a minute of painting at the generator's
// top rate is about 130KB — so a time-only trigger leaves the page-hide flush
// too big to send, which is how it silently never worked. These bound any
// single delta to around 47KB.
const REPORT_PENDING_SAMPLES = 30;
const REPORT_PENDING_STROKES = 200;
// Below this a sample covered too little wall time to mean anything — the
// first tick after start-up, or a window that straddled a visibility change.
// It is recorded, but it is not a frame-rate measurement.
const MIN_MEASURED_FRAMES = 5;
const CHART_WIDTH = 272;
const CHART_HEIGHT = 40;

// Categorical palette for the sim-pass chart, fixed order by typical
// magnitude. Validated against the panel surface (#161a1f) for lightness
// band, chroma, CVD separation, and contrast — change only with a re-run
// of the palette validator.
const PASS_SERIES = [
  { key: 'advect', label: 'advect', color: '#1f9c8d' },
  { key: 'evap', label: 'evaporate', color: '#c07f1d' },
  { key: 'velocity', label: 'velocity', color: '#6b78d8' },
  { key: 'project', label: 'project', color: '#cf5f8d' },
  { key: 'mask', label: 'mask', color: '#86982a' },
];
const LINE_COLOR = '#1f9c8d';
const INK_MUTED = '#7d8b94';

function makeId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  // Old-Safari fallback; uniqueness only has to hold across debug sessions.
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16));
}

function sameGrid(a, b) {
  return Boolean(a) && Boolean(b) && a.width === b.width && a.height === b.height;
}

// One chart: a labeled current value plus a line (or bar) drawing of the
// whole recorded history, downsampled by bucket-max to fit the width.
function makeChart({ label, format, color = LINE_COLOR, bars = false, series = null }) {
  const root = document.createElement('div');
  root.className = 'debug-chart';
  const header = document.createElement('div');
  header.className = 'debug-chart-header';
  const labelNode = document.createElement('span');
  labelNode.className = 'debug-chart-label';
  labelNode.textContent = label;
  const valueNode = document.createElement('span');
  valueNode.className = 'debug-chart-value';
  header.append(labelNode, valueNode);
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(CHART_WIDTH * dpr);
  canvas.height = Math.round(CHART_HEIGHT * dpr);
  canvas.style.width = `${CHART_WIDTH}px`;
  canvas.style.height = `${CHART_HEIGHT}px`;
  root.append(header, canvas);
  if (series) {
    const legend = document.createElement('div');
    legend.className = 'debug-legend';
    for (const entry of series) {
      const item = document.createElement('span');
      const dot = document.createElement('span');
      dot.className = 'debug-legend-dot';
      dot.style.backgroundColor = entry.color;
      item.append(dot, document.createTextNode(entry.label));
      legend.append(item);
    }
    root.append(legend);
  }

  function bucketMax(values, buckets) {
    const out = new Array(buckets).fill(0);
    const per = values.length / buckets;
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      const from = Math.floor(bucket * per);
      const to = Math.max(from + 1, Math.floor((bucket + 1) * per));
      let max = 0;
      for (let index = from; index < to && index < values.length; index += 1) {
        if (values[index] > max) max = values[index];
      }
      out[bucket] = max;
    }
    return out;
  }

  function draw(history, currentText) {
    valueNode.textContent = currentText;
    const brush = canvas.getContext('2d');
    brush.setTransform(dpr, 0, 0, dpr, 0, 0);
    brush.clearRect(0, 0, CHART_WIDTH, CHART_HEIGHT);
    const rows = series ? series.map((entry) => history.map((sample) => sample[entry.key] || 0)) : [history];
    let max = 0;
    for (const row of rows) {
      for (const value of row) {
        if (value > max) max = value;
      }
    }
    if (max <= 0 || history.length < 2) return;
    const plotHeight = CHART_HEIGHT - 12;
    rows.forEach((row, rowIndex) => {
      const strokeColor = series ? series[rowIndex].color : color;
      if (bars) {
        const buckets = bucketMax(row, Math.floor(CHART_WIDTH / 3));
        brush.fillStyle = strokeColor;
        buckets.forEach((value, index) => {
          const height = Math.max(value > 0 ? 1 : 0, (value / max) * plotHeight);
          brush.fillRect(index * 3, CHART_HEIGHT - height, 2, height);
        });
      } else {
        const points = row.length > CHART_WIDTH ? bucketMax(row, CHART_WIDTH) : row;
        const stepX = CHART_WIDTH / (points.length - 1 || 1);
        brush.strokeStyle = strokeColor;
        brush.lineWidth = 1.5;
        brush.beginPath();
        points.forEach((value, index) => {
          const x = index * stepX;
          const y = CHART_HEIGHT - (value / max) * plotHeight;
          if (index === 0) brush.moveTo(x, y);
          else brush.lineTo(x, y);
        });
        brush.stroke();
      }
    });
    brush.fillStyle = INK_MUTED;
    brush.font = `10px -apple-system, system-ui, sans-serif`;
    brush.fillText(`max ${format(max)}`, 2, 9);
  }

  return { root, draw };
}

export function createDebugPanel({ getUndoInfo, getEngineStats, paintTestStroke, clearCanvas }) {
  // Two independent states: `enabled` is debug mode itself (timing and
  // sampling), `collapsed` is only whether the panel body is showing.
  // Collapsing must never disturb the running session — closing the panel
  // used to end it, silently losing the run.
  let enabled = false;
  let collapsed = false;
  let launcher = null;
  let body = null;
  let panel = null;
  let sampleTimer = null;
  let sessionId = null;
  let startedAt = 0;
  let startedAtIso = '';
  // Stamped once when the session starts. Read at report time instead and a
  // window resize or a DevTools device-emulation toggle rewrites the identity
  // of everything already recorded — which is exactly how a Windows session
  // came back labelled as a Pixel 9.
  let sessionMeta = null;
  let continuedFrom = null;
  let lastPasses = null;
  let lastSampleAt = 0;
  let lastReportAt = 0;
  // Absolute record counts, so trimming the display window never confuses the
  // append offsets. sentX is what the server has; xOffset is the absolute
  // index of the first record still held locally.
  let sentSamples = 0;
  let sentStrokes = 0;
  let sampleOffset = 0;
  let strokeOffset = 0;
  let frameBucket = [];
  let openStroke = null;
  let strokeCount = 0;
  // Strokes finished since the last sample: the load side of every chart, so
  // a spike in sim time can be read against what was being painted.
  let strokesThisSample = 0;
  let autoTimer = null;
  let autoRate = 3;
  // Armed by main.js from its one api/health probe. Until then (and forever
  // on backend-free hosts like GitHub Pages) debug mode makes no API calls.
  let hasBackend = false;
  let reportRow = null;

  const timeline = [];
  const strokes = [];

  const charts = {};
  let sessionNode = null;
  let lastStrokeNode = null;
  let memoryNode = null;
  let autoButton = null;
  let rateInput = null;
  let rateLabel = null;
  let reportStatusNode = null;

  function section(title) {
    const heading = document.createElement('div');
    heading.className = 'debug-section-title';
    heading.textContent = title;
    return heading;
  }

  function ensurePanel() {
    if (panel) return;
    // The launcher is what makes closing reversible: it stays put while debug
    // mode is on, so the panel can always be brought back.
    launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.className = 'debug-launcher';
    launcher.textContent = '📊 Perf';
    launcher.setAttribute('aria-label', 'Open performance monitor');
    launcher.addEventListener('click', expand);
    document.body.append(launcher);

    panel = document.createElement('div');
    panel.className = 'debug-panel';
    const header = document.createElement('div');
    header.className = 'debug-header';
    const title = document.createElement('span');
    title.textContent = 'Performance monitor';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Collapse performance monitor');
    close.addEventListener('click', collapse);
    header.append(title, close);
    panel.append(header);

    // The short id is how you find this run in the stats viewer's table.
    sessionNode = document.createElement('div');
    sessionNode.className = 'debug-session-id';
    panel.append(sessionNode);
    renderSessionId();

    // Controls first: the charts run past the bottom of a phone screen, and
    // the buttons are what you reach for mid-run.
    if (paintTestStroke) {
      panel.append(section('Auto strokes'));
      const controls = document.createElement('div');
      controls.className = 'debug-controls';
      autoButton = document.createElement('button');
      autoButton.type = 'button';
      autoButton.addEventListener('click', () => (autoTimer ? stopAuto() : startAuto(autoRate)));
      rateInput = document.createElement('input');
      rateInput.type = 'range';
      rateInput.min = '1';
      rateInput.max = '10';
      rateInput.step = '1';
      rateInput.value = String(autoRate);
      rateInput.setAttribute('aria-label', 'Auto strokes per second');
      rateInput.addEventListener('input', () => {
        autoRate = Number(rateInput.value);
        renderAutoControls();
        if (autoTimer) startAuto(autoRate);
      });
      rateLabel = document.createElement('span');
      controls.append(autoButton, rateInput, rateLabel);
      panel.append(controls);
      renderAutoControls();
    }

    const sessionRow = document.createElement('div');
    sessionRow.className = 'debug-controls';
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.textContent = 'Clear session';
    clearButton.addEventListener('click', clearSession);
    sessionRow.append(clearButton);
    panel.append(sessionRow);

    reportRow = document.createElement('div');
    reportRow.className = 'debug-controls';
    const reportButton = document.createElement('button');
    reportButton.type = 'button';
    reportButton.textContent = 'Send report';
    reportButton.addEventListener('click', () => { void sendReport('manual'); });
    reportStatusNode = document.createElement('span');
    reportStatusNode.className = 'debug-report-status';
    reportRow.append(reportButton, reportStatusNode);
    panel.append(reportRow);
    renderReportRow();

    charts.strokes = makeChart({ label: 'Strokes added per second', format: (v) => `${v.toFixed(1)}/s`, bars: true, color: '#c07f1d' });
    charts.fps = makeChart({ label: 'Frame rate', format: (v) => `${v.toFixed(0)} fps` });
    charts.tick = makeChart({ label: 'Simulation time per frame', format: (v) => `${v.toFixed(1)} ms` });
    charts.render = makeChart({ label: 'Render time per frame', format: (v) => `${v.toFixed(1)} ms` });
    // Two series on one chart on purpose: the gap between simulated area and
    // genuinely wet area is the thing worth seeing.
    charts.wet = makeChart({
      label: 'Simulated area vs wet area',
      format: (v) => `${v.toFixed(0)}%`,
      series: [{ key: 'boxPct', label: 'simulated', color: '#c07f1d' }, { key: 'wetPct', label: 'wet', color: '#1f9c8d' }],
    });
    charts.passes = makeChart({ label: 'Simulation passes (ms per frame)', format: (v) => `${v.toFixed(1)} ms`, series: PASS_SERIES });
    charts.stroke = makeChart({ label: 'Stroke cost (ms per 100 px)', format: (v) => `${v.toFixed(1)}`, bars: true });
    charts.heap = makeChart({ label: 'JS heap memory', format: (v) => `${v.toFixed(0)} MB` });

    panel.append(charts.strokes.root, charts.fps.root, charts.tick.root, charts.render.root, charts.wet.root, charts.passes.root, charts.stroke.root);

    panel.append(section('Latest stroke'));
    lastStrokeNode = document.createElement('div');
    lastStrokeNode.className = 'debug-text';
    lastStrokeNode.textContent = 'No strokes painted yet.';
    panel.append(lastStrokeNode);

    panel.append(charts.heap.root);
    memoryNode = document.createElement('div');
    memoryNode.className = 'debug-text';
    panel.append(memoryNode);

    document.body.append(panel);
  }

  function renderReportRow() {
    if (!reportRow) return;
    reportRow.hidden = !hasBackend;
  }

  function renderVisibility() {
    if (!panel) return;
    panel.hidden = !enabled || collapsed;
    launcher.hidden = !enabled || !collapsed;
  }

  function collapse() {
    collapsed = true;
    renderVisibility();
  }

  function expand() {
    collapsed = false;
    renderVisibility();
    // Charts skip drawing while collapsed, so catch them up on the way back.
    if (timeline.length > 0) redraw(timeline[timeline.length - 1]);
  }

  function renderSessionId() {
    if (!sessionNode) return;
    sessionNode.textContent = `Session ${String(sessionId).slice(0, 8)}`;
    sessionNode.title = sessionId || '';
  }

  function renderAutoControls() {
    if (!rateLabel) return;
    rateLabel.textContent = `${autoRate}/sec`;
    autoButton.textContent = autoTimer ? '⏸ Pause' : '▶ Start';
  }

  function startAuto(rate) {
    if (!paintTestStroke || !enabled) return false;
    const clamped = Math.min(10, Math.max(1, Math.round(Number(rate) || autoRate)));
    autoRate = clamped;
    if (rateInput) rateInput.value = String(clamped);
    if (autoTimer !== null) window.clearInterval(autoTimer);
    autoTimer = window.setInterval(paintTestStroke, 1000 / clamped);
    renderAutoControls();
    return true;
  }

  function stopAuto() {
    if (autoTimer !== null) {
      window.clearInterval(autoTimer);
      autoTimer = null;
      // A finished auto-run is exactly the session someone will want to read
      // from another machine — ship it without asking.
      void sendReport('auto-stop');
    }
    renderAutoControls();
  }

  // Pass counters are cumulative per engine (and reset when a resize rebuilds
  // the engine); show the per-frame delta and clamp rebuild jumps to zero.
  function passDelta(passes, frames) {
    const delta = {};
    for (const name of Object.keys(passes)) {
      const raw = lastPasses ? Math.max(0, passes[name] - (lastPasses[name] || 0)) : 0;
      delta[name] = frames > 0 ? raw / frames : 0;
    }
    lastPasses = { ...passes };
    return delta;
  }

  function sample() {
    const sampledAt = performance.now();
    const elapsed = sampledAt - lastSampleAt;
    lastSampleAt = sampledAt;
    const frames = frameBucket;
    frameBucket = [];
    const stats = getEngineStats();
    // A resize (or a device-emulation toggle) rebuilds the engine at a new
    // grid. Every per-cell number is keyed to that geometry, so the run splits
    // here rather than carrying two grids under one id: close the old session
    // out, start a fresh one that names it, and drop this straddling sample.
    if (sessionMeta && !sameGrid(sessionMeta.grid, stats.grid)) {
      void sendReport('grid-changed');
      const previous = sessionId;
      resetSession(previous);
      renderSessionId();
      setReportStatus('Canvas resized — new session started.');
      return;
    }
    const avg = (key) => (frames.length ? frames.reduce((sum, frame) => sum + frame[key], 0) / frames.length : 0);
    const gridCells = stats.grid.width * stats.grid.height;
    const strokesAdded = strokesThisSample;
    strokesThisSample = 0;
    // The simulation passes iterate the active bounding box, not the wet
    // cells inside it, so the box is the size that predicts frame cost.
    // Recording both is what makes the two separable in the data.
    const box = stats.activeBox;
    const boxCells = box ? (box.right - box.left + 1) * (box.bottom - box.top + 1) : 0;
    const entry = {
      // Exact elapsed ms. Rounded seconds collided whenever the timer drifted
      // past a boundary, leaving samples that could not be told apart.
      tMs: Math.round(sampledAt - startedAt),
      // The raw counts behind the rates below. Without them a partial start-up
      // window is indistinguishable from a genuine stall, and a start-up
      // artifact reads as the session's worst frame rate.
      frames: frames.length,
      elapsedMs: Math.round(elapsed),
      strokesAdded,
      fps: elapsed > 0 ? (frames.length * 1000) / elapsed : 0,
      tickMs: avg('tickMs'),
      renderMs: avg('renderMs'),
      wetPct: gridCells > 0 ? (stats.wetCells / gridCells) * 100 : 0,
      boxPct: gridCells > 0 ? (boxCells / gridCells) * 100 : 0,
      wetCells: stats.wetCells,
      boxCells,
      gridCells,
      heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0,
      strokes: elapsed > 0 ? (strokesAdded * 1000) / elapsed : 0,
      // Zero while hand-painting or idle; the set rate while the generator
      // runs, so the viewer can band the auto-driven stretches.
      autoRate: autoTimer !== null ? autoRate : 0,
      ...passDelta(stats.passes || {}, frames.length),
    };
    timeline.push(entry);
    trimSent();
    redraw(entry);
    const pendingSamples = sampleOffset + timeline.length - sentSamples;
    const pendingStrokes = strokeOffset + strokes.length - sentStrokes;
    const due = sampledAt - lastReportAt > REPORT_EVERY_MS
      || pendingSamples >= REPORT_PENDING_SAMPLES
      || pendingStrokes >= REPORT_PENDING_STROKES;
    if (due && (pendingSamples > 0 || pendingStrokes > 0)) void sendReport('periodic');
  }

  function redraw(entry) {
    if (!panel || collapsed) return;
    charts.strokes.draw(timeline.map((s) => s.strokes), `${entry.strokes.toFixed(1)}/s${entry.autoRate ? ' (auto)' : ''}`);
    charts.fps.draw(timeline.map((s) => s.fps), `${entry.fps.toFixed(0)} fps`);
    charts.tick.draw(timeline.map((s) => s.tickMs), `${entry.tickMs.toFixed(1)} ms`);
    charts.render.draw(timeline.map((s) => s.renderMs), `${entry.renderMs.toFixed(1)} ms`);
    charts.wet.draw(timeline, `${entry.boxPct.toFixed(0)}% sim / ${entry.wetPct.toFixed(0)}% wet`);
    const passTotal = PASS_SERIES.reduce((sum, seriesEntry) => sum + (entry[seriesEntry.key] || 0), 0);
    charts.passes.draw(timeline, `${passTotal.toFixed(1)} ms total`);
    charts.heap.draw(timeline.map((s) => s.heapMB), entry.heapMB ? `${entry.heapMB.toFixed(0)} MB` : 'n/a');
    charts.stroke.draw(strokes.map((s) => s.msPer100), strokes.length ? `${strokes[strokes.length - 1].msPer100.toFixed(1)} ms/100px` : '—');
    const undo = getUndoInfo();
    memoryNode.textContent = `Undo stack: ${undo.count} snapshots holding ${(undo.bytes / 1048576).toFixed(1)} MB.`;
  }

  function recordFrame(tickMs, renderMs) {
    if (!enabled) return;
    frameBucket.push({ tickMs, renderMs });
    if (openStroke) openStroke.simMs += tickMs + renderMs;
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
    const record = {
      n: strokeCount,
      lengthCss,
      stamps: engineStroke ? engineStroke.stamps : 0,
      undoMs: openStroke.undoMs,
      depositMs: openStroke.depositMs,
      simMs: openStroke.simMs,
      totalMs,
      msPer100: (totalMs / Math.max(1, lengthCss)) * 100,
    };
    strokes.push(record);
    trimSent();
    strokesThisSample += 1;
    openStroke = null;
    if (lastStrokeNode) {
      lastStrokeNode.textContent = `Stroke #${record.n}: ${record.lengthCss.toFixed(0)} px, ${record.stamps} stamps — `
        + `undo copy ${record.undoMs.toFixed(1)} ms, paint ${record.depositMs.toFixed(1)} ms, sim during stroke ${record.simMs.toFixed(1)} ms.`;
    }
  }

  // Everything that identifies the device and its geometry, read once. A
  // resize or an emulation toggle after this point starts a new session
  // instead of rewriting the identity of what is already recorded.
  function stampMeta() {
    const versionTag = document.querySelector('.version-tag');
    const stats = getEngineStats();
    return {
      startedAt: startedAtIso,
      userAgent: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio || 1,
      screen: { width: window.screen.width, height: window.screen.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      grid: { ...stats.grid },
      version: versionTag ? versionTag.textContent.trim() : 'unknown',
    };
  }

  // Caps bound what the panel holds for drawing, not what gets reported: the
  // server has the whole run. Only acknowledged records may be dropped, so
  // hitting a cap can never destroy history that was never sent.
  function trimSent() {
    const spareSamples = Math.min(timeline.length - TIMELINE_CAP, sentSamples - sampleOffset);
    if (spareSamples > 0) {
      timeline.splice(0, spareSamples);
      sampleOffset += spareSamples;
    }
    const spareStrokes = Math.min(strokes.length - STROKE_CAP, sentStrokes - strokeOffset);
    if (spareStrokes > 0) {
      strokes.splice(0, spareStrokes);
      strokeOffset += spareStrokes;
    }
  }

  // Only the records the server does not have yet. `from` is the absolute
  // index of the first one, which is what lets the server append instead of
  // replacing — and therefore what stops a short post clobbering a long run.
  function reportPayload({ full = false } = {}) {
    const sampleFrom = full ? 0 : Math.max(sentSamples, sampleOffset);
    const strokeFrom = full ? 0 : Math.max(sentStrokes, strokeOffset);
    const meta = {
      ...sessionMeta,
      durationS: Math.round((performance.now() - startedAt) / 1000),
      strokesPainted: strokeCount,
    };
    if (continuedFrom) meta.continuedFrom = continuedFrom;
    if (full && sampleOffset > 0) meta.truncatedHead = true;
    return {
      id: sessionId,
      meta,
      from: { samples: sampleFrom, strokes: strokeFrom },
      timeline: full ? [...timeline] : timeline.slice(sampleFrom - sampleOffset),
      strokes: full ? [...strokes] : strokes.slice(strokeFrom - strokeOffset),
    };
  }

  // A full replace re-bases local numbering on what the server now holds.
  function commitSent(payload, full) {
    if (full) {
      sampleOffset = 0;
      strokeOffset = 0;
      sentSamples = payload.timeline.length;
      sentStrokes = payload.strokes.length;
    } else {
      sentSamples = payload.from.samples + payload.timeline.length;
      sentStrokes = payload.from.strokes + payload.strokes.length;
    }
    trimSent();
  }

  // The server is the authority on how much of this session it holds. Adopting
  // its counts covers the ordinary race — a beacon landing while a periodic
  // post was in flight — without throwing away history to resync.
  function reconcile(expected) {
    if (!expected) return false;
    const samplesFit = expected.samples >= sampleOffset && expected.samples <= sampleOffset + timeline.length;
    const strokesFit = expected.strokes >= strokeOffset && expected.strokes <= strokeOffset + strokes.length;
    if (!samplesFit || !strokesFit) return false;
    sentSamples = expected.samples;
    sentStrokes = expected.strokes;
    return true;
  }

  function setReportStatus(text) {
    if (reportStatusNode) reportStatusNode.textContent = text;
  }

  async function sendReport(reason, options = {}) {
    if (!hasBackend) return { sent: false, reason: 'no backend' };
    if (!sessionId || timeline.length === 0) return { sent: false, reason: 'no data' };
    const full = Boolean(options.full);
    const payload = reportPayload({ full });
    if (!full && payload.timeline.length === 0 && payload.strokes.length === 0) {
      return { sent: false, reason: 'nothing new' };
    }
    // Closing a session out (a grid split, a manual clear) starts a new one
    // while this post is still in flight. The offsets it acknowledges belong
    // to the session it was built from, so they must not land on its successor.
    const forSession = sessionId;
    lastReportAt = performance.now();
    try {
      const response = await fetch('api/debug-stats', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      // Offsets drifted from the server's. Adopt its counts where the delta is
      // still reproducible from what we hold; otherwise replace wholesale.
      if (sessionId !== forSession) {
        // The session ended mid-flight; its records are the server's problem
        // now and nothing here applies to the run that replaced it.
        return { sent: response.ok, id: forSession, reason: 'session closed' };
      }
      if (response.status === 409 && !full && !options.retry) {
        const conflict = await response.json().catch(() => null);
        return reconcile(conflict && conflict.expected)
          ? sendReport(reason, { retry: true })
          : sendReport(reason, { full: true });
      }
      if (!response.ok) throw new Error(`status ${response.status}`);
      commitSent(payload, full);
      setReportStatus(`Report sent (${reason}).`);
      return { sent: true, id: sessionId };
    } catch (sendError) {
      // Pages has no backend; a LAN drop looks the same. Say so and move on.
      setReportStatus('No backend reachable — report kept locally.');
      return { sent: false, reason: String(sendError && sendError.message) };
    }
  }

  // A device pocketed mid-run still reports. sendBeacon silently refuses
  // payloads past its ~64KB cap and returns false — which is why this path
  // never once flushed a real session before deltas made the payload small.
  // keepalive fetch is the fallback, and it also survives the page going away.
  function beaconOnHide() {
    if (!hasBackend || !enabled || !document.hidden || timeline.length === 0) return;
    const payload = reportPayload();
    if (payload.timeline.length === 0 && payload.strokes.length === 0) return;
    const body = JSON.stringify(payload);
    const forSession = sessionId;
    const queued = Boolean(navigator.sendBeacon)
      && navigator.sendBeacon('api/debug-stats', new Blob([body], { type: 'application/json' }));
    if (queued) {
      commitSent(payload, false);
      return;
    }
    void fetch('api/debug-stats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).then((response) => {
      if (sessionId !== forSession) return;
      if (response.ok) commitSent(payload, false);
      else setReportStatus('Final report could not be flushed.');
    }).catch(() => setReportStatus('Final report could not be flushed.'));
  }

  // Everything that makes a session a session, so starting one and clearing
  // one can never drift apart.
  function resetSession(previousId = null) {
    sessionId = makeId();
    continuedFrom = previousId;
    startedAt = performance.now();
    startedAtIso = new Date().toISOString();
    sessionMeta = stampMeta();
    lastSampleAt = startedAt;
    lastReportAt = startedAt;
    sentSamples = 0;
    sentStrokes = 0;
    sampleOffset = 0;
    strokeOffset = 0;
    timeline.length = 0;
    strokes.length = 0;
    strokeCount = 0;
    strokesThisSample = 0;
    lastPasses = null;
    frameBucket = [];
    openStroke = null;
  }

  // Wipe the paper and start a fresh session id: the next report lands as a
  // new run rather than extending the one already on the server.
  function clearSession() {
    if (!enabled) return null;
    stopAuto();
    // Close the outgoing run out to the backend first — clearing starts a new
    // session, it does not throw away the one just measured. The payload is
    // built synchronously here, before the reset swaps the id out from under
    // it. Delete it from the viewer if it was junk.
    void sendReport('session-cleared');
    if (clearCanvas) clearCanvas();
    resetSession();
    renderSessionId();
    if (lastStrokeNode) lastStrokeNode.textContent = 'No strokes painted yet.';
    setReportStatus('New session started.');
    // Every field redraw reads has to be present — a missing one throws here,
    // which used to leave a cleared session with a dead panel.
    redraw({ tMs: 0, fps: 0, tickMs: 0, renderMs: 0, wetPct: 0, boxPct: 0, heapMB: 0, strokes: 0, autoRate: 0 });
    return sessionId;
  }

  function show() {
    if (enabled) return;
    enabled = true;
    resetSession();
    setDebugTiming(true);
    ensurePanel();
    renderSessionId();
    collapsed = false;
    renderVisibility();
    setReportStatus('');
    sampleTimer = window.setInterval(sample, SAMPLE_MS);
    document.addEventListener('visibilitychange', beaconOnHide);
  }

  function hide() {
    if (!enabled) return;
    // Flush the tail before going quiet: everything painted since the last
    // report is otherwise lost when debug mode is switched off.
    void sendReport('debug-off');
    enabled = false;
    setDebugTiming(false);
    stopAuto();
    renderVisibility();
    if (sampleTimer !== null) {
      window.clearInterval(sampleTimer);
      sampleTimer = null;
    }
    document.removeEventListener('visibilitychange', beaconOnHide);
  }

  function getMetrics() {
    return {
      enabled,
      sessionId,
      timeline: timeline.map((entry) => ({ ...entry })),
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
      collapse,
      expand,
      isCollapsed: () => collapsed,
      getMetrics,
      startAuto,
      stopAuto,
      isAutoRunning: () => autoTimer !== null,
      clearSession,
      getSessionId: () => sessionId,
      sendReport: () => sendReport('manual'),
      setBackendAvailable(available) {
        hasBackend = Boolean(available);
        renderReportRow();
      },
    },
  };
}
