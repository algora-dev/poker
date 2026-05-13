/**
 * seatLayout — compute seat positions around an oval poker table.
 *
 * Old approach (pre-2026-05-13): a static 9-element SEAT_POSITIONS array,
 * and getRelativeSeatPositions snapped each occupied seat to one of the
 * nine fixed slots. That worked at 9-handed but at 2-3-4 handed it left
 * huge visual gaps and the cards/badges of opposite seats got too close
 * to the table edge for the surrounding chrome to render.
 *
 * New approach: compute N evenly-spaced points around a parametric oval,
 * with the local player always pinned to the bottom (the natural poker
 * client convention). The oval is described by `ax` (horizontal radius
 * as a percentage of container width) and `ay` (vertical radius), with
 * a small downward bias so the bottom seat has room for the action
 * bar underneath without being clipped by the table felt.
 *
 * Returned coordinates are CSS percentage strings ("85%") so existing
 * absolute positioning in PokerTable just plugs in.
 *
 * The function is pure and viewport-agnostic — viewport tuning is done
 * by passing different ax/ay (see computeSeatPositionsForViewport).
 */

export interface SeatPos {
  top: string;
  left: string;
  /** Seat index (server-side seat id) this position is bound to. */
  seatIndex: number;
}

export interface SeatLayoutOptions {
  /** Horizontal oval radius as percentage of container width (0..50). */
  ax?: number;
  /** Vertical oval radius as percentage of container height (0..50). */
  ay?: number;
  /** Centre of oval, x as percentage. */
  cx?: number;
  /** Centre of oval, y as percentage. */
  cy?: number;
  /**
   * Bottom-bias factor (0..1). Shifts the bottom seat closer to the table
   * edge so the action bar doesn't get jammed against the felt. 0 = none,
   * 1 = bottom seat sits ON the bottom edge.
   */
  bottomBias?: number;
}

/**
 * Compute N seat positions, with mySeatIndex pinned to the bottom-centre.
 *
 * seats: array of seatIndex (already filtered to occupied seats).
 * mySeatIndex: which seat is the local player (gets the bottom slot).
 *
 * Returns an array length == seats.length, in clockwise order from the
 * local player. If local player is not in the seats array (spectator
 * mode), the first sorted seat takes the bottom slot.
 */
export function computeSeatPositions(
  seats: number[],
  mySeatIndex: number,
  opts: SeatLayoutOptions = {}
): SeatPos[] {
  const {
    ax = 46,
    ay = 38,
    cx = 50,
    cy = 50,
    bottomBias = 0.08,
  } = opts;

  if (seats.length === 0) return [];

  // Rotate so mySeatIndex is first (it gets the bottom-centre slot).
  const sorted = [...seats].sort((a, b) => a - b);
  const myIdx = sorted.indexOf(mySeatIndex);
  const rotated = myIdx >= 0
    ? [...sorted.slice(myIdx), ...sorted.slice(0, myIdx)]
    : sorted;

  const n = rotated.length;
  const out: SeatPos[] = [];

  // Parametric oval, parameterized by t in [0..1).
  //   i=0       → t=0       → bottom-centre (local player)
  //   i=n/4    → t=0.25    → LEFT (in CSS coords)
  //   i=n/2    → t=0.5     → top-centre (player opposite)
  //   i=3n/4   → t=0.75    → RIGHT
  //
  // Direction = CLOCKWISE on screen, matching real poker action flow:
  // backend turn order increments seatIndex (after rotating you to first,
  // the next seat sits to your LEFT). Watching from above:
  //   bottom → left → top → right → back to bottom
  // is the same direction a wall clock's hands sweep when read normally,
  // so the table appears clockwise from the viewer's perspective.
  //
  // (Earlier version 2026-05-13 wrote x = cx + ax*sin(...), which placed
  // seat 1 on the RIGHT — reversed for the viewer and showed action as
  // anti-clockwise. Reported by Shaun in playtest-3 screenshot.)
  //
  // Formulas:
  //   x = cx - ax*sin(2*PI*t)          (x grows LEFTward as t grows)
  //   y = cy + ay*cos(2*PI*t)          (y grows downward in CSS;
  //                                    cos(0)=1 → bottom; cos(PI)=-1 → top)

  for (let i = 0; i < n; i++) {
    const t = i / n;
    const sx = Math.sin(2 * Math.PI * t);
    const cy_ = Math.cos(2 * Math.PI * t);
    let x = cx - ax * sx;
    let y = cy + ay * cy_;

    // Bottom-bias: when this seat is near the bottom (cy_ > 0), nudge
    // it further down so the local player's chips/cards don't crowd the
    // pot. Most pronounced for i=0 (cy_=1); zero for i=n/2 (cy_=-1).
    if (cy_ > 0) {
      y += bottomBias * ay * cy_;
    }

    // Clamp inside the visible container so absolutely-positioned
    // children with -translate-x/y-50% don't hang off the edge.
    //
    // Clamp history:
    //   92 -> 70 -> 85 -> 90 (current 2026-05-13 14:00):
    //   Top seats use translate-x-1/2 (anchor = TOP of seat row → cards
    //   render ABOVE pos.top, on the felt rail above the avatar).
    //   Bottom seats use -translate-x/y-full (anchor = BOTTOM of seat row
    //   → cards render below pos.top, just above the action bar).
    //   Side seats use -translate-x/y-50% (anchor = CENTRE).
    //   With this scheme the clamp can sit closer to the wrapper edges
    //   without overlap, so we restore ~10-90 range.
    x = Math.max(6, Math.min(94, x));
    y = Math.max(10, Math.min(90, y));

    out.push({
      seatIndex: rotated[i],
      left: `${x.toFixed(2)}%`,
      top: `${y.toFixed(2)}%`,
    });
  }

  return out;
}

/**
 * Tuned ax/ay per viewport breakpoint. Returns positions ready to use.
 *
 * Why per-viewport tuning: at narrow widths the seat avatars + chip
 * badges are physically large relative to the felt, so they need a
 * tighter oval (smaller ax/ay) and more bottom-bias to fit. At wide
 * desktops the felt has plenty of room so we can sit seats closer to
 * the rail for a more authentic look.
 */
export function computeSeatPositionsForViewport(
  seats: number[],
  mySeatIndex: number,
  breakpoint: 'mobile-portrait' | 'mobile-landscape' | 'tablet' | 'desktop'
): SeatPos[] {
  switch (breakpoint) {
    // ax/ay tuned for the horizontal-row layout (top/bottom rows extend
    // sideways, side seats stack vertically). At 6+ handed the corner
    // seats (t ≈ 0.125, 0.375, 0.625, 0.875) sit at ~45° around the oval
    // — with the wrapper much wider than tall (wide oval), these end up
    // visually OUTSIDE the felt rail. Shaun playtest 2026-05-13 14:35:
    // "NE/SE/SW/NW players need to be pushed closer to the table".
    // Tighter ax (smaller horizontal radius) pulls corners inward.
    case 'mobile-portrait':
      return computeSeatPositions(seats, mySeatIndex, {
        ax: 30, ay: 36, bottomBias: 0.0,
      });
    case 'mobile-landscape':
      return computeSeatPositions(seats, mySeatIndex, {
        ax: 34, ay: 34, bottomBias: 0.0,
      });
    case 'tablet':
      return computeSeatPositions(seats, mySeatIndex, {
        ax: 36, ay: 36, bottomBias: 0.0,
      });
    case 'desktop':
    default:
      return computeSeatPositions(seats, mySeatIndex, {
        ax: 38, ay: 38, bottomBias: 0.0,
      });
  }
}
