import { getAvatarSrc } from '../utils/avatars';
import { useViewport } from '../hooks/useViewport';
import { computeSeatPositionsForViewport, type SeatPos } from '../utils/seatLayout';
import { PlayingCard, CardBack, type CardSize } from './PlayingCard';
import { PreActionBar, type PreActionOption } from './PreActionBar';

interface Player {
  userId: string;
  username: string;
  seatIndex: number;
  chipStack: string;
  position: string;
  holeCards: any[];
  avatarId?: number;
  currentStageBet?: string;
  lastAction?: string;
}

interface PokerTableProps {
  myPlayer: Player;
  opponents: Player[];
  board: any[];
  pot: string;
  currentBet: string;
  stage: string;
  isMyTurn: boolean;
  activePlayerUserId: string | null;
  turnStartedAt: string | null;
  dealerSeatIndex?: number;
  sbSeatIndex?: number;
  bbSeatIndex?: number;
  status: string;
  amountToCall: string;
  formatChips: (chips: string) => string;
  /** @deprecated unused since card rendering moved to <PlayingCard/>. Kept on the props interface for callers; safe to drop. */
  formatCard?: (card: any) => string;
  onFold: () => void;
  onCheck: () => void;
  onCall: () => void;
  onRaise: () => void;
  onAllIn: () => void;
  actionLoading: boolean;
  /**
   * Between-hands flag (Shaun 2026-05-14). Set true after a hand ends
   * (game:showdown / game:fold-win) and false again on game:new-hand.
   * While true, the felt renders with no community cards and no
   * opponent/hero hole cards visible — the table is "clean" while the
   * 10s countdown + chime + 2s pause runs. Prevents the previous hand's
   * cards from lingering when a player closes the result modal early,
   * and avoids the deal animation looking like it plays "twice".
   */
  betweenHands?: boolean;
  // Pre-action props are defined on the function-signature intersection
  // below (alongside the imported PreActionOption type) so the runtime
  // type and the imported union stay in lock-step.
}

// Seat positions around an oval table (CSS positions as percentages).
// Top-row seats lowered from top:2% -> top:12% so player avatars aren't
// clipped at the top of the browser viewport (reported in playtest
// 2026-05-11). Side and top-corner seats nudged accordingly to keep the
// oval shape balanced.
export const SEAT_POSITIONS: { top: string; left: string }[] = [
  { top: '85%', left: '50%' },   // 0: bottom center (YOU)
  { top: '75%', left: '13%' },   // 1: bottom-left
  { top: '48%', left: '4%' },    // 2: left
  { top: '18%', left: '12%' },   // 3: top-left
  { top: '10%', left: '33%' },   // 4: top-left-center
  { top: '10%', left: '67%' },   // 5: top-right-center
  { top: '18%', left: '88%' },   // 6: top-right
  { top: '48%', left: '96%' },   // 7: right
  { top: '75%', left: '87%' },   // 8: bottom-right
];

/**
 * Map each actually-occupied seat to a CSS layout slot (0..8) around the
 * oval table, with the local player always rendered at slot 0 (bottom
 * centre).
 *
 * BUG fix 2026-05-11: previous version did `(mySeatIndex + i) % totalPlayers`,
 * which (a) used the wrong modulus (max table is 9 seats, not totalPlayers)
 * and (b) assumed seats were dense and started at mySeatIndex. When any
 * seat was empty (e.g. 6 of 9 seats taken with sparse indices), the wrong
 * seatIndex was computed for every other player and seatToPlayer.get()
 * returned undefined, dropping bots from the UI even though the server
 * reported them in the players array. Reported by Shaun: "the bots weren't
 * showing on the UX, but apparently they were in the match".
 *
 * New approach: take the actual occupied seat indices, rotate so mine is
 * first, then evenly space them across the 9 CSS slots clockwise.
 */
