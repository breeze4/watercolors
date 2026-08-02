// Studio assembly: paint state, DOM wiring, pointer and keyboard handling, and
// the window.studio verification surface. Engines live in their own modules.
// This file has to stand alone on a backend-free host, so it owns only the
// studio markup and never reaches for DOM the paint-along layer injects.

import { mixColors, normalizeColor } from './color.js';
import { clampPressure, paintStrokePath, sizePixels } from './brush.js';
import { engineFor } from './fluid.js';
import { createDebugPanel } from './debug.js';
import { createSlotStore } from './slots.js';
import { createSoundKit } from './audio.js';
import { applyBlobShapes, playWash, spawnPaintSpecks, splatNewestSwatch } from './juice.js';

// The dials span exactly the useful range and nothing more: 100% is the old
// default effect (as hard or as wet as a stroke ever needs to be), 0% is
// nothing, and the default sits at the 50% midpoint. Linear in between —
// every notch of the gauge does real work. Recorded stroke points still
// carry effective pressure, so replay calibration never moves.
const PRESSURE_DIAL_DEFAULT = 0.5;
const WATER_DIAL_DEFAULT = 0.5;
const PRESSURE_EFFECT_MAX = 0.65;
const WATER_EFFECT_MAX = 0.5;

function effectivePressure(dial) {
  return clampPressure(Math.min(1, Math.max(0, dial)) * PRESSURE_EFFECT_MAX);
}

function effectiveWater(dial) {
  return Math.min(1, Math.max(0, dial)) * WATER_EFFECT_MAX;
}

// Racing the brush thins the stroke toward dry-brush; easing in presses more
// paint out. Speed is px/ms against the event timestamp clock.
function velocityAdjusted(pressure, distance, elapsed) {
  if (!Number.isFinite(elapsed) || elapsed <= 0) return pressure;
  const speed = distance / elapsed;
  const factor = Math.min(1.12, Math.max(0.55, 1.12 - speed * 0.28));
  return clampPressure(pressure * factor);
}

const basePalette = [
  '#ef5350', '#f48fb1', '#ba68c8', '#7986cb',
  '#338bd5', '#4db6ac', '#81c784', '#c5d65a',
  '#ffd54f', '#ffb74d', '#a1887f', '#455a64',
];

const CUSTOM_COLORS_KEY = 'splotchbox.custom-colors.v1';

// Cycle-chip stops (mobile): 20% steps. Pressure skips 0 — a zero-pressure
// stroke paints nearly nothing and reads as broken; the API and keyboard can
// still reach lower values.
const PRESSURE_CHIP_STOPS = [0.2, 0.4, 0.6, 0.8, 1];
const PERCENT_CHIP_STOPS = [0, 0.2, 0.4, 0.6, 0.8, 1];

function nextChipStop(current, stops) {
  for (const stop of stops) {
    if (stop > current + 0.001) return stop;
  }
  return stops[0];
}

