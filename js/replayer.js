// The step replayer owns deterministic rendering of an episode onto the
// reference surface: same episode JSON, same step K, same pixels — with
// animation timing layered on top but never changing the final render.
//
// Canonical schedule for the fluid engine: each step deposits its strokes
// (wet, so strokes within a step mingle), runs a fixed settle budget of sim
// ticks for blooms and edges to develop, then force-dries before the next
// step. Tick counts derive from episode data alone, never the clock.

import { paintStrokePath, sizePixels } from './brush.js';
import { engineFor } from './fluid.js';
import { reducedMotion } from './juice.js';

const SETTLE_TICKS_PER_STEP = 90;

export function createReplayer(surface) {
  const { canvas } = surface;
  let animationToken = 0;
  let speed = 'normal';

  function clear() {
    engineFor(surface).reset();
  }

  // Episodes store normalized coordinates and s/m/l sizes; map them onto the
  // reference canvas so replays scale with the viewer.
  function mapStroke(stroke) {
    const scale = Math.min(canvas.width, canvas.height) / 400;
    return {
      ...stroke,
      size: sizePixels[stroke.size] * scale,
      points: stroke.points.map((point) => ({ ...point, x: point.x * canvas.width, y: point.y * canvas.height })),
    };
  }

  function renderToStep(episode, stepIndex) {
    const engine = engineFor(surface);
    engine.reset();
    if (!episode) return;
    const lastStep = Math.min(stepIndex, episode.steps.length - 1);
    for (let index = 0; index <= lastStep; index += 1) {
      episode.steps[index].strokes.forEach((stroke) => {
        const mapped = mapStroke(stroke);
        paintStrokePath(surface, mapped.points, mapped.color, mapped.hardness, mapped.size);
      });
      engine.tick(SETTLE_TICKS_PER_STEP);
      engine.dryAll();
    }
    engine.render(true);
  }

  function cancelAnimation() {
    animationToken += 1;
  }

  function animateStep(episode, stepIndex, onSettled) {
    const token = ++animationToken;
    if (reducedMotion.matches || !episode || stepIndex < 0) {
      renderToStep(episode, stepIndex);
      if (onSettled) onSettled();
      return;
    }
    renderToStep(episode, stepIndex - 1);
    const engine = engineFor(surface);
    const tasks = episode.steps[stepIndex].strokes.flatMap((stroke) => {
      const mapped = mapStroke(stroke);
      if (mapped.points.length === 1) return [{ mapped, points: mapped.points }];
      return mapped.points.slice(1).map((point, index) => ({ mapped, points: [mapped.points[index], point] }));
    });
    let taskIndex = 0;
    const drawNext = () => {
      if (token !== animationToken) return;
      if (taskIndex >= tasks.length) {
        // Normalize onto the canonical schedule so scrubbing away and back
        // reproduces exactly this frame.
        renderToStep(episode, stepIndex);
        if (onSettled) onSettled();
        return;
      }
      const task = tasks[taskIndex];
      paintStrokePath(surface, task.points, task.mapped.color, task.mapped.hardness, task.mapped.size);
      engine.tick(2);
      engine.render();
      taskIndex += 1;
      window.setTimeout(drawNext, speed === 'fast' ? 16 : 54);
    };
    drawNext();
  }

  function getPixel(x, y) {
    const sampleX = Math.max(0, Math.min(canvas.width - 1, Math.round(x)));
    const sampleY = Math.max(0, Math.min(canvas.height - 1, Math.round(y)));
    const pixel = surface.context.getImageData(sampleX, sampleY, 1, 1).data;
    return { r: pixel[0], g: pixel[1], b: pixel[2], a: pixel[3] };
  }

  return {
    clear,
    renderToStep,
    animateStep,
    cancelAnimation,
    getPixel,
    getSpeed: () => speed,
    setSpeed(nextSpeed) { speed = nextSpeed; },
    canvas,
  };
}
