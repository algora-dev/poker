// Global audio context (initialized on first user interaction)
import { getAudioPrefs } from './audioPreferences';
let audioContext: AudioContext | null = null;

/**
 * Initialize audio context (call on first user click)
 */
export function initAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
}

/**
 * Play notification sound when it's player's turn
 */
export function playTurnNotification() {
  try {
    if (!getAudioPrefs().sound) return;
    initAudioContext();
    if (!audioContext) return;
    
    // Create a simple "ding" sound
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    // Frequency and timing for a pleasant "ding"
    oscillator.frequency.value = 800; // A5 note
    oscillator.type = 'sine';
    
    // Envelope (fade out)
    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
    
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.5);
  } catch (error) {
    console.warn('Could not play sound:', error);
  }
}

/**
 * Urgent alert when turn timer enters the warning window (<=7s).
 * Three rapid descending tones - distinctly different from the gentle
 * "ding" of playTurnNotification so the player knows they're nearly out
 * of time without having to look at the clock. Synthesized so we don't
 * ship an audio asset.
 */
export function playUrgentTurnAlert() {
  try {
    const p = getAudioPrefs();
    if (!p.sound || !p.urgentAlert) return;
    initAudioContext();
    if (!audioContext) return;

    // Three short urgent beeps, descending pitch.
    const beeps = [
      { freq: 1200, start: 0.00, duration: 0.12 },
      { freq: 950,  start: 0.18, duration: 0.12 },
      { freq: 750,  start: 0.36, duration: 0.20 },
    ];
    for (const b of beeps) {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.connect(gain);
      gain.connect(audioContext.destination);
      osc.type = 'square'; // harsher than the sine "ding"
      osc.frequency.value = b.freq;
      const t0 = audioContext.currentTime + b.start;
      gain.gain.setValueAtTime(0.0, t0);
      gain.gain.linearRampToValueAtTime(0.22, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + b.duration);
      osc.start(t0);
      osc.stop(t0 + b.duration);
    }
  } catch (error) {
    console.warn('Could not play urgent alert:', error);
  }
}

/**
 * Soft "deal" sound for each card flicked to a seat at hand start.
 * Very short, slightly different per call so a 4-handed deal feels
 * like a real shuffle/deal rather than the same beep 8 times.
 */
export function playDealSound(variant = 0) {
  try {
    if (!getAudioPrefs().sound) return;
    initAudioContext();
    if (!audioContext) return;

    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.type = 'triangle';
    // Subtle pitch variation per card so the deal doesn't sound robotic.
    const baseFreq = 1800 + ((variant % 4) * 80);
    osc.frequency.setValueAtTime(baseFreq, audioContext.currentTime);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.6, audioContext.currentTime + 0.08);

    gain.gain.setValueAtTime(0.0, audioContext.currentTime);
    gain.gain.linearRampToValueAtTime(0.10, audioContext.currentTime + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.09);

    osc.start(audioContext.currentTime);
    osc.stop(audioContext.currentTime + 0.10);
  } catch (error) {
    console.warn('Could not play deal sound:', error);
  }
}

/**
 * Request browser notification permission
 */
export async function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

/**
 * Show desktop notification
 */
export function showTurnNotification() {
  if (!getAudioPrefs().notify) return;
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('Your Turn!', {
      body: 'It\'s your turn to act in the poker game',
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      tag: 'poker-turn',
      renotify: true,
    });
  }
}
