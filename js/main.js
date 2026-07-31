// Entry point. The studio is the whole app on a static host; where a Splotchbox
// backend answers, the episode layer loads on top of it.

import { createStudio } from './studio.js';

const studio = createStudio();

// Relative on purpose: the public build is served from a repository
// subdirectory, where a leading slash would probe the wrong path entirely.
// A backend-free host answers 404 here and the studio just stands alone —
// that one failed request is the only trace the episode layer leaves behind.
async function loadEpisodeLayer() {
  try {
    const response = await fetch('api/health');
    if (!response.ok) return;
    const { initEpisodes } = await import('./episodes.js');
    initEpisodes(studio);
  } catch (error) {
    // No backend, or the episode layer failed to load: the studio is complete
    // without it, so there is nothing to recover and nothing to announce.
  }
}

void loadEpisodeLayer();
