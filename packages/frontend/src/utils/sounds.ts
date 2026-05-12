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
