/**
 * DealAnimation — face-down cards flicking from dealer button to each
 * seated player at the start of a hand.
 *
 * Mounts on `game:new-hand`. Self-clears after ~1.5s. Plays a soft
 * "deal" sound per card (subject to user audio prefs).
 *
 * Deal order: clockwise starting at SB (real poker), 1 card per player
 * per pass, 2 passes.
 *
 * The animation lives in an absolutely-positioned overlay above the
 * table. Card travel positions are computed from the same SEAT_POSITIONS
 * percentages used by PokerTable so the cards land at the player's seat.
 *
 * Pure visual. Backend doesn't know or care this exists.
 */

import { useEffect, useRef, useState } from 'react';
import { playDealSlideSound } from '../utils/gameAudio';
import { getCardPixelSize } from './PlayingCard';

interface DealPlayer {
  seatIndex: number;
  position: string;
}

interface Props {
  /** Active key — change this value to (re)trigger the animation. Typically
   *  the hand id, or a counter incremented on game:new-hand. */
  triggerKey: string | number | null;
  /** Players currently in the hand (post hand init). Used to know who gets cards.
   *  Folded/eliminated players are skipped. */
  players: DealPlayer[];
  /** Map from seatIndex -> { top, left } CSS string ("85%", "50%"). */
  seatPositionByIndex: Record<number, { top: string; left: string }>;
  /** Seat index of the SB (deal starts here, clockwise). */
  sbSeatIndex?: number;
  /** Seat index of dealer button (origin of the card flick). */
  dealerSeatIndex?: number;
  /** Optional: fires when the last card has finished its flight. GameRoom
   *  uses this to reveal the static face-down + face-up cards exactly
   *  when the animation finishes, so there's no gap and no overlap. */
  onComplete?: () => void;
}

const PASSES = 2;
// Pre-roll: brief pause AFTER `game:new-hand` fires before the first
// card flies. Without this the animation often started before the new
// game-state had arrived, so cards appeared to fly to the previous
// hand's seat layout. 600ms is comfortable poker pacing.
const PRE_ROLL_MS = 600;
const PER_CARD_MS = 110;         // gap between successive card emits (slowed slightly)
const FLIGHT_MS = 320;           // animated travel time
const CLEAR_AFTER_MS = (n: number) =>
  PRE_ROLL_MS + PASSES * n * PER_CARD_MS + FLIGHT_MS + 200;

interface Flight {
  id: number;
  seatIndex: number;
  delayMs: number;
  variant: number;
}