export function createStudio({ onLayoutSettled = () => {} } = {}) {
  // The paint-along layer loads after the studio is already running, so the
  // settle hook is replaceable rather than fixed at construction.
  let layoutSettled = onLayoutSettled;

  const canvas = document.querySelector('#paint-canvas');
  const clearButton = document.querySelector('#clear-canvas');
  const undoButton = document.querySelector('#undo-canvas');
  const saveButton = document.querySelector('#save-canvas');
  const saveDeviceButton = document.querySelector('#save-device');
  const paletteContainer = document.querySelector('#palette-swatches');
  const trayContainer = document.querySelector('#tray-swatches');
  const pickerPanel = document.querySelector('#color-picker');
  const pickerSpectrum = document.querySelector('#picker-spectrum');
  const pickerPreview = document.querySelector('#picker-preview');
  const pickerAddButton = document.querySelector('#picker-add');
  const pickerCloseButton = document.querySelector('#picker-close');
  const clearTrayButton = document.querySelector('#clear-tray');
  const hardnessControls = document.querySelector('#hardness-controls');
  const sizeControls = document.querySelector('#size-controls');
  const chipHardness = document.querySelector('#chip-hardness');
  const chipSize = document.querySelector('#chip-size');
  const chipPressure = document.querySelector('#chip-pressure');
  const chipWater = document.querySelector('#chip-water');
  const chipPaint = document.querySelector('#chip-paint');
  const canvasLid = canvas.closest('.canvas-lid');
  const washOverlay = document.querySelector('#canvas-wash');
  const brushCursor = document.querySelector('#brush-cursor');
  const context = canvas.getContext('2d', { willReadFrequently: true });

  let customPalette = readCustomPalette();

  const state = {
    color: '#4a90c2',
    hardness: 3,
    size: 'm',
    pressure: PRESSURE_DIAL_DEFAULT,
    water: WATER_DIAL_DEFAULT,
    paint: 0.5,
    palette: basePalette,
    tray: [],
    pendingMixColor: null,
  };
  const mainSurface = { canvas, context, dpr: () => window.devicePixelRatio || 1 };
  const undoStack = [];
  const undoLimit = 20;
  const undoBudgetBytes = 40 * 1024 * 1024;
  let canvasWidth = 0;
  let canvasHeight = 0;

  // Master paint buffer: CSS-pixel dimensions only ever grow, so a viewport
  // shrink (rotation, iPad app-switcher round trip) crops the view without
  // destroying paint — growing back restores it. The overlap is overwritten
  // with the visible canvas on every resize, so new paint wins there while
  // off-view regions survive untouched.
  const master = { canvas: document.createElement('canvas'), cssWidth: 0, cssHeight: 0, dpr: 1 };

  function resetMaster() {
    master.cssWidth = 0;
    master.cssHeight = 0;
  }

  function writeMaster() {
    if (!canvasWidth || !canvasHeight || canvas.width === 0 || canvas.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const neededWidth = Math.max(master.cssWidth, canvasWidth);
    const neededHeight = Math.max(master.cssHeight, canvasHeight);
    if (master.dpr !== dpr || neededWidth > master.cssWidth || neededHeight > master.cssHeight) {
      const grown = document.createElement('canvas');
      grown.width = Math.round(neededWidth * dpr);
      grown.height = Math.round(neededHeight * dpr);
      const grownContext = grown.getContext('2d');
      grownContext.fillStyle = '#fff';
      grownContext.fillRect(0, 0, grown.width, grown.height);
      if (master.cssWidth && master.cssHeight) {
        grownContext.drawImage(master.canvas, 0, 0, Math.round(master.cssWidth * dpr), Math.round(master.cssHeight * dpr));
      }
      master.canvas = grown;
      master.cssWidth = neededWidth;
      master.cssHeight = neededHeight;
      master.dpr = dpr;
    }
    master.canvas.getContext('2d')
      .drawImage(canvas, 0, 0, Math.round(canvasWidth * master.dpr), Math.round(canvasHeight * master.dpr));
  }
  let activePointerId = null;
  let previousPoint = null;
  let presentationReady = false;
  let lastMoveTime = 0;
  let livePressure = effectivePressure(PRESSURE_DIAL_DEFAULT);
  let tickerHandle = null;

  const debugPanel = createDebugPanel({
    getUndoInfo() {
      let bytes = 0;
      for (const snapshot of undoStack) bytes += snapshot.width * snapshot.height * 4;
      return { count: undoStack.length, bytes };
    },
    getEngineStats: () => engineFor(mainSurface).stats(),
    // One random wavy stroke through the normal paint path (undo snapshot and
    // all), for the panel's auto-stroke perf generator. Math.random is fine
    // here — these are user strokes, not replayed reference geometry.
    paintTestStroke() {
      const margin = 24;
      const spanX = Math.max(60, canvasWidth - margin * 2 - 130);
      const spanY = Math.max(60, canvasHeight - margin * 2 - 40);
      const x0 = margin + Math.random() * spanX;
      const y0 = margin + 20 + Math.random() * spanY;
      const angle = Math.random() * Math.PI * 2;
      const length = 70 + Math.random() * 150;
      const wobble = 8 + Math.random() * 14;
      const segments = 12;
      const points = [];
      for (let seg = 0; seg <= segments; seg += 1) {
        const along = (seg / segments) * length;
        points.push({
          x: x0 + Math.cos(angle) * along + Math.cos(angle + Math.PI / 2) * Math.sin(seg / 2) * wobble,
          y: y0 + Math.sin(angle) * along + Math.sin(angle + Math.PI / 2) * Math.sin(seg / 2) * wobble,
          p: 0.25 + Math.random() * 0.3,
        });
      }
      paintStroke(points);
    },
  });

  // The sim keeps moving while anything is wet: tick and repaint on animation
  // frames until the paper dries, then stop costing anything.
  function startTicker() {
    if (tickerHandle !== null) return;
    const step = () => {
      const engine = engineFor(mainSurface);
      if (debugPanel.enabled()) {
        const tickStarted = performance.now();
        engine.tick(2);
        const renderStarted = performance.now();
        engine.render();
        debugPanel.recordFrame(renderStarted - tickStarted, performance.now() - renderStarted, engine.stats());
      } else {
        engine.tick(2);
        engine.render();
      }
      if (engine.isActive() || activePointerId !== null) {
        tickerHandle = window.requestAnimationFrame(step);
      } else {
        tickerHandle = null;
      }
    };
    tickerHandle = window.requestAnimationFrame(step);
  }

  const pressureFill = document.querySelector('#pressure-fill');
  const pressureValue = document.querySelector('#pressure-value');

  // The meter is a control, not a telemetry readout: it holds the set value
  // steady while painting (velocity still modulates the actual stroke).
  // The chips are the mobile skin of the same state: labels and fill tints
  // rerender from every setter, so the two renderings can never disagree.
  function renderChips() {
    if (!chipHardness) return;
    chipHardness.textContent = `Hard ${state.hardness}`;
    chipHardness.setAttribute('aria-label', `Brush hardness ${state.hardness} of 6 — tap to change`);
    chipSize.textContent = `Size ${String(state.size).toUpperCase()}`;
    chipSize.setAttribute('aria-label', `Brush size ${String(state.size).toUpperCase()} — tap to change`);
    [[chipPressure, 'Press', 'Pressure', state.pressure],
      [chipWater, 'Water', 'Water', state.water],
      [chipPaint, 'Paint', 'Paint', state.paint]].forEach(([chip, label, fullLabel, value]) => {
      const percent = Math.round(value * 100);
      chip.textContent = `${label} ${percent}%`;
      chip.style.setProperty('--chip-fill', `${percent}%`);
      chip.setAttribute('aria-label', `${fullLabel} ${percent}% — tap to change`);
    });
  }

  function renderPressure() {
    if (pressureFill) pressureFill.style.width = `${Math.round(state.pressure * 100)}%`;
    if (pressureValue) pressureValue.textContent = `${Math.round(state.pressure * 100)}%`;
    renderChips();
  }

  function setPressure(pressure) {
    const numeric = Number(pressure);
    if (!Number.isFinite(numeric)) return false;
    state.pressure = Math.round(Math.min(1, Math.max(0, numeric)) * 100) / 100;
    renderPressure();
    return true;
  }

  const waterFill = document.querySelector('#water-fill');
  const waterValue = document.querySelector('#water-value');
  const paintFill = document.querySelector('#paint-fill');
  const paintValue = document.querySelector('#paint-value');

  function renderWater() {
    if (waterFill) waterFill.style.width = `${Math.round(state.water * 100)}%`;
    if (waterValue) waterValue.textContent = `${Math.round(state.water * 100)}%`;
    renderChips();
  }

  function setWater(water) {
    const numeric = Number(water);
    if (!Number.isFinite(numeric)) return false;
    state.water = Math.round(Math.min(1, Math.max(0, numeric)) * 100) / 100;
    renderWater();
    return true;
  }

  function renderPaint() {
    if (paintFill) paintFill.style.width = `${Math.round(state.paint * 100)}%`;
    if (paintValue) paintValue.textContent = `${Math.round(state.paint * 100)}%`;
    renderChips();
  }

  function setPaint(paint) {
    const numeric = Number(paint);
    if (!Number.isFinite(numeric)) return false;
    state.paint = Math.round(Math.min(1, Math.max(0, numeric)) * 100) / 100;
    renderPaint();
    return true;
  }

  // The meters are sliders, not just readouts: tap or drag anywhere on the bar
  // to set the value — the only way to reach them on a touch screen.
  function attachMeter(selector, apply) {
    const meter = document.querySelector(selector);
    if (!meter) return;
    const applyFromEvent = (event) => {
      const bounds = meter.getBoundingClientRect();
      if (bounds.width < 1) return;
      apply((event.clientX - bounds.left) / bounds.width);
      meter.setAttribute('aria-valuenow', meter.querySelector('.pressure-fill')?.style.width || '');
    };
    let activePointer = null;
    meter.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      activePointer = event.pointerId;
      try {
        meter.setPointerCapture(event.pointerId);
      } catch (error) {
        // Capture is an enhancement; a plain tap still sets the value.
      }
      applyFromEvent(event);
    });
    meter.addEventListener('pointermove', (event) => {
      if (event.pointerId === activePointer) applyFromEvent(event);
    });
    meter.addEventListener('pointerup', (event) => {
      if (event.pointerId === activePointer) activePointer = null;
    });
    meter.addEventListener('pointercancel', (event) => {
      if (event.pointerId === activePointer) activePointer = null;
    });
  }

  // A stylus reports true pressure; mice and trackpads report a constant, so
  // they fall back to the keyboard-adjustable base pressure. Both ride the same
  // dial curve, so a light pen touch gets the same fine low range as the keys.
  function pointerPressure(event) {
    if (event.pointerType === 'pen' && event.pressure > 0) return effectivePressure(event.pressure);
    return effectivePressure(state.pressure);
  }

  function sizeForCursor() {
    return sizePixels[state.size] * (0.48 + 0.8 * effectivePressure(state.pressure));
  }

  function updateBrushCursor(event) {
    if (!brushCursor || window.innerWidth <= 720 || event.pointerType === 'touch') return;
    const size = sizeForCursor();
    brushCursor.style.setProperty('--cursor-size', `${size}px`);
    brushCursor.style.setProperty('--cursor-color', state.color);
    brushCursor.style.setProperty('--cursor-hardness', String(state.hardness));
    brushCursor.style.left = `${event.clientX}px`;
    brushCursor.style.top = `${event.clientY}px`;
    brushCursor.dataset.color = state.color;
    brushCursor.dataset.size = state.size;
    brushCursor.dataset.hardness = String(state.hardness);
    brushCursor.classList.add('is-visible');
  }

  function hideBrushCursor() {
    if (brushCursor) brushCursor.classList.remove('is-visible');
  }

  function resolveSwatch(swatch) {
    if (typeof swatch === 'number' && Number.isInteger(swatch)) {
      return basePalette[swatch] || state.tray[swatch - basePalette.length] || null;
    }
    if (swatch && typeof swatch === 'object') return resolveSwatch(swatch.color);
    const color = normalizeColor(swatch);
    return color && (basePalette.includes(color) || customPalette.includes(color) || state.tray.includes(color)) ? color : null;
  }

  function readCustomPalette() {
    try {
      const stored = window.localStorage.getItem(CUSTOM_COLORS_KEY);
      if (stored === null) return [];
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeColor).filter(Boolean);
    } catch (error) {
      return [];
    }
  }

  function persistCustomPalette() {
    try {
      window.localStorage.setItem(CUSTOM_COLORS_KEY, JSON.stringify(customPalette));
    } catch (error) {
      window.alert('This color could not be saved for next time, but you can paint with it now.');
    }
  }

  function badgedSwatch(swatchButton, glyph, label, className, onActivate) {
    const wrap = document.createElement('span');
    wrap.className = 'swatch-wrap';
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = `swatch-badge ${className}`;
    badge.textContent = glyph;
    badge.setAttribute('aria-label', label);
    badge.addEventListener('click', onActivate);
    wrap.append(swatchButton, badge);
    return wrap;
  }

  function renderSwatches(container, colors, source) {
    container.replaceChildren();
    colors.forEach((color, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch';
      button.style.backgroundColor = color;
      button.dataset.color = color;
      button.dataset.source = source;
      button.dataset.index = String(index);
      const isCustom = source === 'palette' && index >= basePalette.length;
      const kind = isCustom ? 'Custom' : (source === 'palette' ? 'Base' : 'Mixed');
      const ordinal = isCustom ? index - basePalette.length + 1 : index + 1;
      button.setAttribute('aria-label', `${kind} color ${ordinal}`);
      button.setAttribute('aria-pressed', String(state.color === color));
      button.addEventListener('click', () => selectSwatch(color));
      if (isCustom) {
        container.append(badgedSwatch(button, '×', `Delete custom color ${ordinal}`, 'swatch-remove', () => removePaletteColor(color)));
      } else if (source === 'tray') {
        container.append(badgedSwatch(button, '+', `Keep mixed color ${ordinal} in the palette`, 'swatch-keep', () => addPaletteColor(color)));
      } else {
        container.append(button);
      }
    });
  }

  function syncPickerToggle() {
    const addButton = paletteContainer.querySelector('.add-color');
    if (addButton) addButton.setAttribute('aria-expanded', String(!pickerPanel.hidden));
  }

  function renderColorControls() {
    renderSwatches(paletteContainer, [...basePalette, ...customPalette], 'palette');
    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'add-color';
    addButton.textContent = '+';
    addButton.setAttribute('aria-label', 'Add a new color');
    addButton.addEventListener('click', () => {
      pickerPanel.hidden = !pickerPanel.hidden;
      syncPickerToggle();
      if (!pickerPanel.hidden) pickerPanel.scrollIntoView({ block: 'nearest' });
    });
    paletteContainer.append(addButton);
    syncPickerToggle();
    renderSwatches(trayContainer, state.tray, 'tray');
    applyBlobShapes();
  }

  function selectSwatch(swatch) {
    const color = resolveSwatch(swatch);
    if (!color) return false;
    state.color = color;
    let mixed = false;
    if (state.pendingMixColor === null) {
      state.pendingMixColor = color;
    } else {
      const mixedColor = mixColors(state.pendingMixColor, color);
      state.tray.push(mixedColor);
      state.color = mixedColor;
      state.pendingMixColor = null;
      mixed = true;
    }
    renderColorControls();
    if (mixed) {
      splatNewestSwatch(trayContainer);
      soundKit.plop();
    }
    return true;
  }

  function mixSwatches(firstSwatch, secondSwatch) {
    const first = resolveSwatch(firstSwatch);
    const second = resolveSwatch(secondSwatch);
    if (!first || !second) return null;
    state.pendingMixColor = null;
    selectSwatch(first);
    selectSwatch(second);
    return state.color;
  }

  function clearTray() {
    const activeWasTrayColor = state.tray.includes(state.color);
    state.tray = [];
    state.pendingMixColor = null;
    if (activeWasTrayColor) state.color = basePalette[0];
    renderColorControls();
  }

  function addPaletteColor(swatch) {
    const color = normalizeColor(swatch);
    if (!color) return false;
    if (!basePalette.includes(color) && !customPalette.includes(color)) {
      customPalette.push(color);
      persistCustomPalette();
    }
    // Adding behaves like tapping the new swatch fresh: no carried-over mix pick.
    state.pendingMixColor = null;
    selectSwatch(color);
    soundKit.plop();
    return true;
  }

  function removePaletteColor(swatch) {
    const color = normalizeColor(swatch);
    if (!color || !customPalette.includes(color)) return false;
    customPalette = customPalette.filter((kept) => kept !== color);
    persistCustomPalette();
    if (state.color === color) state.color = basePalette[0];
    if (state.pendingMixColor === color) state.pendingMixColor = null;
    renderColorControls();
    return true;
  }

  // The picker spectrum: full hue run left to right, white → pure color → black
  // top to bottom. Muted colors are deliberately unreachable — desaturating is
  // the mixing tray's job.
  function drawPickerSpectrum() {
    const spectrumContext = pickerSpectrum.getContext('2d', { willReadFrequently: true });
    const { width, height } = pickerSpectrum;
    const hueGradient = spectrumContext.createLinearGradient(0, 0, width, 0);
    for (let stop = 0; stop <= 12; stop += 1) {
      hueGradient.addColorStop(stop / 12, `hsl(${Math.round((stop / 12) * 360)}, 100%, 50%)`);
    }
    spectrumContext.fillStyle = hueGradient;
    spectrumContext.fillRect(0, 0, width, height);
    const lightGradient = spectrumContext.createLinearGradient(0, 0, 0, height);
    lightGradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    lightGradient.addColorStop(0.5, 'rgba(255, 255, 255, 0)');
    lightGradient.addColorStop(0.5, 'rgba(0, 0, 0, 0)');
    lightGradient.addColorStop(1, 'rgba(0, 0, 0, 1)');
    spectrumContext.fillStyle = lightGradient;
    spectrumContext.fillRect(0, 0, width, height);
  }

  let pickerColor = null;
  let pickerPointerActive = false;

  function samplePickerColor(event) {
    const rect = pickerSpectrum.getBoundingClientRect();
    const x = Math.max(0, Math.min(pickerSpectrum.width - 1, Math.round(((event.clientX - rect.left) / rect.width) * pickerSpectrum.width)));
    const y = Math.max(0, Math.min(pickerSpectrum.height - 1, Math.round(((event.clientY - rect.top) / rect.height) * pickerSpectrum.height)));
    const pixel = pickerSpectrum.getContext('2d').getImageData(x, y, 1, 1).data;
    pickerColor = `#${[pixel[0], pixel[1], pixel[2]].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
    pickerPreview.style.backgroundColor = pickerColor;
    pickerAddButton.disabled = false;
  }

  function closePicker() {
    pickerPanel.hidden = true;
    syncPickerToggle();
  }

  function setHardness(hardness) {
    const value = Number(hardness);
    if (!Number.isInteger(value) || value < 1 || value > 6) return false;
    state.hardness = value;
    renderBrushControls();
    return true;
  }

  function setSize(size) {
    const value = typeof size === 'string' ? size.toLowerCase() : '';
    // hasOwnProperty over Object.hasOwn: the latter needs iOS 15.4+.
    if (!Object.prototype.hasOwnProperty.call(sizePixels, value)) return false;
    state.size = value;
    renderBrushControls();
    return true;
  }

  function renderBrushControls() {
    hardnessControls.querySelectorAll('[data-hardness]').forEach((button) => {
      const active = Number(button.dataset.hardness) === state.hardness;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    sizeControls.querySelectorAll('[data-size]').forEach((button) => {
      const active = button.dataset.size === state.size;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    renderChips();
  }

  function clearCanvas() {
    context.save();
    context.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvasWidth, canvasHeight);
    context.restore();
    if (presentationReady) playWash(washOverlay);
  }

  // Undoable clear for the button and API; resizeCanvas keeps the raw clear so
  // window resizes never spam the undo stack.
  function clearCanvasWithUndo() {
    pushUndoSnapshot();
    // Clearing means the whole sheet, including regions the master holds
    // beyond the current view — nothing may reappear on a later grow.
    resetMaster();
    engineFor(mainSurface).reset();
    if (presentationReady) playWash(washOverlay);
  }

  function updateUndoButton() {
    if (undoButton) undoButton.disabled = undoStack.length === 0;
  }

  function pushUndoSnapshot() {
    if (canvas.width === 0 || canvas.height === 0) return;
    const snapshot = document.createElement('canvas');
    snapshot.width = canvas.width;
    snapshot.height = canvas.height;
    snapshot.getContext('2d').drawImage(canvas, 0, 0);
    undoStack.push(snapshot);
    let bytes = 0;
    for (let index = undoStack.length - 1; index >= 0; index -= 1) {
      bytes += undoStack[index].width * undoStack[index].height * 4;
      const depth = undoStack.length - index;
      // Bound by memory, not just count, so phone-sized budgets degrade depth
      // gracefully; the newest snapshot is always kept.
      if (depth > 1 && (depth > undoLimit || bytes > undoBudgetBytes)) {
        undoStack.splice(0, index + 1);
        break;
      }
    }
    updateUndoButton();
  }

  function undoCanvas() {
    const snapshot = undoStack.pop();
    updateUndoButton();
    if (!snapshot) return false;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(snapshot, 0, 0, canvas.width, canvas.height);
    context.restore();
    // Undo restores a dried painting: the sim rebuilds deposited pigment from
    // the snapshot image (full wet-state snapshots would cost tens of MB each).
    const engine = engineFor(mainSurface);
    engine.rehydrateFromCanvas();
    engine.render(true);
    return true;
  }

  function resizeCanvas() {
    const bounds = canvas.getBoundingClientRect();
    // A hidden canvas (library view hides the studio layout) measures 0×0;
    // resizing to that would destroy the painting. Keep the backing store and
    // remeasure when the layout comes back.
    if (bounds.width < 2 || bounds.height < 2) return;
    // A stroke can't meaningfully continue across a relayout, and a dropped
    // pointerup would otherwise leave it (and the brush sound) stuck open.
    cancelActiveStroke();
    // Capture into the master before the backing store changes; the master
    // never shrinks, so this is what makes shrinks non-destructive.
    writeMaster();
    const dpr = window.devicePixelRatio || 1;
    canvasWidth = Math.max(1, Math.round(bounds.width));
    canvasHeight = Math.max(1, Math.round(bounds.height));
    canvas.width = Math.round(canvasWidth * dpr);
    canvas.height = Math.round(canvasHeight * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    clearCanvas();
    // Restore from the master at CSS scale, top-left anchored — the same sheet
    // of paper, cropped by the current view rather than truncated for good.
    if (master.cssWidth && master.cssHeight) {
      context.drawImage(master.canvas, 0, 0, master.cssWidth, master.cssHeight);
    }
    // The engine rebuilds for the new backing-store size and rehydrates from
    // the restored image; the fresh render repaints the paper texture.
    engineFor(mainSurface).render(true);
  }

  function eventPoint(event) {
    const bounds = canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function handlePointerDown(event) {
    // Last touch wins: a down while another stroke is active means either a
    // lost pointerup (whose stale stroke would block painting forever — rapid
    // stroking on iOS drops ups) or an extra finger. Either way the old
    // stroke ends and the new one paints.
    if (activePointerId !== null) cancelActiveStroke();
    // Self-healing placement: if the canvas box has drifted from the tracked
    // CSS size or the backing store (a resize measured mid-rotation-animation,
    // or one we never saw), remeasure before mapping this touch. The master
    // buffer makes the extra resize lossless.
    const measured = canvas.getBoundingClientRect();
    const healDpr = window.devicePixelRatio || 1;
    if (Math.abs(measured.width - canvasWidth) > 1
      || Math.abs(measured.height - canvasHeight) > 1
      || Math.abs(canvas.width / healDpr - measured.width) > 2
      || Math.abs(canvas.height / healDpr - measured.height) > 2) {
      resizeCanvas();
    }
    activePointerId = event.pointerId;
    // Synthetic PointerEvents used by the test API are not always eligible
    // for capture, but should still exercise the same painting path.
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch (error) {
      // Real pointer capture is an interaction enhancement, not a paint gate.
    }
    livePressure = pointerPressure(event);
    previousPoint = { ...eventPoint(event), p: livePressure };
    state.pendingMixColor = null;
    const undoStarted = debugPanel.enabled() ? performance.now() : 0;
    pushUndoSnapshot();
    if (debugPanel.enabled()) debugPanel.strokeBegin(performance.now() - undoStarted);
    const engine = engineFor(mainSurface);
    engine.beginStroke(state.color, state.hardness, sizePixels[state.size], livePressure, effectiveWater(state.water), true, state.paint);
    engine.addStrokePoint(previousPoint.x, previousPoint.y, livePressure);
    startTicker();
    lastMoveTime = event.timeStamp;
    renderPressure();
    updateBrushCursor(event);
    spawnPaintSpecks({ canvas, lid: canvasLid, point: previousPoint, color: state.color });
  }

  function handlePointerMove(event) {
    updateBrushCursor(event);
    if (event.pointerId !== activePointerId || !previousPoint) return;
    const nextPoint = eventPoint(event);
    const distance = Math.hypot(nextPoint.x - previousPoint.x, nextPoint.y - previousPoint.y);
    const elapsed = event.timeStamp - lastMoveTime;
    livePressure = velocityAdjusted(pointerPressure(event), distance, elapsed);
    nextPoint.p = livePressure;
    if (debugPanel.enabled()) {
      const depositStarted = performance.now();
      engineFor(mainSurface).addStrokePoint(nextPoint.x, nextPoint.y, livePressure);
      debugPanel.addDepositTime(performance.now() - depositStarted);
    } else {
      engineFor(mainSurface).addStrokePoint(nextPoint.x, nextPoint.y, livePressure);
    }
    previousPoint = nextPoint;
    lastMoveTime = event.timeStamp;
    soundKit.brushMove(elapsed > 0 ? distance / elapsed : 0, livePressure, state.hardness);
    renderPressure();
  }

  function finishPointer(event) {
    if (event.pointerId !== activePointerId) return;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    endActiveStroke();
  }

  function endActiveStroke() {
    activePointerId = null;
    previousPoint = null;
    const engine = engineFor(mainSurface);
    engine.endStroke();
    if (debugPanel.enabled()) debugPanel.strokeEnd(engine.lastStroke());
    renderPressure();
    soundKit.brushEnd();
    hideBrushCursor();
  }

  // Safety net for strokes whose pointerup never arrives — iPadOS rotation
  // and app-switching can eat it, which left the brush sound looping and the
  // ticker pinned forever. A stroke that loses its pointer just ends.
  function cancelActiveStroke() {
    if (activePointerId === null) return;
    try {
      if (canvas.hasPointerCapture(activePointerId)) canvas.releasePointerCapture(activePointerId);
    } catch (error) {
      // Synthetic pointers can't always be released; ending the stroke is what matters.
    }
    endActiveStroke();
  }

  function getPixel(x, y) {
    const dpr = window.devicePixelRatio || 1;
    const sampleX = Math.max(0, Math.min(canvas.width - 1, Math.round(x * dpr)));
    const sampleY = Math.max(0, Math.min(canvas.height - 1, Math.round(y * dpr)));
    const pixel = context.getImageData(sampleX, sampleY, 1, 1).data;
    return { r: pixel[0], g: pixel[1], b: pixel[2], a: pixel[3] };
  }

  function paintStroke(points) {
    if (!Array.isArray(points) || points.length === 0) return;
    // Painting on the user's canvas ends a pending mix pick and is undoable.
    state.pendingMixColor = null;
    const debug = debugPanel.enabled();
    const undoStarted = debug ? performance.now() : 0;
    pushUndoSnapshot();
    if (debug) debugPanel.strokeBegin(performance.now() - undoStarted);
    const depositStarted = debug ? performance.now() : 0;
    paintStrokePath(mainSurface, points, state.color, state.hardness, sizePixels[state.size], effectivePressure(state.pressure), effectiveWater(state.water));
    if (debug) debugPanel.addDepositTime(performance.now() - depositStarted);
    engineFor(mainSurface).render();
    if (debug) debugPanel.strokeEnd(engineFor(mainSurface).lastStroke());
    startTicker();
  }

  const soundKit = createSoundKit();

  const slotStore = createSlotStore({
    container: document.querySelector('#save-slots'),
    canvas,
    context,
    storageKey: 'splotchbox.save-slots.v1',
    onBeforeDraw: pushUndoSnapshot,
    onAfterDraw() {
      // A loaded slot replaces the whole sheet — drop any off-view paint the
      // master held for the previous painting.
      resetMaster();
      // Loaded paintings come back dry; the sim rehydrates deposited pigment
      // from the image so new water can still lift and mingle with it.
      const engine = engineFor(mainSurface);
      engine.rehydrateFromCanvas();
      engine.render(true);
    },
    onRender: applyBlobShapes,
  });

  function exportFilename(now) {
    const pad = (value) => String(value).padStart(2, '0');
    return `splotchbox-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
      + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    // Revoke after the download has had a moment to grab the URL.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { mode: 'downloaded', name, size: blob.size, type: blob.type };
  }

  function shareBlob(blob, name) {
    const file = new File([blob], name, { type: 'image/png' });
    if (!(navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share)) {
      return Promise.resolve(downloadBlob(blob, name));
    }
    return navigator.share({ files: [file] }).then(
      () => ({ mode: 'shared', name, size: blob.size, type: blob.type }),
      (error) => (error && error.name === 'AbortError'
        ? { mode: 'canceled', name, size: blob.size, type: blob.type }
        : downloadBlob(blob, name)),
    );
  }

  const keepsakeOverlay = document.querySelector('#keepsake');
  const keepsakeImage = document.querySelector('#keepsake-image');
  const keepsakeShareButton = document.querySelector('#keepsake-share');
  const keepsakeDownloadButton = document.querySelector('#keepsake-download');
  const keepsakeCloseButton = document.querySelector('#keepsake-close');
  let keepsakeState = null;

  function closeKeepsake() {
    if (!keepsakeState) return;
    URL.revokeObjectURL(keepsakeState.url);
    keepsakeState = null;
    keepsakeImage.removeAttribute('src');
    keepsakeOverlay.hidden = true;
  }

  function openKeepsake(blob, name) {
    closeKeepsake();
    keepsakeState = { blob, name, url: URL.createObjectURL(blob) };
    keepsakeImage.src = keepsakeState.url;
    // The Share button only earns its spot where the share sheet exists.
    keepsakeShareButton.hidden = !(navigator.canShare
      && navigator.canShare({ files: [new File([blob], name, { type: 'image/png' })] }));
    keepsakeOverlay.hidden = false;
    return { mode: 'presented', name, size: blob.size, type: blob.type };
  }

  // The keepsake copy: full backing-store PNG. On touch devices it opens as a
  // plain <img> overlay, because a long-press on an image is the one path to
  // "Add to Photos" that iOS always offers — the share sheet only sometimes
  // lists Save Image, and Files/Drive is not where paintings belong. Share and
  // Download ride along as overlay buttons. Desktop downloads directly.
  // Resolves to what happened so agent checks can assert it.
  function saveToDevice() {
    return new Promise((resolve) => { canvas.toBlob(resolve, 'image/png'); }).then((blob) => {
      if (!blob) return { mode: 'failed', name: '', size: 0, type: '' };
      const name = exportFilename(new Date());
      if (window.matchMedia('(pointer: coarse)').matches) return openKeepsake(blob, name);
      return downloadBlob(blob, name);
    });
  }

  // Update nudge: home-screen web apps resume without reloading, so on every
  // return to the foreground we fetch our own index.html past the cache and
  // compare its deploy stamp to the running one. Untouched canvas → reload
  // straight into the new version; painting in progress → offer a toast that
  // saves to a slot before reloading, so an update can never eat a painting.
  const updateToast = document.querySelector('#update-toast');
  const versionTag = document.querySelector('.version-tag');
  let lastUpdateCheck = 0;

  function checkForUpdate() {
    if (!updateToast || !versionTag) return;
    const now = Date.now();
    if (now - lastUpdateCheck < 60 * 1000) return;
    lastUpdateCheck = now;
    fetch('index.html', { cache: 'no-store' })
      .then((response) => (response.ok ? response.text() : null))
      .then((html) => {
        if (!html) return;
        const fresh = html.match(/version-tag[^>]*>(v[^<]+)</);
        const running = versionTag.textContent.trim();
        if (!fresh || fresh[1] === running) return;
        if (undoStack.length === 0) {
          window.location.reload();
          return;
        }
        updateToast.hidden = false;
      })
      .catch(() => {
        // Offline or flaky network: stay quiet, try again next foreground.
      });
  }

  if (updateToast) {
    updateToast.addEventListener('click', () => {
      updateToast.disabled = true;
      slotStore.save().then((saved) => {
        if (saved) {
          window.location.reload();
          return;
        }
        // Save failed (its own alert already showed); keep the painting.
        updateToast.disabled = false;
      });
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkForUpdate();
  });
  window.setTimeout(checkForUpdate, 8000);

  // Entering or leaving the side-by-side workspace changes the canvas's CSS box
  // without a window resize. The backing store must follow immediately (or
  // clicks land at the stale scale, offset from the cursor) and once more after
  // the 340ms panel-arrive animation settles, since its transform skews
  // getBoundingClientRect measurements taken mid-flight.
  function scheduleCanvasRelayout() {
    resizeCanvas();
    window.setTimeout(() => {
      resizeCanvas();
      layoutSettled();
    }, 400);
  }

  const soundToggle = document.querySelector('#sound-toggle');

  function renderSoundToggle() {
    if (!soundToggle) return;
    soundToggle.textContent = soundKit.isEnabled() ? '🔊 Sound' : '🔇 Muted';
    soundToggle.setAttribute('aria-pressed', String(soundKit.isEnabled()));
  }

  if (soundToggle) {
    soundToggle.addEventListener('click', () => {
      soundKit.setEnabled(!soundKit.isEnabled());
      renderSoundToggle();
    });
  }

  canvas.addEventListener('pointerdown', handlePointerDown);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('pointerup', finishPointer);
  canvas.addEventListener('pointercancel', finishPointer);
  canvas.addEventListener('pointerenter', updateBrushCursor);
  canvas.addEventListener('pointerleave', hideBrushCursor);
  clearButton.addEventListener('click', clearCanvasWithUndo);
  if (undoButton) undoButton.addEventListener('click', undoCanvas);
  saveButton.addEventListener('click', () => { void slotStore.save(); });
  if (saveDeviceButton) saveDeviceButton.addEventListener('click', () => { void saveToDevice(); });
  keepsakeShareButton.addEventListener('click', () => {
    if (keepsakeState) void shareBlob(keepsakeState.blob, keepsakeState.name);
  });
  keepsakeDownloadButton.addEventListener('click', () => {
    if (keepsakeState) downloadBlob(keepsakeState.blob, keepsakeState.name);
  });
  keepsakeCloseButton.addEventListener('click', closeKeepsake);
  keepsakeOverlay.addEventListener('click', (event) => {
    if (event.target === keepsakeOverlay) closeKeepsake();
  });
  clearTrayButton.addEventListener('click', clearTray);
  pickerSpectrum.addEventListener('pointerdown', (event) => {
    pickerPointerActive = true;
    samplePickerColor(event);
  });
  pickerSpectrum.addEventListener('pointermove', (event) => {
    if (pickerPointerActive) samplePickerColor(event);
  });
  window.addEventListener('pointerup', () => { pickerPointerActive = false; });
  pickerAddButton.addEventListener('click', () => {
    if (!pickerColor) return;
    addPaletteColor(pickerColor);
    closePicker();
  });
  pickerCloseButton.addEventListener('click', closePicker);
  hardnessControls.addEventListener('click', (event) => {
    const button = event.target.closest('[data-hardness]');
    if (button) setHardness(button.dataset.hardness);
  });
  sizeControls.addEventListener('click', (event) => {
    const button = event.target.closest('[data-size]');
    if (button) setSize(button.dataset.size);
  });
  if (chipHardness) {
    chipHardness.addEventListener('click', () => setHardness(state.hardness % 6 + 1));
    chipSize.addEventListener('click', () => {
      const order = ['s', 'm', 'l'];
      setSize(order[(order.indexOf(state.size) + 1) % order.length]);
    });
    chipPressure.addEventListener('click', () => setPressure(nextChipStop(state.pressure, PRESSURE_CHIP_STOPS)));
    chipWater.addEventListener('click', () => setWater(nextChipStop(state.water, PERCENT_CHIP_STOPS)));
    chipPaint.addEventListener('click', () => setPaint(nextChipStop(state.paint, PERCENT_CHIP_STOPS)));
  }
  window.addEventListener('keydown', (event) => {
    const target = event.target;
    if (target instanceof Element && (target.matches('input, textarea, select') || target.isContentEditable)) return;
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undoCanvas();
      return;
    }
    if (/^[1-6]$/.test(event.key)) setHardness(event.key);
    // Live pressure control, usable mid-stroke: the next painted segment picks
    // up the new base pressure immediately.
    if (event.key === '[') setPressure(state.pressure - 0.05);
    if (event.key === ']') setPressure(state.pressure + 0.05);
    // Water and paint are loaded per dip: the next stroke carries the new load.
    if (event.key === ';') setWater(state.water - 0.05);
    if (event.key === "'") setWater(state.water + 0.05);
    if (event.key === ',') setPaint(state.paint - 0.05);
    if (event.key === '.') setPaint(state.paint + 0.05);
  });
  // iPadOS animates rotation and can fire resize while the layout is still
  // transitional; a single immediate measurement bakes in a stale size and
  // paints land offset from the finger. Measure now and again after settling.
  let resizeSettleTimer = null;
  window.addEventListener('resize', () => {
    resizeCanvas();
    if (resizeSettleTimer !== null) window.clearTimeout(resizeSettleTimer);
    resizeSettleTimer = window.setTimeout(() => {
      resizeSettleTimer = null;
      resizeCanvas();
    }, 450);
  });
  // Redundant with the canvas listeners in the normal case (finishPointer
  // gates on the active pointer id), but catches releases the canvas never
  // sees — capture lost mid-gesture, fingers lifted over other UI.
  window.addEventListener('pointerup', finishPointer);
  window.addEventListener('pointercancel', finishPointer);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelActiveStroke();
  });

  const api = {
    paintStroke,
    setHardness,
    setSize,
    setPressure,
    setWater,
    setPaint,
    getPixel,
    clearCanvas: clearCanvasWithUndo,
    undo: undoCanvas,
    save: () => slotStore.save(),
    saveToDevice,
    loadSlot: (index) => slotStore.load(index),
    deleteSlot: (index) => slotStore.remove(index),
    getSlots: () => slotStore.getAll(),
    selectSwatch,
    mix: mixSwatches,
    clearTray,
    addPaletteColor,
    removePaletteColor,
    getCustomColors: () => [...customPalette],
    mixColors,
    setSound(enabled) { soundKit.setEnabled(enabled); renderSoundToggle(); },
    debug: debugPanel.api,
    sim: {
      tick(count = 1) {
        const engine = engineFor(mainSurface);
        engine.tick(count);
        engine.render();
        return engine.stats();
      },
      dryAll() {
        const engine = engineFor(mainSurface);
        engine.dryAll();
        engine.render(true);
      },
      isActive: () => engineFor(mainSurface).isActive(),
      stats: () => engineFor(mainSurface).stats(),
    },
    getState() {
      return {
        ...state,
        pressureEffective: effectivePressure(state.pressure),
        waterEffective: effectiveWater(state.water),
        palette: [...basePalette],
        customPalette: [...customPalette],
        tray: [...state.tray],
        pendingMix: state.pendingMixColor,
        sound: soundKit.isEnabled(),
        mixGesture: 'Each swatch selection activates it; a second selection mixes the pending first pick with it.',
      };
    },
  };
  window.studio = api;

  drawPickerSpectrum();
  renderColorControls();
  renderBrushControls();
  renderPressure();
  renderWater();
  renderPaint();
  attachMeter('.pressure-panel:not(.water-panel):not(.paint-panel) .pressure-meter', setPressure);
  attachMeter('.water-meter', setWater);
  attachMeter('#paint-meter', setPaint);
  renderSoundToggle();
  slotStore.render();
  updateUndoButton();
  resizeCanvas();
  if (new URLSearchParams(window.location.search).get('debug') === '1') debugPanel.api.show();
  presentationReady = true;

  return {
    api,
    canvas,
    palette: basePalette,
    soundKit,
    mainSurface,
    scheduleRelayout: scheduleCanvasRelayout,
    setOnLayoutSettled(handler) {
      layoutSettled = typeof handler === 'function' ? handler : () => {};
    },
  };
}