export function getRelativeSeatPositions(
  mySeatIndex: number,
  occupiedSeats: number[]
): { seatIndex: number; positionIndex: number }[] {
  if (occupiedSeats.length === 0) return [];

  // Sort ascending so the visual rotation around the table matches the
  // server's seat order. Then rotate so my seat is first.
  const sorted = [...occupiedSeats].sort((a, b) => a - b);
  const myIdx = sorted.indexOf(mySeatIndex);
  const rotated = myIdx >= 0
    ? [...sorted.slice(myIdx), ...sorted.slice(0, myIdx)]
    : sorted; // spectator fallback: don't rotate

  const total = rotated.length;
  const spacing = 9 / total;
  return rotated.map((seatIndex, i) => ({
    seatIndex,
    positionIndex: Math.round(i * spacing) % 9,
  }));
}

// ── Card rendering ──
// PlayingCard + CardBack imported from ./PlayingCard. ONE component,
// ONE design, used in every card-rendering site across the game.
// Don't re-implement card visuals here; extend PlayingCard.tsx instead.

// ── Main component ──

export function PokerTable({
  myPlayer: _myPlayer,
  opponents: _opponents,
  board: _board,
  pot,
  currentBet,
  stage,
  isMyTurn,
  activePlayerUserId,
  turnStartedAt,
  dealerSeatIndex = -1,
  sbSeatIndex = -1,
  bbSeatIndex = -1,
  status,
  amountToCall,
  formatChips,
  formatCard,
  onFold,
  onCheck,
  onCall,
  onRaise,
  onAllIn,
  actionLoading,
  betweenHands,
  preAction,
  onSelectPreAction,
}: PokerTableProps & {
  /** Currently-queued pre-action; null = nothing queued. */
  preAction?: PreActionOption | null;
  /** Click handler — toggles the option (same option clicked again = deselect). */
  onSelectPreAction?: (opt: PreActionOption) => void;
}) {
  // Hide cards when:
  //  - between hands (8s countdown gap; clean felt before deal animation)
  //  - game hasn't started yet (waiting/lobby state — no deal has
  //    happened, so showing card backs is a lie)
  // (Shaun playtest 2026-05-14; waiting-room fix 2026-05-15.)
  const hideCards = betweenHands || status !== 'in_progress';
  const board = hideCards ? [] : _board;
  const myPlayer = hideCards ? { ..._myPlayer, holeCards: [] } : _myPlayer;
  const opponents = hideCards ? _opponents.map(o => ({ ...o, holeCards: [] })) : _opponents;
  // Silence unused-var warning on the deprecated formatCard prop.
  void formatCard;
  const allPlayers = [myPlayer, ...opponents];
  const vp = useViewport();

  // Build the seat lookup BEFORE computing layout so the layout uses the
  // actual occupied seat indices (not a 0..N-1 dense assumption).
  const seatToPlayer = new Map<number, Player>();
  for (const p of allPlayers) {
    seatToPlayer.set(p.seatIndex, p);
  }
  const occupiedSeats = Array.from(seatToPlayer.keys());

  // Dynamic seat positions: evenly distributed around an oval whose
  // radii adapt to the viewport breakpoint. Replaces the old static
  // 9-slot SEAT_POSITIONS array which left big visual gaps at 2-4
  // handed and broke at narrow viewports.
  const seatLayout: SeatPos[] = computeSeatPositionsForViewport(
    occupiedSeats,
    myPlayer.seatIndex,
    vp.breakpoint
  );

  // Card + chip-badge sizing scales with viewport. Single source of
  // truth so the whole table stays visually proportional. Card sizes
  // map to the four explicit variants in <PlayingCard/> (xs/sm/md/lg);
  // there is no per-viewport per-slot custom width any more.
  type Sizing = {
    avatar: string; avatarText: string;
    plateMinW: string; plateMaxW: string;
    plateName: string; plateChips: string; plateStatus: string;
    /** Size for face-down opponent cards (the most numerous on the table) */
    cardBackSize: CardSize;
    /** Size for the 5 community cards on the felt */
    cardBoardSize: CardSize;
    /** Size for the hero's own face-up hole cards */
    cardHeroSize: CardSize;
    /** Tailwind width class used for board placeholder slots (must match cardBoardSize pixel width) */
    cardBoardPlaceholderW: string;
    positionBadge: string; chipGlyph: string; betText: string;
  };
  const sizing: Sizing = (() => {
    if (vp.isMobilePortrait) {
      return {
        avatar: 'w-10 h-10', avatarText: 'text-xs',
        plateMinW: 'min-w-[80px]', plateMaxW: 'max-w-[90px]',
        plateName: 'text-[10px]', plateChips: 'text-[10px]', plateStatus: 'text-[8px]',
        cardBackSize: 'xs', cardBoardSize: 'xs', cardHeroSize: 'sm',
        cardBoardPlaceholderW: 'w-[28px] h-[40px]',
        positionBadge: 'w-4 h-4 text-[8px]', chipGlyph: 'w-5 h-5', betText: 'text-[11px]',
      };
    }
    if (vp.isMobileLandscape) {
      return {
        avatar: 'w-10 h-10', avatarText: 'text-xs',
        plateMinW: 'min-w-[90px]', plateMaxW: 'max-w-[100px]',
        plateName: 'text-[11px]', plateChips: 'text-[11px]', plateStatus: 'text-[9px]',
        cardBackSize: 'xs', cardBoardSize: 'sm', cardHeroSize: 'sm',
        cardBoardPlaceholderW: 'w-[32px] h-[46px]',
        positionBadge: 'w-5 h-5 text-[9px]', chipGlyph: 'w-6 h-6', betText: 'text-xs',
      };
    }
    if (vp.isTablet) {
      return {
        avatar: 'w-12 h-12', avatarText: 'text-sm',
        plateMinW: 'min-w-[120px]', plateMaxW: 'max-w-[140px]',
        plateName: 'text-xs', plateChips: 'text-[11px]', plateStatus: 'text-[9px]',
        cardBackSize: 'sm', cardBoardSize: 'sm', cardHeroSize: 'md',
        cardBoardPlaceholderW: 'w-[32px] h-[46px]',
        positionBadge: 'w-6 h-6 text-[10px]', chipGlyph: 'w-7 h-7', betText: 'text-sm',
      };
    }
    // desktop
    return {
      avatar: 'w-16 h-16', avatarText: 'text-lg',
      plateMinW: 'min-w-[160px]', plateMaxW: 'max-w-[180px]',
      plateName: 'text-sm', plateChips: 'text-base', plateStatus: 'text-[10px]',
      cardBackSize: 'sm', cardBoardSize: 'md', cardHeroSize: 'lg',
      cardBoardPlaceholderW: 'w-[48px] h-[68px]',
      positionBadge: 'w-7 h-7 text-[10px]', chipGlyph: 'w-8 h-8', betText: 'text-base',
    };
  })();



  // ── Stage label ──
  const stageLabel: Record<string, string> = {
    preflop: 'Pre-Flop', flop: 'Flop', turn: 'Turn', river: 'River',
    showdown: 'Showdown', completed: 'Complete', waiting: 'Waiting',
  };

  // Aspect ratio of the table wrapper. With horizontal-row layouts for
  // top and bottom seats (cards extend HORIZONTALLY, not into the felt),
  // we can use a reasonable oval ratio again without needing a gutter.
  const tableAspect = vp.isMobile
    ? '60%'
    : vp.isTablet
      ? '50%'
      : '44%';

  return (
    <div
      className="relative w-full mx-auto flex flex-col items-center"
      style={{
        maxWidth: vp.isDesktop ? '960px' : '100%',
      }}
    >
    <div
      className="relative w-full"
      style={{
        paddingBottom: tableAspect,
        minHeight: '300px',
      }}
    >

      {/* ── Table felt ── */}
      <div className="absolute inset-[5%] rounded-[50%] overflow-hidden"
           style={{
             background: 'radial-gradient(ellipse at center, #1a6b3c 0%, #145a30 50%, #0e4423 80%, #0a3219 100%)',
             boxShadow: 'inset 0 0 60px rgba(0,0,0,0.5), 0 8px 32px rgba(0,0,0,0.6)',
           }}>
        {/* Wood rail */}
        <div className="absolute -inset-3 rounded-[50%] -z-10"
             style={{
               background: 'linear-gradient(135deg, #8B6914 0%, #A67C00 25%, #6B4F10 50%, #8B6914 75%, #A67C00 100%)',
               boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
             }}
        />
        {/* Inner rail line */}
        <div className="absolute inset-2 rounded-[50%] border border-green-500/20" />
        {/* Felt texture overlay */}
        <div className="absolute inset-0 rounded-[50%] opacity-10"
             style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg width=\'4\' height=\'4\' viewBox=\'0 0 4 4\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cpath d=\'M1 3h1v1H1V3zm2-2h1v1H3V1z\' fill=\'%23000000\' fill-opacity=\'0.3\'/%3E%3C/svg%3E")' }}
        />

        {/* T3 logos at ends of table — hidden on small viewports to free
            up centre space for the pot + board cards. */}
        {!vp.isMobile && (
          <>
            <div className="absolute top-1/2 left-[12%] -translate-y-1/2 select-none">
              <img src="/assets/t3-logo-white.png" alt="T3" className="w-16 h-16 opacity-[0.12]" />
            </div>
            <div className="absolute top-1/2 right-[12%] -translate-y-1/2 select-none">
              <img src="/assets/t3-logo-white.png" alt="T3" className="w-16 h-16 opacity-[0.12]" />
            </div>
          </>
        )}

        {/* ── Center: Pot + Community Cards ── */}
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-center">
          {/* Pot display */}
          <div className="mb-2 flex flex-col items-center gap-1">
            {/* Main pot */}
            <div className={`bg-black/50 backdrop-blur-sm rounded-full ${vp.isMobile ? 'px-3 py-1' : 'px-5 py-1.5'} inline-flex items-center gap-2`}>
              <img src="/assets/musd-chip.png" alt="" className={vp.isMobile ? 'w-7 h-7' : 'w-10 h-10'} />
              <span className={`text-white font-bold ${vp.isMobile ? 'text-sm' : 'text-xl'}`}>{formatChips(pot)}</span>
              <span className="text-gray-400 text-[10px] uppercase tracking-wider ml-1">{stageLabel[stage] || stage}</span>
            </div>

            {/* Side pot indicator — shows when any player is all-in */}
            {allPlayers.some(p => p.position === 'all_in') && parseInt(pot) > 0 && (
              <div className="flex items-center gap-1.5 bg-black/40 rounded-full px-3 py-1">
                <img src="/assets/musd-chip.png" alt="" className="w-5 h-5 opacity-70" />
                <span className="text-[10px] font-medium" style={{color:'#9c51ff'}}>Side pot active</span>
              </div>
            )}
          </div>

          {/* Community Cards — board is cleared above when betweenHands
              is true, so the felt is empty during the 12s gap. */}
          <div className={`flex ${vp.isMobile ? 'gap-1' : 'gap-2'} justify-center`}>
            {board.length === 0 ? (
              status === 'in_progress' ? (
                <div className={`flex ${vp.isMobile ? 'gap-1' : 'gap-2'}`}>
                  {[0,1,2,3,4].map(i => (
                    <div key={i} className={`${sizing.cardBoardPlaceholderW} rounded-md border border-green-600/30 bg-green-900/30`} />
                  ))}
                </div>
              ) : null
            ) : (
              <>
                {board.map((card: any, i: number) => (
                  <PlayingCard key={i} card={card} size={sizing.cardBoardSize} />
                ))}
                {Array.from({ length: 5 - board.length }).map((_, i) => (
                  <div key={`empty-${i}`} className={`${sizing.cardBoardPlaceholderW} rounded-md border border-green-600/20 bg-green-900/20`} />
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Player seats ──
          Per-seat layout mode based on seat anchor Y:
            top    (y < 30%)  → horizontal [cards][meta]   (cards stick UP onto the felt rail; meta on the right)
            bottom (y > 70%)  → horizontal [meta][cards]   (cards stick DOWN off the rail; meta on the left)
            side             → vertical (current behaviour) avatar over plate over cards
          This stops the bottom seat's cards from being obscured (the
          vertical stack pushed them below the action bar) and stops the
          top seat's cards from hanging into the central pot/board area.
          Shaun playtest 2026-05-13 14:00. */}
      {seatLayout.map((pos) => {
        const player = seatToPlayer.get(pos.seatIndex);
        if (!player) return null;

        const isMe = player.userId === myPlayer.userId;
        const isActive = player.userId === activePlayerUserId;
        const isFolded = player.position === 'folded';
        const isEliminated = player.position === 'eliminated';
        const isAllIn = player.position === 'all_in';

        const initial = player.username.charAt(0).toUpperCase();
        const avatarSrc = getAvatarSrc(player.avatarId);

        // Derive layout mode from the anchor X and Y.
        // Only the top-CENTRE and bottom-CENTRE seats use horizontal
        // layout (cards on one side, meta on the other). True corner
        // seats (NW, NE, SW, SE) fall back to vertical 'side' layout
        // even though their Y is small/large, otherwise they pile up
        // along the top/bottom rails and get cut off by the page header
        // / action bar (Shaun screenshot 2026-05-13 14:51).
        const yNum = parseFloat(pos.top);
        const xNum = parseFloat(pos.left);
        const isCentreColumn = Math.abs(xNum - 50) < 20; // ±20% of x-axis
        const layoutMode: 'top' | 'bottom' | 'side' =
          (yNum < 30 && isCentreColumn) ? 'top'
          : (yNum > 70 && isCentreColumn) ? 'bottom'
          : 'side';

        // Avatar + position badge — used by all three modes.
        const AvatarBlock = (
          <div className="relative flex-shrink-0">
            {player.seatIndex === dealerSeatIndex && !isEliminated && (
              <div className={`absolute -top-1 -right-1 ${sizing.positionBadge} rounded-full flex items-center justify-center font-bold text-black z-10`} style={{background:'#ffffff', boxShadow:'0 1px 4px rgba(0,0,0,0.4)'}}>D</div>
            )}
            {player.seatIndex === sbSeatIndex && player.seatIndex !== dealerSeatIndex && !isEliminated && (
              <div className={`absolute -top-1 -left-1 ${sizing.positionBadge} rounded-full flex items-center justify-center font-bold text-white z-10`} style={{background:'#12ceec', boxShadow:'0 1px 4px rgba(0,0,0,0.4)'}}>SB</div>
            )}
            {player.seatIndex === bbSeatIndex && !isEliminated && (
              <div className={`absolute -top-1 -left-1 ${sizing.positionBadge} rounded-full flex items-center justify-center font-bold text-white z-10`} style={{background:'#9c51ff', boxShadow:'0 1px 4px rgba(0,0,0,0.4)'}}>BB</div>
            )}
            <div className={`
              ${sizing.avatar} rounded-full flex items-center justify-center ${sizing.avatarText} font-bold shadow-lg overflow-hidden
              ${isActive ? 'ring-[3px] ring-yellow-400 shadow-yellow-400/50' :
                isMe ? 'ring-2 ring-green-400' :
                isAllIn ? 'ring-2 ring-purple-500' :
                'ring-1 ring-gray-600'}
              ${!avatarSrc ? (
                isEliminated ? 'bg-gray-800 text-gray-600' :
                isFolded ? 'bg-gray-700 text-gray-500' :
                isMe ? 'bg-green-800 text-green-200' :
                'bg-gray-700 text-white'
              ) : ''}
            `}>
              {avatarSrc ? (
                <img src={avatarSrc} alt={player.username} className="w-full h-full object-cover" />
              ) : (
                initial
              )}
            </div>
          </div>
        );

        const NamePlate = (
          <div className={`
            rounded-lg px-2 py-1 text-center ${sizing.plateMinW}
            ${isActive ? 'bg-yellow-900/80 border border-yellow-500/50' :
              isMe ? 'bg-green-900/80 border border-green-600/40' :
              'bg-gray-900/80 border border-gray-700/40'}
          `}>
            <div className={`${sizing.plateName} font-semibold truncate ${sizing.plateMaxW} ${
              isActive ? 'text-yellow-200' :
              isMe ? 'text-green-300' :
              isFolded ? 'text-gray-500' :
              'text-white'
            }`}>
              {player.username}{isMe ? ' (You)' : ''}
            </div>
            <div className={`${isMe ? `${sizing.plateChips} font-semibold` : sizing.plateStatus} ${isEliminated ? 'text-gray-600' : 'text-amber-400'}`}>
              {formatChips(player.chipStack)}
            </div>
            {isFolded && <div className={`${sizing.plateStatus} text-red-400 font-bold`}>FOLDED</div>}
            {isEliminated && <div className={`${sizing.plateStatus} text-gray-500 font-bold`}>ELIMINATED</div>}
            {isAllIn && <div className={`${sizing.plateStatus} text-purple-400 font-bold animate-pulse`}>ALL IN</div>}
          </div>
        );

        // The felt must be CLEAN — no face-up hero cards, no face-down
          // opponent cards — in TWO states:
          //   1. Between hands (8s countdown gap, Shaun 2026-05-14): the
          //      deal animation lands cards into seats; the static
          //      cards take over when DealAnimation's onComplete fires.
          //   2. Waiting / pre-start lobby (Shaun 2026-05-15): no deal
          //      has happened, so showing card backs is misleading.
          // Both states are unified into `hideCards` above.
          const HoleCards = (
          <div className="flex gap-0.5 sm:gap-1">
            {hideCards ? null : isMe ? (
              player.holeCards.length > 0 ? (
                player.holeCards.map((card: any, i: number) => (
                  <PlayingCard key={i} card={card} size={sizing.cardHeroSize} />
                ))
              ) : null
            ) : (
              !isEliminated && !isFolded && (
                <>
                  <CardBack size={sizing.cardBackSize} />
                  <CardBack size={sizing.cardBackSize} />
                </>
              )
            )}
          </div>
        );

        // Per-seat pre-action button removed 2026-05-15. Pre-actions
          // now live in a dedicated <PreActionBar/> rendered at the
          // bottom (same physical spot as the live action bar) so the
          // player always looks at one location. Three options instead
          // of the v1 single Check/Fold button: Check, Fold, Check/Fold.

        const ActionBadge = (player.lastAction || (player.currentStageBet && parseInt(player.currentStageBet) > 0)) ? (
          <div className="flex flex-col items-center">
            {player.currentStageBet && parseInt(player.currentStageBet) > 0 && (
              <div className="flex items-center gap-1.5">
                <img src="/assets/musd-chip.png" alt="" className={sizing.chipGlyph} />
                <span className={`${sizing.betText} font-semibold text-white leading-tight`}>{formatChips(player.currentStageBet)}</span>
              </div>
            )}
            {player.lastAction && player.lastAction !== 'blind' && (
              <span className={`${sizing.betText} font-bold uppercase mt-0.5 ${
                player.lastAction === 'fold' ? 'text-red-400' :
                player.lastAction === 'raise' ? 'text-yellow-400' :
                player.lastAction === 'all-in' ? 'text-purple-400' :
                player.lastAction === 'call' ? 'text-blue-300' :
                player.lastAction === 'check' ? 'text-emerald-300' :
                'text-gray-400'
              }`}>
                {player.lastAction === 'call' ? 'Call' :
                 player.lastAction === 'raise' ? 'Raise' :
                 player.lastAction === 'check' ? 'Check' :
                 player.lastAction === 'all-in' ? 'All In' :
                 player.lastAction === 'fold' ? 'Fold' : ''}
              </span>
            )}
          </div>
        ) : null;

        // Anchor translation per layout-mode.
        //   top:    anchor BOTTOM of the row at the FELT TOP EDGE so the
        //           name plate + action label sit ABOVE the felt (Shaun:
        //           "top player action decision is on the table; move it
        //           higher").
        //   bottom: anchor TOP of the row at the FELT BOTTOM EDGE so the
        //           avatar's top is right at the rail (Shaun: "lower the
        //           bottom player; PFP top must not go far onto the
        //           table"). Cards extend below the felt edge toward the
        //           action bar (which has matching marginTop).
        //   side:   anchor centre at pos.top (unchanged).
        //
        // For top/bottom we OVERRIDE the math-derived pos.top with a
        // value pinned to the felt edge. The felt is `inset-[5%]` of the
        // wrapper, so felt-top is at wrapper-y≈5%, felt-bottom at ≈95%.
        const wrapperPosClass =
          layoutMode === 'top'    ? 'absolute transform -translate-x-1/2 -translate-y-full z-10' :
          layoutMode === 'bottom' ? 'absolute transform -translate-x-1/2 z-10' :
                                    'absolute transform -translate-x-1/2 -translate-y-1/2 z-10';

        // Override Y position to anchor seats AT the felt rails.
        //   top centre   → row's BOTTOM at y=8%   (cards + meta float
        //                                            ABOVE the felt edge)
        //   bottom centre→ row's TOP at y=92%      (meta + cards float
        //                                            BELOW the felt edge)
        //   south corner → avatar TOP at felt rail (~85%): pos.top=88%
        //   north corner → avatar BOTTOM at felt rail (~15%): pos.top=15%
        //   true sides   → keep math-derived Y
        //
        // Shaun playtest 2026-05-13 16:00: "SE/SW players' PFP should
        // barely be on the table, like my player."
        const isCornerSouth = layoutMode === 'side' && yNum > 60 && !isCentreColumn;
        const isCornerNorth = layoutMode === 'side' && yNum < 40 && !isCentreColumn;
        const finalTop =
          layoutMode === 'top'    ? '8%' :
          layoutMode === 'bottom' ? '92%' :
          isCornerSouth           ? '88%' :
          isCornerNorth           ? '15%' :
                                    pos.top;

        const innerClass = layoutMode === 'side'
          ? 'flex flex-col items-center transition-all duration-300'
          : 'flex flex-row items-center gap-2 transition-all duration-300';

        return (
          <div
            key={player.userId}
            className={wrapperPosClass}
            style={{ top: finalTop, left: pos.left }}
          >
            <div className={`
              ${innerClass}
              ${isEliminated ? 'opacity-30' : ''}
              ${isFolded ? 'opacity-50' : ''}
              ${isActive ? 'scale-105' : ''}
            `}>
              {layoutMode === 'top' && (
                <>
                  {HoleCards}
                  <div className="flex flex-col items-center gap-1">
                    {AvatarBlock}
                    {NamePlate}
                    {ActionBadge}
                  </div>
                </>
              )}
              {layoutMode === 'bottom' && (
                <>
                  <div className="flex flex-col items-center gap-1">
                    {AvatarBlock}
                    {NamePlate}
                    {ActionBadge}
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    {HoleCards}
                  </div>
                </>
              )}
              {layoutMode === 'side' && (
                <>
                  {AvatarBlock}
                  <div className="mt-1.5">{NamePlate}</div>
                  <div className="mt-1">{HoleCards}</div>
                  {ActionBadge && <div className="mt-1">{ActionBadge}</div>}
                </>
              )}
            </div>
          </div>
        );
      })}

      </div>{/* close felt-container */}

      {/* ── Bottom Action Area ──
          Two mutually-exclusive bars share the same physical slot:
            • Live action bar  (Fold / Check / Call / Bet|Raise / All-In)
                Visible when isMyTurn.
            • Pre-action bar   (Check / Fold / Check/Fold)
                Visible when it's NOT my turn but I'm still active in the
                hand. Lets the player queue an intent for their next turn.
          Mobile: position:fixed at the bottom of the viewport so they
          are always reachable regardless of where the user has scrolled.
          All buttons sized for 44px+ touch targets on mobile.
          (Shaun 2026-05-15.) */}

      {!isMyTurn
        && status === 'in_progress'
        && myPlayer.position !== 'folded'
        && myPlayer.position !== 'eliminated'
        && myPlayer.position !== 'all_in'
        && !betweenHands
        && onSelectPreAction
        && (
          <PreActionBar
            selected={preAction ?? null}
            onSelect={onSelectPreAction}
            isMobile={vp.isMobile}
            isTablet={vp.isTablet}
          />
        )}

      {isMyTurn && status === 'in_progress' && myPlayer.position !== 'folded' && myPlayer.position !== 'eliminated' && myPlayer.position !== 'all_in' && (
        <div
          className={vp.isMobile
            ? 'fixed bottom-0 inset-x-0 z-20 px-2 pt-2'
            : 'z-20 mt-3'}
          style={vp.isMobile
            ? { paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }
            : {
                // Push the action bar down enough that the hero row
                // (which absolute-positions OUT of the felt-container,
                // extending below it by ~ avatar+plate height) doesn't
                // overlap. Tuned per viewport.
                marginTop: vp.isTablet ? '90px' : '110px',
              }}
        >
          <div
            className={`${vp.isMobile ? 'flex gap-1.5 rounded-2xl p-2' : 'flex gap-2 rounded-2xl p-3'} border border-white/10 shadow-2xl justify-center`}
            style={{background:'rgba(38,38,38,0.95)', backdropFilter:'blur(8px)'}}
          >
            <button
              onClick={onFold}
              disabled={actionLoading}
              className={`${vp.isMobile ? 'flex-1 px-2 py-3 min-h-[44px]' : 'px-5 py-2.5'} bg-red-600 text-white rounded-xl hover:bg-red-700 transition font-semibold disabled:opacity-50 text-sm flex items-center justify-center gap-1.5 shadow-lg`}
            >
              <span>✕</span> Fold
            </button>
            {parseInt(amountToCall || '0') === 0 ? (
              <button
                onClick={onCheck}
                disabled={actionLoading}
                className={`${vp.isMobile ? 'flex-1 px-2 py-3 min-h-[44px]' : 'px-5 py-2.5'} bg-yellow-600 text-white rounded-xl hover:bg-yellow-700 transition font-semibold disabled:opacity-50 text-sm flex items-center justify-center gap-1.5 shadow-lg`}
              >
                <span>✓</span> Check
              </button>
            ) : (
              <button
                onClick={onCall}
                disabled={actionLoading}
                className={`${vp.isMobile ? 'flex-1 px-2 py-3 min-h-[44px]' : 'px-5 py-2.5'} bg-green-600 text-white rounded-xl hover:bg-green-700 transition font-semibold disabled:opacity-50 text-sm flex items-center justify-center gap-1.5 shadow-lg`}
              >
                <span>📞</span> Call {formatChips(amountToCall)}
              </button>
            )}
            {/* Bet vs Raise label, by poker convention:
              - Preflop: BB is the opening bet, so any voluntary aggression is a 'Raise'.
              - Postflop with no bet yet (currentStageBet from prior streets resets to 0): 'Bet'.
              - Postflop after someone has bet: 'Raise'.
              Backend action is still 'raise' in both cases (server enforces sizing). */}
            <button
              onClick={onRaise}
              disabled={actionLoading}
              className={`${vp.isMobile ? 'flex-1 px-2 py-3 min-h-[44px]' : 'px-5 py-2.5'} bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition font-semibold disabled:opacity-50 text-sm flex items-center justify-center gap-1.5 shadow-lg`}
            >
              <span>⬆</span> {(stage !== 'preflop' && parseInt(currentBet || '0') === 0) ? 'Bet' : 'Raise'}
            </button>
            <button
              onClick={onAllIn}
              disabled={actionLoading}
              className={`${vp.isMobile ? 'flex-1 px-2 py-3 min-h-[44px]' : 'px-5 py-2.5'} bg-purple-600 text-white rounded-xl hover:bg-purple-700 transition font-semibold disabled:opacity-50 text-sm flex items-center justify-center gap-1.5 shadow-lg`}
            >
              <span>💎</span> All In
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
