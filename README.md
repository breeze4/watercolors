# Splotchbox

A browser watercolor studio. Paint with a wet brush on wet paper: pigment blooms,
edges bleed, colors mix in the tray the way real paint does. No accounts, no
uploads, no build step — it is a page and a pile of ES modules.

Live: https://breeze4.github.io/watercolors/

## What's in it

- A fluid paint engine — wet-into-wet diffusion, pigment granulation, drying edges.
- Brush controls for hardness, size, pressure, water, and paint pickup.
- A mixing tray: drop two colors together and keep what comes out.
- Undo, clear, and save slots that live in your browser's local storage.
- Sound that follows the brush, toggleable.

## Running it locally

Everything is static, so any static file server works. From the repo root:

```
python3 -m http.server 8040
```

Then open http://localhost:8040/. Opening `index.html` straight from the
filesystem will not work — ES modules need a real origin.

## Layout

```
index.html      studio markup
styles.css      studio styles
js/main.js      entry point
js/studio.js    studio assembly: state, DOM wiring, input, undo, slots, meters
js/fluid.js     the paint/water simulation
js/brush.js     stroke geometry and pressure
js/color.js     mixing, naming, conversion
js/audio.js     brush sounds
js/juice.js     splats, confetti, wash animations
js/slots.js     local-storage save slots
js/replayer.js  deterministic stroke playback
js/rng.js       seeded noise
```

A separate private repo adds paint-along episodes on top of this app; it serves
these same files unmodified, so nothing here depends on it.

## Publishing

`.github/workflows/pages.yml` publishes the repo root to GitHub Pages on every
push to `main` — no build, no manual step. `.nojekyll` keeps Pages from running
the files through Jekyll.

## License

MIT — see [LICENSE](LICENSE).
