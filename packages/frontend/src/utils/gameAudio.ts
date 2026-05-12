/**
 * Simple game sound effects using Web Audio API.
 * No external files needed — synthesized on the fly.
 */

import { getAudioPrefs } from './audioPreferences';

let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

/** Knock-knock sound for check action */
export function playCheckSound() {
  try {
    if (!getAudioPrefs().sound) return;
    const ctx = getCtx();
    const now = ctx.currentTime;

    // First knock
    const knock1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    knock1.connect(gain1);
    gain1.connect(ctx.destination);
    knock1.frequency.value = 400;
    gain1.gain.setValueAtTime(0.25, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    knock1.start(now);
    knock1.stop(now + 0.08);

    // Second knock (slightly higher, slight delay)
    const knock2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    knock2.connect(gain2);
    gain2.connect(ctx.destination);
    knock2.frequency.value = 450;
    gain2.gain.setValueAtTime(0.2, now + 0.12);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    knock2.start(now + 0.12);
    knock2.stop(now + 0.2);
  } catch (_) {}
}
