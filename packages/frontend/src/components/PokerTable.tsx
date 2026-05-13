import { useState, useEffect } from 'react';
import { getAvatarSrc } from '../utils/avatars';
import { useViewport } from '../hooks/useViewport';
import { computeSeatPositionsForViewport, type SeatPos } from '../utils/seatLayout';

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
  formatCard: (card: any) => string;
  onFold: () => void;
  onCheck: () => void;
  onCall: () => void;
  onRaise: () => void;
  onAllIn: () => void;
  actionLoading: boolean;
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

// ── Card rendering with colored suits ──

const SUIT_SYMBOLS: Record<string, string> = {
  hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠',
};
const SUIT_COLORS: Record<string, string> = {
  hearts: 'text-red-500', diamonds: 'text-red-500',
  clubs: 'text-gray-900', spades: 'text-gray-900',
};

function CardFace({ card, small, large, sizeClass }: { card: any; small?: boolean; large?: boolean; sizeClass?: string }) {
  const suit = card.suit as string;
  const rank = card.rank as string;
  const symbol = SUIT_SYMBOLS[suit] || '?';
  const color = SUIT_COLORS[suit] || 'text-gray-900';
  // sizeClass overrides any small/large hint (used by PokerTable's
  // viewport-aware sizing). small/large kept for back-compat callers
  // (ShowdownModal etc.).
  const w = sizeClass
    ? sizeClass
    : large
      ? 'w-14 sm:w-[72px] h-[84px] sm:h-[102px]'
      : small
        ? 'w-9 h-[52px]'
        : 'w-10 sm:w-12 h-[56px] sm:h-[68px]';
  // Heuristic: derive label sizes from width hint. Very narrow cards
  // (mobile) get tiny labels; wide cards (desktop large) get bigger.
  const isNarrow = /w-(6|7|8|9)\s|w-6$|w-7$|w-8$|w-9$/.test(w);
  const isWide = /w-\[72px\]|w-14|w-12 /.test(w);
  const rankSize = isWide ? 'text-base font-bold' : isNarrow ? 'text-[8px] font-bold' : 'text-[10px] font-bold';
  const suitSmallSize = isWide ? 'text-base' : isNarrow ? 'text-[9px]' : 'text-xs';
  const suitBigSize = isWide ? 'text-3xl' : isNarrow ? 'text-base' : 'text-xl';

  return (
    <div className={`relative bg-white rounded-md shadow-md select-none border border-gray-200 overflow-hidden ${w}`}>
      <div className={`absolute top-0.5 left-0.5 leading-tight ${color}`}>
        <div className={rankSize}>{rank}</div>
        <div className={`${suitSmallSize} -mt-0.5`}>{symbol}</div>
      </div>
      <div className={`absolute inset-0 flex items-center justify-center ${suitBigSize} ${color}`}>
        {symbol}
      </div>
    </div>
  );
}

function CardBack({ small, large, sizeClass }: { small?: boolean; large?: boolean; sizeClass?: string }) {
  const w = sizeClass
    ? sizeClass
    : large
      ? 'w-14 sm:w-[72px] h-[84px] sm:h-[102px]'
      : small
        ? 'w-9 h-[52px]'
        : 'w-10 sm:w-12 h-[56px] sm:h-[68px]';
  return (
    <div className={`relative rounded-md shadow-md overflow-hidden border border-blue-800 ${w}`}>
      <div className="absolute inset-0 bg-gradient-to-br from-blue-800 to-blue-950" />
      <div className="absolute inset-0.5 rounded border border-blue-600/30 flex items-center justify-center">
        <div className="text-blue-400/50 text-sm">✦</div>
      </div>
    </div>
  );
}

// ── Main component ──

