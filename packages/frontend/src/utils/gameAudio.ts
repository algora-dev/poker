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

/**
 * Short white-noise burst with a sweeping low-pass filter — sounds like
 * a card sliding across felt. Used by DealAnimation in place of the
 * earlier synth-beep "dealSound". Variant changes filter sweep timing
 * slightly so a sequence of cards doesn't sound robotic.
 */
export function playDealSlideSound(variant = 0) {
  try {
    if (!getAudioPrefs().sound) return;
    const ctx = getCtx();
    const now = ctx.currentTime;

    const bufferSize = Math.floor(ctx.sampleRate * 0.12);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.6;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    // Sweep the cutoff down so the noise has a soft "shhhk" tail.
    const startCutoff = 3200 + (variant % 4) * 150;
    filter.frequency.setValueAtTime(startCutoff, now);
    filter.frequency.exponentialRampToValueAtTime(700, now + 0.10);
    filter.Q.value = 1.2;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.11);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    noise.start(now);
    noise.stop(now + 0.12);
  } catch (_) {}
}

/**
 * Soft thud + paper sliding: fold sound. Heard by everyone at the table
 * when any player folds.
 */
export function playFoldSound() {
  try {
    if (!getAudioPrefs().sound) return;
    const ctx = getCtx();
    const now = ctx.currentTime;

    // Low thud (cards hitting felt)
    const osc = ctx.createOscillator();
    const oGain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(90, now + 0.10);
    oGain.gain.setValueAtTime(0.25, now);
    oGain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    osc.connect(oGain);
    oGain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.15);

    // Brief noise tail (paper slide)
    const bSize = Math.floor(ctx.sampleRate * 0.08);
    const b = ctx.createBuffer(1, bSize, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < bSize; i++) d[i] = (Math.random() * 2 - 1) * 0.4;
    const n = ctx.createBufferSource();
    n.buffer = b;
    const nf = ctx.createBiquadFilter();
    nf.type = 'lowpass';
    nf.frequency.value = 1500;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.0, now + 0.04);
    nGain.gain.linearRampToValueAtTime(0.10, now + 0.05);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    n.connect(nf);
    nf.connect(nGain);
    nGain.connect(ctx.destination);
    n.start(now + 0.04);
    n.stop(now + 0.13);
  } catch (_) {}
}

/**
 * Chips dropping / clinking: bet & raise sound. Heard by everyone.
 * A handful of short metallic clicks at random timing within ~180ms.
 */
export function playBetSound() {
  try {
    if (!getAudioPrefs().sound) return;
    const ctx = getCtx();
    const now = ctx.currentTime;
    const ticks = 5;
    for (let i = 0; i < ticks; i++) {
      const t0 = now + i * 0.035 + (Math.random() * 0.015);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      const freq = 1800 + Math.random() * 800;
      osc.frequency.setValueAtTime(freq, t0);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.7, t0 + 0.05);
      gain.gain.setValueAtTime(0.0, t0);
      gain.gain.linearRampToValueAtTime(0.12, t0 + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.06);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.07);
    }
  } catch (_) {}
}

/**
 * Two soft chip clicks: call sound. Heard by everyone. Distinct from
 * Bet/Raise (which is a bigger cascade).
 */
export function playCallSound() {
  try {
    if (!getAudioPrefs().sound) return;
    const ctx = getCtx();
    const now = ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const t0 = now + i * 0.06;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1500 + i * 100, t0);
      gain.gain.setValueAtTime(0.0, t0);
      gain.gain.linearRampToValueAtTime(0.14, t0 + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.08);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.09);
    }
  } catch (_) {}
}

/**
 * Triumphant 4-note ascending chime: winning sound. Plays only for the
 * winning player (callsite gates by userId === winnerId).
 */
export function playWinSound() {
  try {
    if (!getAudioPrefs().sound) return;
    const ctx = getCtx();
    const now = ctx.currentTime;
    // C5 → E5 → G5 → C6 (major arpeggio)
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, i) => {
      const t0 = now + i * 0.11;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.0, t0);
      gain.gain.linearRampToValueAtTime(0.20, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.36);
    });
  } catch (_) {}
}

/**
 * Descending sigh: losing sound. Plays only for the loser when they
 * lose at showdown OR run out of chips and can no longer play.
 */
export function playLoseSound() {
  try {
    if (!getAudioPrefs().sound) return;
    const ctx = getCtx();
    const now = ctx.currentTime;
    // G4 → E4 → C4 (descending minor)
    const notes = [392.0, 329.63, 261.63];
    notes.forEach((freq, i) => {
      const t0 = now + i * 0.18;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.0, t0);
      gain.gain.linearRampToValueAtTime(0.14, t0 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.50);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1200;
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.52);
    });
  } catch (_) {}
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
