// Color math shared by the brush engine, mixing tray, replayer, and photo study.

export function normalizeColor(color) {
  if (typeof color !== 'string') return null;
  const candidate = color.startsWith('#') ? color : `#${color}`;
  return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate.toLowerCase() : null;
}

export function hexToRgb(color) {
  const hex = color.slice(1);
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('')}`;
}

export function blendColor(fromColor, towardColor, amount) {
  const from = hexToRgb(fromColor);
  const toward = hexToRgb(towardColor);
  return rgbToHex({
    r: from.r + (toward.r - from.r) * amount,
    g: from.g + (toward.g - from.g) * amount,
    b: from.b + (toward.b - from.b) * amount,
  });
}

// Subtractive pigment mixing: multiplying channels darkens the way layered
// paint does, so yellow + blue reads green instead of an RGB-average gray,
// and the tray agrees with the wet-on-wet canvas blend.
export function mixColors(colorA, colorB) {
  const first = hexToRgb(colorA);
  const second = hexToRgb(colorB);
  return rgbToHex({
    r: (first.r * second.r) / 255,
    g: (first.g * second.g) / 255,
    b: (first.b * second.b) / 255,
  });
}

export function colorWithAlpha(color, alpha) {
  const { r, g, b } = hexToRgb(color);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function darkenColor(color, amount) {
  const { r, g, b } = hexToRgb(color);
  return rgbToHex({ r: r * (1 - amount), g: g * (1 - amount), b: b * (1 - amount) });
}

// Perception-weighted distance; good enough for palette matching.
export function colorDistance(colorA, colorB) {
  const a = hexToRgb(colorA);
  const b = hexToRgb(colorB);
  return Math.sqrt(2 * (a.r - b.r) ** 2 + 4 * (a.g - b.g) ** 2 + 3 * (a.b - b.b) ** 2);
}

const namedColors = [
  ['soft red', '#ef5350'], ['rosy pink', '#f48fb1'], ['violet', '#ba68c8'],
  ['periwinkle', '#7986cb'], ['sky blue', '#338bd5'], ['sea green', '#4db6ac'],
  ['leaf green', '#81c784'], ['spring green', '#c5d65a'], ['sunny yellow', '#ffd54f'],
  ['warm orange', '#ffb74d'], ['earthy brown', '#a1887f'], ['slate gray', '#455a64'],
  ['deep brown', '#4e342e'], ['midnight blue', '#26344c'], ['cream', '#fff3d6'],
  ['pale blue', '#cfe5f2'], ['blush', '#f6d7d2'], ['charcoal', '#2f2f33'],
  ['moss', '#5d7a4a'], ['sand', '#e0c39a'],
];

export function nearestColorName(color) {
  let best = namedColors[0][0];
  let bestDistance = Infinity;
  for (const [name, hex] of namedColors) {
    const distance = colorDistance(color, hex);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }
  return best;
}