export function PokerTable({
  myPlayer,
  opponents,
  board,
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
}: PokerTableProps) {
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
  // truth so the whole table stays visually proportional. (Tailwind
  // sm: classes are insufficient because the table is bounded by its
  // own max-w container, not the viewport directly.)
  const sizing = (() => {
    if (vp.isMobilePortrait) {
      return {
        avatar: 'w-10 h-10',
        avatarText: 'text-xs',
        plateMinW: 'min-w-[80px]',
        plateMaxW: 'max-w-[90px]',
        plateName: 'text-[10px]',
        plateChips: 'text-[10px]',
        plateStatus: 'text-[8px]',
        cardSmallW: 'w-6 h-[36px]',
        cardLargeW: 'w-9 h-[54px]',
        cardBoardW: 'w-7 h-[42px]',
        positionBadge: 'w-4 h-4 text-[8px]',
        chipGlyph: 'w-3 h-3',
        betText: 'text-[10px]',
      };
    }
    if (vp.isMobileLandscape) {
      return {
        avatar: 'w-10 h-10',
        avatarText: 'text-xs',
        plateMinW: 'min-w-[90px]',
        plateMaxW: 'max-w-[100px]',
        plateName: 'text-[11px]',
        plateChips: 'text-[11px]',
        plateStatus: 'text-[9px]',
        cardSmallW: 'w-7 h-[42px]',
        cardLargeW: 'w-10 h-[60px]',
        cardBoardW: 'w-8 h-[48px]',
        positionBadge: 'w-5 h-5 text-[9px]',
        chipGlyph: 'w-3.5 h-3.5',
        betText: 'text-[11px]',
      };
    }
    if (vp.isTablet) {
      return {
        avatar: 'w-12 h-12',
        avatarText: 'text-sm',
        plateMinW: 'min-w-[120px]',
        plateMaxW: 'max-w-[140px]',
        plateName: 'text-xs',
        plateChips: 'text-[11px]',
        plateStatus: 'text-[9px]',
        cardSmallW: 'w-8 h-[48px]',
        cardLargeW: 'w-12 h-[72px]',
        cardBoardW: 'w-10 h-[60px]',
        positionBadge: 'w-6 h-6 text-[10px]',
        chipGlyph: 'w-4 h-4',
        betText: 'text-sm',
      };
    }
    // desktop
    return {
      avatar: 'w-16 h-16',
      avatarText: 'text-lg',
      plateMinW: 'min-w-[160px]',
      plateMaxW: 'max-w-[180px]',
      plateName: 'text-sm',
      plateChips: 'text-base',
      plateStatus: 'text-[10px]',
      cardSmallW: 'w-9 h-[52px]',
      cardLargeW: 'w-[72px] h-[102px]',
      cardBoardW: 'w-12 h-[68px]',
      positionBadge: 'w-7 h-7 text-[10px]',
      chipGlyph: 'w-5 h-5',
      betText: 'text-base',
    };
  })();



  // ── Stage label ──
  const stageLabel: Record<string, string> = {
    preflop: 'Pre-Flop', flop: 'Flop', turn: 'Turn', river: 'River',
    showdown: 'Showdown', completed: 'Complete', waiting: 'Waiting',
  };

  // Aspect ratio of the table felt area. On wider viewports a 2:1
  // (wide oval) reads as a real poker table. On narrow viewports a
  // taller ratio (1.2:1) gives the player rail room to breathe.
  const tableAspect = vp.isMobile
    ? '60%'     // 1 : 1.67 (taller felt, helps narrow widths)
    : vp.isTablet
      ? '50%'   // 2 : 1
      : '42%';  // 2.4 : 1 (wide felt on desktop)

  return (
    <div
      className="relative w-full mx-auto"
      style={{
        paddingBottom: tableAspect,
        maxWidth: vp.isDesktop ? '960px' : '100%',
        minHeight: '260px',
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
              <img src="/assets/musd-chip.png" alt="" className={vp.isMobile ? 'w-4 h-4' : 'w-6 h-6'} />
              <span className={`text-white font-bold ${vp.isMobile ? 'text-sm' : 'text-xl'}`}>{formatChips(pot)}</span>
              <span className="text-gray-400 text-[10px] uppercase tracking-wider ml-1">{stageLabel[stage] || stage}</span>
            </div>

            {/* Side pot indicator — shows when any player is all-in */}
            {allPlayers.some(p => p.position === 'all_in') && parseInt(pot) > 0 && (
              <div className="flex items-center gap-1.5 bg-black/40 rounded-full px-3 py-1">
                <img src="/assets/musd-chip.png" alt="" className="w-3 h-3 opacity-70" />
                <span className="text-[10px] font-medium" style={{color:'#9c51ff'}}>Side pot active</span>
              </div>
            )}
          </div>

          {/* Community Cards */}
          <div className={`flex ${vp.isMobile ? 'gap-1' : 'gap-2'} justify-center`}>
            {board.length === 0 ? (
              status === 'in_progress' ? (
                <div className={`flex ${vp.isMobile ? 'gap-1' : 'gap-2'}`}>
                  {[0,1,2,3,4].map(i => (
                    <div key={i} className={`${sizing.cardBoardW} rounded-md border border-green-600/30 bg-green-900/30`} />
                  ))}
                </div>
              ) : null
            ) : (
              <>
                {board.map((card: any, i: number) => (
                  <CardFace key={i} card={card} sizeClass={sizing.cardBoardW} />
                ))}
                {Array.from({ length: 5 - board.length }).map((_, i) => (
                  <div key={`empty-${i}`} className={`${sizing.cardBoardW} rounded-md border border-green-600/20 bg-green-900/20`} />
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Player seats ── */}
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

        return (
          <div
            key={player.userId}
            className="absolute transform -translate-x-1/2 -translate-y-1/2 z-10"
            style={{ top: pos.top, left: pos.left }}
          >
            <div className={`
              flex flex-col items-center transition-all duration-300
              ${isEliminated ? 'opacity-30' : ''}
              ${isFolded ? 'opacity-50' : ''}
              ${isActive ? 'scale-110' : ''}
            `}>
              {/* Avatar + Position badge wrapper */}
              <div className="relative">
              {/* Position badge (D/SB/BB) */}
              {player.seatIndex === dealerSeatIndex && !isEliminated && (
                <div className={`absolute -top-1 -right-1 ${sizing.positionBadge} rounded-full flex items-center justify-center font-bold text-black z-10`} style={{background:'#ffffff', boxShadow:'0 1px 4px rgba(0,0,0,0.4)'}}>D</div>
              )}
              {player.seatIndex === sbSeatIndex && player.seatIndex !== dealerSeatIndex && !isEliminated && (
                <div className={`absolute -top-1 -left-1 ${sizing.positionBadge} rounded-full flex items-center justify-center font-bold text-white z-10`} style={{background:'#12ceec', boxShadow:'0 1px 4px rgba(0,0,0,0.4)'}}>SB</div>
              )}
              {player.seatIndex === bbSeatIndex && !isEliminated && (
                <div className={`absolute -top-1 -left-1 ${sizing.positionBadge} rounded-full flex items-center justify-center font-bold text-white z-10`} style={{background:'#9c51ff', boxShadow:'0 1px 4px rgba(0,0,0,0.4)'}}>BB</div>
              )}

              {/* Avatar circle */}
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
              </div>{/* close relative wrapper */}

              {/* Name + chips plate */}
              <div className={`
                mt-1.5 rounded-lg px-2 py-1 text-center ${sizing.plateMinW}
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
                {/* Balance in gold, slightly larger for own seat. */}
                <div className={`${isMe ? `${sizing.plateChips} font-semibold` : sizing.plateStatus} ${isEliminated ? 'text-gray-600' : 'text-amber-400'}`}>
                  {formatChips(player.chipStack)}
                </div>

                {/* Status badges */}
                {isFolded && <div className={`${sizing.plateStatus} text-red-400 font-bold`}>FOLDED</div>}
                {isEliminated && <div className={`${sizing.plateStatus} text-gray-500 font-bold`}>ELIMINATED</div>}
                {isAllIn && <div className={`${sizing.plateStatus} text-purple-400 font-bold animate-pulse`}>ALL IN</div>}


              </div>

              {/* Cards. YOUR hole cards larger for readability.
                  Opponent backs stay small. Sizing comes from `sizing.*`
                  CSS classes so it auto-scales per viewport. */}
              <div className="flex gap-0.5 sm:gap-1 mt-1">
                {isMe ? (
                  player.holeCards.length > 0 ? (
                    player.holeCards.map((card: any, i: number) => (
                      <CardFace key={i} card={card} sizeClass={sizing.cardLargeW} />
                    ))
                  ) : null
                ) : (
                  !isEliminated && !isFolded && (
                    <>
                      <CardBack sizeClass={sizing.cardSmallW} />
                      <CardBack sizeClass={sizing.cardSmallW} />
                    </>
                  )
                )}
              </div>

              {/* Last action + bet indicator.
                  Playtest 2026-05-11 v3: text upsized again ~50%.
                  Chip glyph height matched to the bet number height.
                  Action label is now base size for easy reading. */}
              {(player.lastAction || (player.currentStageBet && parseInt(player.currentStageBet) > 0)) && (
                <div className="flex flex-col items-center mt-1">
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
              )}
            </div>
          </div>
        );
      })}

      {/* ── Action Buttons ──
          Desktop/tablet: positioned beneath the table felt, centred.
          Mobile: position:fixed at the bottom of the viewport so they
          are always reachable regardless of where the user has scrolled.
          All buttons sized for 44px+ touch targets on mobile. */}
      {isMyTurn && status === 'in_progress' && myPlayer.position !== 'folded' && myPlayer.position !== 'eliminated' && myPlayer.position !== 'all_in' && (
        <div
          className={vp.isMobile
            ? 'fixed bottom-0 inset-x-0 z-20 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2'
            : 'absolute bottom-0 left-1/2 transform -translate-x-1/2 translate-y-full pt-6 z-20'}
          style={vp.isMobile ? { paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' } : {}}
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
