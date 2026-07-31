// Presentation helpers deliberately stay outside the paint, mix, and storage
// engines. They decorate already-complete state changes without affecting them.

export const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const blobShapeCount = 5;

export function applyBlobShapes() {
  document.querySelectorAll('.swatch, button, .save-slot img').forEach((element, index) => {
    for (let shape = 0; shape < blobShapeCount; shape += 1) {
      element.classList.remove(`blob-shape-${shape}`);
    }
    element.classList.add(`blob-shape-${index % blobShapeCount}`);
  });
}

export function playWash(washOverlay) {
  if (!washOverlay || reducedMotion.matches) return;
  washOverlay.classList.remove('is-washing');
  void washOverlay.offsetWidth;
  washOverlay.classList.add('is-washing');
}

export function splatNewestSwatch(container) {
  const swatch = container.lastElementChild;
  if (!swatch || reducedMotion.matches) return;
  swatch.classList.remove('is-splatting');
  void swatch.offsetWidth;
  swatch.classList.add('is-splatting');
}

// A celebratory shower of paint blobs. Purely decorative: elements clean
// themselves up and reduced-motion users get none of it.
export function confettiBurst(container) {
  if (!container || reducedMotion.matches) return;
  const colors = ['#ef5350', '#f48fb1', '#ba68c8', '#338bd5', '#4db6ac', '#81c784', '#ffd54f', '#ffb74d'];
  for (let index = 0; index < 56; index += 1) {
    const blob = document.createElement('i');
    blob.className = `confetti-blob blob-shape-${index % blobShapeCount}`;
    blob.setAttribute('aria-hidden', 'true');
    blob.style.left = `${Math.random() * 100}%`;
    blob.style.setProperty('--confetti-color', colors[index % colors.length]);
    blob.style.setProperty('--confetti-size', `${6 + Math.random() * 10}px`);
    blob.style.setProperty('--confetti-drift', `${(Math.random() - 0.5) * 160}px`);
    blob.style.setProperty('--confetti-spin', `${(Math.random() - 0.5) * 720}deg`);
    blob.style.animationDelay = `${Math.random() * 0.7}s`;
    blob.style.animationDuration = `${1.6 + Math.random() * 1.4}s`;
    blob.addEventListener('animationend', () => blob.remove(), { once: true });
    container.append(blob);
    window.setTimeout(() => blob.remove(), 4200);
  }
}

export function spawnPaintSpecks({ canvas, lid, point, color }) {
  if (!lid || reducedMotion.matches) return;
  const canvasBounds = canvas.getBoundingClientRect();
  const lidBounds = lid.getBoundingClientRect();
  const originX = canvasBounds.left - lidBounds.left + point.x;
  const originY = canvasBounds.top - lidBounds.top + point.y;
  const offsets = [[-13, -16, 6], [15, -10, 5], [19, 12, 4], [-20, 10, 4]];
  offsets.forEach(([x, y, size], index) => {
    const speck = document.createElement('i');
    speck.className = `paint-speck blob-shape-${index % blobShapeCount}`;
    speck.setAttribute('aria-hidden', 'true');
    speck.style.left = `${originX + x}px`;
    speck.style.top = `${originY + y}px`;
    speck.style.setProperty('--speck-size', `${size}px`);
    speck.style.setProperty('--speck-color', color);
    speck.style.setProperty('--speck-x', `${x * 1.6}px`);
    speck.style.setProperty('--speck-y', `${y * 1.7}px`);
    speck.addEventListener('animationend', () => speck.remove(), { once: true });
    lid.append(speck);
    window.setTimeout(() => speck.remove(), 1500);
  });
}
