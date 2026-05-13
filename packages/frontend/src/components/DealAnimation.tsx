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

import { useEffect, useState } from 'react';
import { playDealSlideSound } from '../utils/gameAudio';

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
}: Props) {
  const [flights, setFlights] = useState<Flight[] | null>(null);

  useEffect(() => {
    if (triggerKey == null) return;

    // Build the deal order: clockwise from SB, skip folded/eliminated.
    // PokerTable's SEAT_POSITIONS index is the same ring order as
    // GamePlayer.seatIndex, so we walk seatIndex modulo total seats.
    const eligible = players.filter(
      p => p.position !== 'folded' && p.position !== 'eliminated'
    );
    if (eligible.length === 0) {
      setFlights(null);
      return;
    }
    // Sort eligible by seatIndex first; we'll pick the order from SB.
    eligible.sort((a, b) => a.seatIndex - b.seatIndex);
    const seats = eligible.map(p => p.seatIndex);
    // Find SB (or first seat) as the start of clockwise rotation.
    const startIdx = Math.max(0, seats.indexOf(sbSeatIndex));
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
    const clearTimer = setTimeout(
      () => setFlights(null),
      CLEAR_AFTER_MS(rotated.length)
    );

    return () => {
      for (const t of soundTimers) clearTimeout(t);
      clearTimeout(clearTimer);
    };
  }, [triggerKey, players.length, sbSeatIndex]);

  if (!flights || flights.length === 0) return null;

  // Origin: dealer button position if known, else table centre.
  const dealerPos = dealerSeatIndex >= 0
    ? seatPositionByIndex[dealerSeatIndex]
    : null;
  const originLeft = dealerPos?.left ?? '50%';
  const originTop = dealerPos?.top ?? '50%';

  return (
    <div className="absolute inset-0 pointer-events-none z-30 overflow-hidden">
      {flights.map(f => {
        const dest = seatPositionByIndex[f.seatIndex];
        if (!dest) return null;
        return (
          <div
            key={f.id}
            style={{
              position: 'absolute',
              left: originLeft,
              top: originTop,
              width: '36px',
              height: '52px',
              marginLeft: '-18px',
              marginTop: '-26px',
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
                width: '60%',
                height: '60%',
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
