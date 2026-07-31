// Synthesized sound kit — no audio assets. A looping filtered-noise bed gives
// the brush its swish (gain and brightness follow speed, pressure, hardness);
// short envelopes cover mixing plops, step chimes, and the beauty fanfare.
// Everything no-ops until the first user gesture creates the AudioContext.

const storageKey = 'splotchbox.sound.v1';

export function createSoundKit() {
  let enabled = true;
  try {
    enabled = window.localStorage.getItem(storageKey) !== 'off';
  } catch (error) {
    // Storage unavailable: sound simply defaults on for the session.
  }

  let audioContext = null;
  let brushGain = null;
  let brushFilter = null;
  let unavailable = false;

  function ensureContext() {
    if (unavailable || audioContext) return audioContext;
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const noiseSeconds = 1.2;
      const buffer = audioContext.createBuffer(1, Math.floor(audioContext.sampleRate * noiseSeconds), audioContext.sampleRate);
      const data = buffer.getChannelData(0);
      for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
      const noise = audioContext.createBufferSource();
      noise.buffer = buffer;
      noise.loop = true;
      brushFilter = audioContext.createBiquadFilter();
      brushFilter.type = 'bandpass';
      brushFilter.frequency.value = 900;
      brushFilter.Q.value = 0.8;
      brushGain = audioContext.createGain();
      brushGain.gain.value = 0;
      noise.connect(brushFilter);
      brushFilter.connect(brushGain);
      brushGain.connect(audioContext.destination);
      noise.start();
    } catch (error) {
      unavailable = true;
      audioContext = null;
    }
    return audioContext;
  }

  function ready() {
    if (!enabled) return null;
    const context = ensureContext();
    if (!context) return null;
    if (context.state === 'suspended') void context.resume();
    return context;
  }

  function envelope(context, { type = 'sine', from, to, duration, volume = 0.12, delay = 0 }) {
    const startAt = context.currentTime + delay;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(from, startAt);
    if (to && to !== from) oscillator.frequency.exponentialRampToValueAtTime(to, startAt + duration);
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(volume, startAt + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.05);
  }

  return {
    isEnabled: () => enabled,
    setEnabled(next) {
      enabled = Boolean(next);
      try {
        window.localStorage.setItem(storageKey, enabled ? 'on' : 'off');
      } catch (error) {
        // Preference just won't persist.
      }
      if (!enabled && brushGain && audioContext) brushGain.gain.setTargetAtTime(0, audioContext.currentTime, 0.02);
    },
    // speed in px/ms roughly 0..3; pressure 0.15..1; hardness 1..6.
    brushMove(speed, pressure, hardness) {
      const context = ready();
      if (!context || !brushGain) return;
      const wetness = (7 - hardness) / 6;
      const loudness = Math.min(0.09, (0.015 + Math.min(speed, 2.2) * 0.035) * (0.5 + pressure * 0.8));
      brushGain.gain.setTargetAtTime(loudness, context.currentTime, 0.03);
      brushFilter.frequency.setTargetAtTime(600 + hardness * 260 + Math.min(speed, 2.2) * 320, context.currentTime, 0.05);
      brushFilter.Q.setTargetAtTime(0.6 + (1 - wetness) * 1.6, context.currentTime, 0.08);
    },
    brushEnd() {
      if (!brushGain || !audioContext) return;
      brushGain.gain.setTargetAtTime(0, audioContext.currentTime, 0.06);
    },
    plop() {
      const context = ready();
      if (!context) return;
      envelope(context, { type: 'sine', from: 340, to: 120, duration: 0.18, volume: 0.14 });
    },
    chime() {
      const context = ready();
      if (!context) return;
      envelope(context, { type: 'triangle', from: 659, duration: 0.22, volume: 0.06 });
      envelope(context, { type: 'triangle', from: 784, duration: 0.28, volume: 0.05, delay: 0.09 });
    },
    fanfare() {
      const context = ready();
      if (!context) return;
      [523, 659, 784, 1047].forEach((frequency, index) => {
        envelope(context, { type: 'triangle', from: frequency, duration: 0.34, volume: 0.07, delay: index * 0.11 });
      });
    },
  };
}
