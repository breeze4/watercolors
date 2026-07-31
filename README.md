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

The tiny stamp in the app's bottom-right corner (`.version-tag` in `index.html`)
is rewritten at commit time by a local `pre-commit` git hook (machine-local, in
`.git/hooks/`), so a device shows at a glance which deploy it is running —
useful when a home-screen shortcut is serving cached files. If you clone fresh
and want stamping, recreate the hook: it seds the tag to `v$(date +%Y-%m-%d.%H%M)`
and `git add`s `index.html`.

Every commit must state its version string (`vYYYY-MM-DD.HHMM`) in the commit
message, and an agent committing on the owner's behalf must also report that
string in its chat reply, so a phone showing its corner stamp can be matched to
a deploy without digging. The hook writes the stamp during the commit, so
compute it first with the same format, put it in the message, and verify
afterward that the message matches what landed in `index.html` (a minute
boundary can make them differ — if so, `git commit --amend --no-verify` the
message; `--no-verify` so the hook doesn't restamp and reopen the gap).

## License

MIT — see [LICENSE](LICENSE).
