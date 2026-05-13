/**
 * TurnTimer — countdown display + browser-edge alert glow.
 *
 * The backend sets `Hand.turnStartedAt` whenever the turn advances and
 * has a 17s timeout (TURN_TIMEOUT_MS, was 30s pre-2026-05-13). We mirror
 * that locally for the UI so players can see how much time they have left
 * without waiting for the server `game:turn-warning` event.
 *
 * Behaviour:
 *   - Shows a small "Xs" pill near the active player at all times.
 *   - When seconds remaining <= 7 AND it is the LOCAL user's turn:
 *       * Pulses a purple/pink/cyan glow around the entire viewport edge.
 *       * Shows a large central countdown.
 *       * Plays a distinct "urgent" 3-tone alert ONCE (when the alert
 *         window opens, not every second).
 *   - Visible to spectators too (they see the same pill, no glow/audio).
 *
 * Drift handling: we don't rely on the user's clock being aligned with
 * the server. Instead, on every render we re-evaluate
 * (Date.now() - new Date(turnStartedAt).getTime()) and clamp. The
 * pill simply ticks once per second via setInterval.
 */

import { useEffect, useRef, useState } from 'react';
import { playUrgentTurnAlert } from '../utils/sounds';

interface Props {
  /** ISO timestamp the current turn began (from server gameState). */
  turnStartedAt: string | null;
  /** Whether the local user is the active actor. Controls glow. */
  isMyTurn: boolean;
  /** Total turn duration in ms (server default 30s). */
  totalMs?: number;
  /** Show large countdown + glow when remaining <= this many seconds. */
  alertAtSeconds?: number;
}

export function TurnTimer({
  turnStartedAt,
  isMyTurn,
  totalMs = 17_000,
  alertAtSeconds = 7,
}: Props) {
  const [now, setNow] = useState(() => Date.now());
  // Track whether we've already fired the urgent alert for the current
  // turn so it only plays once per turn (when the alert window opens),
  // not every render tick during the warning window.
  const alertFiredForTurn = useRef<string | null>(null);

  useEffect(() => {
    // 250ms tick so the seconds digit feels responsive but we don't
    // burn cycles. Cleanup on unmount or when turnStartedAt changes.
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [turnStartedAt]);

  // Reset the alert-fired marker whenever the turn changes.
  useEffect(() => {
    alertFiredForTurn.current = null;
  }, [turnStartedAt]);

  if (!turnStartedAt) return null;

  const startMs = new Date(turnStartedAt).getTime();
  if (Number.isNaN(startMs)) return null;

  const elapsedMs = Math.max(0, now - startMs);
  const remainingMs = Math.max(0, totalMs - elapsedMs);
  const remainingSec = Math.ceil(remainingMs / 1000);

  const isAlert = isMyTurn && remainingSec <= alertAtSeconds && remainingSec > 0;
  const isExpired = remainingMs <= 0;

  // Fire urgent alert once when we cross into the warning window on our turn.
  if (isAlert && alertFiredForTurn.current !== turnStartedAt) {
    alertFiredForTurn.current = turnStartedAt;
    try { playUrgentTurnAlert(); } catch { /* audio not ready */ }
  }

  // The pill colour ramps red as the timer runs down.
  let pillColor = '#a3a3a3';
  if (remainingSec <= alertAtSeconds) pillColor = '#ff6b6b';
  else if (remainingSec <= alertAtSeconds * 2) pillColor = '#facc15';

  return (
    <>
      {/* Small always-visible pill */}
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
        style={{
          background: 'rgba(0,0,0,0.4)',
          color: pillColor,
          border: `1px solid ${pillColor}55`,
        }}
        aria-label={`${remainingSec} seconds remaining`}
      >
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: pillColor }} />
        {isExpired ? '0s' : `${remainingSec}s`}
      </span>

      {/* Big centred countdown + flashing edge glow — only when it's
          MY turn and we're in the alert window. */}
      {isAlert && (
        <>
          {/* Fixed edge glow on viewport. pointer-events-none so it
              doesn't intercept clicks on action buttons underneath. */}
          <div
            className="fixed inset-0 pointer-events-none z-40"
            style={{
              boxShadow:
                'inset 0 0 60px 12px rgba(156, 81, 255, 0.55),' +
                'inset 0 0 120px 24px rgba(18, 206, 236, 0.35)',
              animation: 'turnTimerPulse 1s ease-in-out infinite alternate',
            }}
          />
          {/* Large numeric countdown, top-centre, doesn't block clicks. */}
          <div
            className="fixed top-3 left-1/2 -translate-x-1/2 pointer-events-none z-50"
            style={{
              textShadow:
                '0 0 24px rgba(255, 107, 107, 0.8), 0 0 8px rgba(0,0,0,0.9)',
            }}
          >
            <span
              className="font-extrabold tabular-nums"
              style={{
                fontSize: '3rem',
                color: '#ff6b6b',
                lineHeight: 1,
              }}
            >
              {remainingSec}
            </span>
            <span
              className="ml-2 font-semibold uppercase tracking-wider"
              style={{
                fontSize: '0.75rem',
                color: '#ffd1d1',
              }}
            >
              Your turn
            </span>
          </div>
          <style>{`
            @keyframes turnTimerPulse {
              0%   {
                box-shadow:
                  inset 0 0 60px 12px rgba(156, 81, 255, 0.55),
                  inset 0 0 120px 24px rgba(18, 206, 236, 0.35);
              }
              100% {
                box-shadow:
                  inset 0 0 100px 20px rgba(255, 107, 107, 0.70),
                  inset 0 0 200px 40px rgba(156, 81, 255, 0.50);
              }
            }
          `}</style>
        </>
      )}
    </>
  );
}
