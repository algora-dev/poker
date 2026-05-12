/**
 * audioPreferences — single source of truth for the table-audio +
 * desktop-notification toggles.
 *
 * Stored in localStorage so it survives reloads. The values are read
 * synchronously by playTurnNotification / playCheckSound /
 * showTurnNotification so every emit honours the current setting
 * without prop drilling.
 *
 * UI surfaces:
 *   - Top-right toggle on GameRoom (subtle icon, next to Leave Table)
 *   - Account/Profile settings page (labelled toggles)
 *
 * Default: both ON, so existing behaviour is unchanged for users who
 * have never visited the toggle.
 */

const KEY_SOUND = 'poker.audio.sound';
const KEY_NOTIFY = 'poker.audio.notify';

export interface AudioPrefs {
  sound: boolean;
  notify: boolean;
}

type Listener = (prefs: AudioPrefs) => void;
const listeners = new Set<Listener>();

function read(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === '1' || raw === 'true';
  } catch {
    return fallback;
  }
}

function write(key: string, val: boolean) {
  try {
    localStorage.setItem(key, val ? '1' : '0');
  } catch {
    // Storage may be disabled (private mode etc.) — preferences just
    // won't persist. Still fire listeners so the UI updates.
  }
}

export function getAudioPrefs(): AudioPrefs {
  return {
    sound: read(KEY_SOUND, true),
    notify: read(KEY_NOTIFY, true),
  };
}

export function setSoundEnabled(v: boolean) {
  write(KEY_SOUND, v);
  fire();
}

export function setNotifyEnabled(v: boolean) {
  write(KEY_NOTIFY, v);
  fire();
}

export function subscribeAudioPrefs(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function fire() {
  const prefs = getAudioPrefs();
  for (const fn of listeners) {
    try {
      fn(prefs);
    } catch {
      // ignore — one bad listener shouldn't break the rest
    }
  }
}
