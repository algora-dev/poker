/**
 * AudioToggle — combined sound + notification toggle, with two layouts:
 *
 *   variant="compact"  : a single small icon button. Click cycles
 *                        through: both on -> sound only -> all off -> all on.
 *                        Used in the table header beside Leave Table.
 *
 *   variant="settings" : two labelled toggles. Used on the account page.
 *
 * The state is read from / written to localStorage via audioPreferences,
 * so any change here is immediately honoured by playTurnNotification,
 * playCheckSound, and showTurnNotification.
 */

import { useEffect, useState } from 'react';
import {
  getAudioPrefs,
  setSoundEnabled,
  setNotifyEnabled,
  subscribeAudioPrefs,
  type AudioPrefs,
} from '../utils/audioPreferences';

interface Props {
  variant?: 'compact' | 'settings';
  className?: string;
}

export function AudioToggle({ variant = 'compact', className }: Props) {
  const [prefs, setPrefs] = useState<AudioPrefs>(() => getAudioPrefs());

  useEffect(() => {
    return subscribeAudioPrefs(setPrefs);
  }, []);

  if (variant === 'settings') {
    return (
      <div className={className}>
        <ToggleRow
          label="Sound effects"
          description="Turn-alert ding and check knock"
          checked={prefs.sound}
          onChange={setSoundEnabled}
        />
        <ToggleRow
          label="Desktop notifications"
          description="Popup when it's your turn (browser permission required)"
          checked={prefs.notify}
          onChange={setNotifyEnabled}
        />
      </div>
    );
  }

  // compact: single button cycles all-on -> sound-only -> all-off
  const stateLabel = prefs.sound && prefs.notify
    ? 'both'
    : prefs.sound
    ? 'sound'
    : prefs.notify
    ? 'notify'
    : 'off';

  const cycle = () => {
    // Cycle: both-on -> sound-only (no popups) -> all-off -> both-on
    if (prefs.sound && prefs.notify) {
      setNotifyEnabled(false);
    } else if (prefs.sound && !prefs.notify) {
      setSoundEnabled(false);
    } else {
      setSoundEnabled(true);
      setNotifyEnabled(true);
    }
  };

  const allOn = prefs.sound && prefs.notify;
  const allOff = !prefs.sound && !prefs.notify;

  const title =
    stateLabel === 'both'
      ? 'Sound + notifications on (click to mute popups)'
      : stateLabel === 'sound'
      ? 'Sound only (click to mute all)'
      : stateLabel === 'notify'
      ? 'Notifications only (click to mute all)'
      : 'All audio + notifications muted (click to enable)';

  return (
    <button
      type="button"
      onClick={cycle}
      title={title}
      aria-label={title}
      className={`inline-flex items-center justify-center w-8 h-8 rounded-lg border transition active:scale-[0.95] ${className ?? ''}`}
      style={{
        background: 'rgba(255,255,255,0.04)',
        borderColor: allOff
          ? 'rgba(239, 68, 68, 0.3)'
          : 'rgba(255,255,255,0.1)',
        color: allOn ? '#12ceec' : allOff ? '#ef4444' : '#facc15',
      }}
    >
      {allOff ? (
        // mute icon
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <line x1="23" y1="9" x2="17" y2="15" />
          <line x1="17" y1="9" x2="23" y2="15" />
        </svg>
      ) : (
        // speaker on icon
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          {allOn && <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />}
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
        </svg>
      )}
    </button>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      className="flex items-center justify-between gap-4 py-3 cursor-pointer"
      style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
    >
      <div>
        <div className="text-sm font-medium text-white">{label}</div>
        {description && (
          <div className="text-xs text-gray-400 mt-0.5">{description}</div>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="relative inline-flex h-6 w-11 shrink-0 rounded-full transition"
        style={{
          background: checked ? '#12ceec' : 'rgba(255,255,255,0.15)',
        }}
      >
        <span
          className="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform"
          style={{ transform: checked ? 'translateX(20px)' : 'translateX(0)' }}
        />
      </button>
    </label>
  );
}