export function DealAnimation({
  triggerKey,
  players,
  seatPositionByIndex,
  sbSeatIndex = -1,
  dealerSeatIndex = -1,
  onComplete,
}: Props) {
  const [flights, setFlights] = useState<Flight[] | null>(null);

  // GERALD AUDIT-26 [M-02]: stash all non-trigger props in refs so the
  // deal-animation effect depends ONLY on triggerKey. Previously the
  // effect included `players.length` and `sbSeatIndex` in its dep array,
  // which meant ANY seat/dealer/SB change during a hand reset would
  // re-run the effect and fire an uncommanded deal animation — then
  // game:new-hand at t=12s fired the same animation a second time. That
  // was Shaun's "double deal" symptom in CeceShaunV3.
  const playersRef = useRef(players);
  const seatPosRef = useRef(seatPositionByIndex);
  const sbRef = useRef(sbSeatIndex);
  const dealerRef = useRef(dealerSeatIndex);
  const onCompleteRef = useRef(onComplete);
  // Keep refs fresh on every render. This does NOT trigger the effect.
  playersRef.current = players;
  seatPosRef.current = seatPositionByIndex;
  sbRef.current = sbSeatIndex;
  dealerRef.current = dealerSeatIndex;
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (triggerKey == null) return;

    // Build the deal order: clockwise from SB, skip folded/eliminated.
    // PokerTable's SEAT_POSITIONS index is the same ring order as
    // GamePlayer.seatIndex, so we walk seatIndex modulo total seats.
    // (Use refs so this effect only fires on triggerKey changes.)
    const eligible = playersRef.current.filter(
      p => p.position !== 'folded' && p.position !== 'eliminated'
    );
    if (eligible.length === 0) {
      // FAIL-OPEN (Shaun 2026-05-15, Gerald audit-28). Previously this
      // early-return did NOT call onComplete, leaving betweenHands
      // true forever and hiding all cards on the table. Reproduced
      // when game:new-hand arrived before the broadcastGameState that
      // reset positions for the new hand. Server-side ordering has
      // been fixed (handLifecycle.ts pushes state BEFORE the event),
      // but this safety net guarantees the UI never gets stuck even
      // if some other path re-creates the race.
      // eslint-disable-next-line no-console
      console.warn(
        '[DealAnimation] empty eligible at triggerKey change; firing onComplete to fail-open',
        {
          triggerKey,
          playerCount: playersRef.current.length,
          positions: playersRef.current.map(p => p.position),
        }
      );
      setFlights(null);
      try { onCompleteRef.current?.(); } catch { /* ignore */ }
      return;
    }
    // Sort eligible by seatIndex first; we'll pick the order from SB.
    eligible.sort((a, b) => a.seatIndex - b.seatIndex);
    const seats = eligible.map(p => p.seatIndex);
    // Find SB (or first seat) as the start of clockwise rotation.
    const startIdx = Math.max(0, seats.indexOf(sbRef.current));
    const rotated: number[] = [];
    for (let i = 0; i < seats.length; i++) {
      rotated.push(seats[(startIdx + i) % seats.length]);
    }

    const flightsArr: Flight[] = [];
    let id = 0;
    for (let pass = 0; pass < PASSES; pass++) {
      for (let i = 0; i < rotated.length; i++) {
        flightsArr.push({
          id: id++,
          seatIndex: rotated[i],
          delayMs: PRE_ROLL_MS + (pass * rotated.length + i) * PER_CARD_MS,
          variant: id,
        });
      }
    }

    setFlights(flightsArr);

    // Fire deal-slide sounds on each card's delay.
    const soundTimers: ReturnType<typeof setTimeout>[] = [];
    for (const f of flightsArr) {
      soundTimers.push(
        setTimeout(() => {
          try { playDealSlideSound(f.variant); } catch { /* audio not ready */ }
        }, f.delayMs)
      );
    }

    // Clear the animation overlay after the last card has landed.
    const totalMs = CLEAR_AFTER_MS(rotated.length);
    const clearTimer = setTimeout(() => {
      setFlights(null);
      // Fire onComplete on the same tick the overlay clears so the
      // static cards (PokerTable's <CardBack/> + hero <PlayingCard/>)
      // can fade in immediately, no visual gap.
      try { onCompleteRef.current?.(); } catch { /* ignore */ }
    }, totalMs);

    return () => {
      for (const t of soundTimers) clearTimeout(t);
      clearTimeout(clearTimer);
    };
    // INTENTIONAL: triggerKey is the ONLY dep. Everything else is
    // accessed via ref so seat-state changes during the hand-reset
    // window can never spuriously re-fire the deal animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerKey]);

  if (!flights || flights.length === 0) return null;

  // Origin: dealer button position if known, else table centre.
  // Read via refs so render uses the freshest seat layout without
  // re-triggering the animation effect.
  const dealerPos = dealerRef.current >= 0
    ? seatPosRef.current[dealerRef.current]
    : null;
  const originLeft = dealerPos?.left ?? '50%';
  const originTop = dealerPos?.top ?? '50%';

  // Use the same pixel dimensions the landed face-down card will have.
  // 'xs' matches the default cardBackSize on mobile portrait, sm/md on
  // larger viewports. Picking 'xs' keeps the in-flight cards tidy on
  // mobile and only marginally smaller than the landed back on desktop.
  const cardPx = getCardPixelSize('xs');

  return (
    <div className="absolute inset-0 pointer-events-none z-30 overflow-hidden">
      {flights.map(f => {
        const dest = seatPosRef.current[f.seatIndex];
        if (!dest) return null;
        return (
          <div
            key={f.id}
            style={{
              position: 'absolute',
              left: originLeft,
              top: originTop,
              // Match the size of an `xs` PlayingCard back so the
              // in-flight card and the landed card are pixel-identical.
              width: `${cardPx.w}px`,
              height: `${cardPx.h}px`,
              marginLeft: `-${cardPx.w / 2}px`,
              marginTop: `-${cardPx.h / 2}px`,
              borderRadius: '6px',
              background:
                'linear-gradient(135deg, #1e3a8a 0%, #7c3aed 50%, #1e3a8a 100%)',
              border: '1.5px solid rgba(255,255,255,0.25)',
              boxShadow: '0 4px 14px rgba(0,0,0,0.55)',
              opacity: 0,
              transform: 'scale(0.7) rotate(-8deg)',
              animation: `dealCardFly ${FLIGHT_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1) ${f.delayMs}ms forwards`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              // Custom property carries destination into the keyframe.
              ['--dest-left' as any]: dest.left,
              ['--dest-top' as any]: dest.top,
            }}
          >
            <img
              src="/assets/t3-logo-white.png"
              alt=""
              draggable={false}
              style={{
                // T3 logo at 90% of inner area (bumped 50% from prior
                // 60% per Shaun playtest 2026-05-14). Matches CardBack.
                width: '90%',
                height: '90%',
                objectFit: 'contain',
                opacity: 0.9,
              }}
            />
          </div>
        );
      })}
      <style>{`
        @keyframes dealCardFly {
          0% {
            opacity: 0;
            transform: scale(0.7) rotate(-8deg);
          }
          15% {
            opacity: 1;
          }
          100% {
            left: var(--dest-left);
            top: var(--dest-top);
            opacity: 0.85;
            transform: scale(1) rotate(0deg);
          }
        }
      `}</style>
    </div>
  );
}
