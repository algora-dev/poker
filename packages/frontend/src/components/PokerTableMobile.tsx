/**
 * PokerTableMobile — vertically stacked layout for mobile portrait.
 *
 * The desktop/tablet PokerTable uses an absolute-positioned oval. That
 * works great at 1280px+ but is unusable below ~600px wide because
 * 9 seats around an oval don't fit when each seat needs an avatar +
 * name plate + chip stack + bet badge + 2 cards.
 *
 * This component is a separate render path used by GameRoom when
 * `viewport.isMobilePortrait`. Layout, top-to-bottom:
 *
 *   1. Opponents strip   (horizontal scroll-snap row, ~84px tall)
 *   2. Community cards + pot
 *   3. Last actions / stage label
 *   4. Your seat: avatar + name + stack + hole cards
 *   5. Action buttons (sticky bottom)
 *
 * Notes:
 *   - All inputs are the same as PokerTable so swapping components is a
 *     one-line decision in GameRoom.
 *   - Dealer/SB/BB badges still shown on each opponent and on your seat.
 *   - Active player gets the same yellow ring as the oval layout.
 *   - Folded/eliminated opponents render dimmed; all-in shows ALL IN badge.
 *
 * Card images and audio are reused from PokerTable component scope-wise
 * but redefined locally since the originals weren't exported. Tiny code
 * duplication is worth the layout isolation.
 */

import { getAvatarSrc } from '../utils/avatars';
import { PlayingCard, CardBack } from './PlayingCard';

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

interface Props {
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
  onFold: () => void;
  onCheck: () => void;
  onCall: () => void;
  onRaise: () => void;
  onAllIn: () => void;
  actionLoading: boolean;
  /**
   * Between-hands flag (Shaun 2026-05-14). True from hand-end until
   * game:new-hand fires. While true, the felt is empty and no hole
   * cards are shown.
   */
  betweenHands?: boolean;
}

// Card rendering uses the single source-of-truth <PlayingCard/> /
// <CardBack/> components imported at the top of this file. Mobile
// face-down opponent slots use size 'xs', felt-board cards use 'sm',
// hero hole cards use 'md'. Don't reintroduce a Mini* fork here.

function PositionBadge({ kind }: { kind: 'D' | 'SB' | 'BB' }) {
  const style =
    kind === 'D' ? { background: '#ffffff', color: '#000' } :
    kind === 'SB' ? { background: '#12ceec', color: '#fff' } :
                    { background: '#9c51ff', color: '#fff' };
  return (
    <span className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[8px] font-bold" style={style}>
      {kind}
    </span>
  );
}

export function PokerTableMobile({
  myPlayer: _myPlayer,
  opponents: _opponents,
  board: _board,
  pot,
  currentBet: _currentBet,
  stage,
  isMyTurn,
  activePlayerUserId,
  turnStartedAt: _turnStartedAt,
  dealerSeatIndex = -1,
  sbSeatIndex = -1,
  bbSeatIndex = -1,
  status,
  amountToCall,
  formatChips,
  onFold,
  onCheck,
  onCall,
  onRaise,
  onAllIn,
  actionLoading,
  betweenHands,
}: Props) {
  // Between-hands felt-clear: empty board + empty hole cards everywhere
  // until the deal animation fires on game:new-hand.
  const board = betweenHands ? [] : _board;
  const myPlayer = betweenHands ? { ..._myPlayer, holeCards: [] } : _myPlayer;
  const opponents = betweenHands ? _opponents.map(o => ({ ...o, holeCards: [] })) : _opponents;
  const stageLabel: Record<string, string> = {
    preflop: 'Pre-Flop', flop: 'Flop', turn: 'Turn', river: 'River',
    showdown: 'Showdown', completed: 'Complete', waiting: 'Waiting',
  };

  const sideOpponents = [...opponents].sort((a, b) => a.seatIndex - b.seatIndex);

  return (
    // pb leaves room for the sticky action bar so nothing renders under it.
    <div className="w-full pb-[110px]">

      {/* ── Opponents strip ── */}
      <div className="overflow-x-auto -mx-2 px-2 pb-2 scrollbar-hide">
        <div className="flex gap-2 snap-x snap-mandatory">
          {sideOpponents.map(p => {
            const isActive = p.userId === activePlayerUserId;
            const isFolded = p.position === 'folded';
            const isEliminated = p.position === 'eliminated';
            const isAllIn = p.position === 'all_in';
            const initial = p.username.charAt(0).toUpperCase();
            const av = getAvatarSrc(p.avatarId);
            return (
              <div
                key={p.userId}
                className={`flex-shrink-0 snap-start flex flex-col items-center rounded-xl p-2 min-w-[88px] border ${
                  isActive ? 'bg-yellow-900/40 border-yellow-500/50' :
                  isAllIn ? 'bg-purple-900/30 border-purple-500/40' :
                  isFolded || isEliminated ? 'bg-gray-900/40 border-white/5 opacity-60' :
                  'bg-gray-900/40 border-white/10'
                }`}
              >
                <div className="relative">
                  <div className={`w-12 h-12 rounded-full overflow-hidden flex items-center justify-center text-sm font-bold ${
                    isActive ? 'ring-2 ring-yellow-400' :
                    isAllIn ? 'ring-2 ring-purple-500' :
                    'ring-1 ring-gray-600'
                  } ${!av ? 'bg-gray-700 text-white' : ''}`}>
                    {av ? <img src={av} alt={p.username} className="w-full h-full object-cover" /> : initial}
                  </div>
                  <div className="absolute -top-1 -right-1 flex flex-col items-end gap-0.5">
                    {p.seatIndex === dealerSeatIndex && <PositionBadge kind="D" />}
                  </div>
                  <div className="absolute -top-1 -left-1 flex flex-col items-start gap-0.5">
                    {p.seatIndex === sbSeatIndex && p.seatIndex !== dealerSeatIndex && <PositionBadge kind="SB" />}
                    {p.seatIndex === bbSeatIndex && <PositionBadge kind="BB" />}
                  </div>
                </div>
                <div className="mt-1 text-center w-full">
                  <div className={`text-[10px] font-semibold truncate ${isFolded ? 'text-gray-500' : 'text-white'}`}>
                    {p.username}
                  </div>
                  <div className={`text-[10px] font-semibold ${isEliminated ? 'text-gray-600' : 'text-amber-400'}`}>
                    {formatChips(p.chipStack)}
                  </div>
                </div>
                {/* Cards / status */}
                <div className="h-[40px] flex items-center justify-center mt-1 gap-0.5">
                  {isEliminated ? (
                    <span className="text-[9px] text-gray-500 font-bold">OUT</span>
                  ) : isFolded ? (
                    <span className="text-[9px] text-red-400 font-bold">FOLD</span>
                  ) : isAllIn ? (
                    <span className="text-[9px] text-purple-400 font-bold animate-pulse">ALL IN</span>
                  ) : (
                    <>
                      <CardBack size="xs" />
                      <CardBack size="xs" />
                    </>
                  )}
                </div>
                {/* Current stage bet */}
                {p.currentStageBet && parseInt(p.currentStageBet) > 0 && (
                  <div className="mt-1 flex items-center gap-1">
                    <img src="/assets/musd-chip.png" alt="" className="w-2.5 h-2.5" />
                    <span className="text-[10px] font-bold text-white">{formatChips(p.currentStageBet)}</span>
                  </div>
                )}
                {/* Last action */}
                {p.lastAction && p.lastAction !== 'blind' && (
                  <div className={`text-[9px] font-bold uppercase mt-0.5 ${
                    p.lastAction === 'fold' ? 'text-red-400' :
                    p.lastAction === 'raise' ? 'text-yellow-400' :
                    p.lastAction === 'all-in' ? 'text-purple-400' :
                    p.lastAction === 'call' ? 'text-blue-300' :
                    p.lastAction === 'check' ? 'text-emerald-300' :
                    'text-gray-400'
                  }`}>
                    {p.lastAction === 'call' ? 'Call' :
                     p.lastAction === 'raise' ? 'Raise' :
                     p.lastAction === 'check' ? 'Check' :
                     p.lastAction === 'all-in' ? 'All In' :
                     p.lastAction === 'fold' ? 'Fold' : ''}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Felt strip: pot + community cards ── */}
      <div
        className="rounded-2xl p-3 mt-1 border border-white/10"
        style={{
          background: 'radial-gradient(ellipse at center, #1a6b3c 0%, #145a30 60%, #0e4423 100%)',
          boxShadow: 'inset 0 0 30px rgba(0,0,0,0.5)',
        }}
      >
        {/* Pot */}
        <div className="flex justify-center mb-2">
          <div className="bg-black/50 backdrop-blur-sm rounded-full px-3 py-1 inline-flex items-center gap-1.5">
            <img src="/assets/musd-chip.png" alt="" className="w-4 h-4" />
            <span className="text-white text-sm font-bold">{formatChips(pot)}</span>
            <span className="text-gray-400 text-[9px] uppercase tracking-wider ml-1">
              {stageLabel[stage] || stage}
            </span>
          </div>
        </div>
        {/* Community cards */}
        <div className="flex gap-1 justify-center">
          {board.length === 0 ? (
            status === 'in_progress' ? (
              <div className="flex gap-1">
                {[0,1,2,3,4].map(i => (
                  <div key={i} className="w-[32px] h-[46px] rounded-md border border-green-600/30 bg-green-900/30" />
                ))}
              </div>
            ) : null
          ) : (
            <>
              {board.map((card: any, i: number) => (
                <PlayingCard key={i} card={card} size="sm" />
              ))}
              {Array.from({ length: 5 - board.length }).map((_, i) => (
                <div key={`empty-${i}`} className="w-[32px] h-[46px] rounded-md border border-green-600/20 bg-green-900/20" />
              ))}
            </>
          )}
        </div>
      </div>

      {/* ── Your seat ── */}
      <div className={`mt-3 rounded-2xl p-3 border ${
        isMyTurn ? 'bg-yellow-900/30 border-yellow-500/50' :
        myPlayer.position === 'all_in' ? 'bg-purple-900/30 border-purple-500/40' :
        myPlayer.position === 'folded' ? 'bg-gray-900/50 border-white/5 opacity-70' :
        'bg-green-900/30 border-green-500/30'
      }`}>
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className={`w-14 h-14 rounded-full overflow-hidden flex items-center justify-center text-sm font-bold ${
              isMyTurn ? 'ring-2 ring-yellow-400' :
              myPlayer.position === 'all_in' ? 'ring-2 ring-purple-500' :
              'ring-2 ring-green-400'
            } ${!getAvatarSrc(myPlayer.avatarId) ? 'bg-green-800 text-green-200' : ''}`}>
              {getAvatarSrc(myPlayer.avatarId)
                ? <img src={getAvatarSrc(myPlayer.avatarId)!} alt={myPlayer.username} className="w-full h-full object-cover" />
                : myPlayer.username.charAt(0).toUpperCase()}
            </div>
            <div className="absolute -top-1 -right-1">
              {myPlayer.seatIndex === dealerSeatIndex && <PositionBadge kind="D" />}
            </div>
            <div className="absolute -top-1 -left-1">
              {myPlayer.seatIndex === sbSeatIndex && myPlayer.seatIndex !== dealerSeatIndex && <PositionBadge kind="SB" />}
              {myPlayer.seatIndex === bbSeatIndex && <PositionBadge kind="BB" />}
            </div>
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-white">{myPlayer.username} <span className="text-green-400 text-xs">(You)</span></div>
            <div className="text-base font-bold text-amber-400">{formatChips(myPlayer.chipStack)}</div>
            {myPlayer.position === 'folded' && <div className="text-[10px] text-red-400 font-bold">FOLDED</div>}
            {myPlayer.position === 'all_in' && <div className="text-[10px] text-purple-400 font-bold animate-pulse">ALL IN</div>}
            {myPlayer.position === 'eliminated' && <div className="text-[10px] text-gray-500 font-bold">ELIMINATED</div>}
          </div>
          {/* Hole cards on the right of your seat row */}
          <div className="flex gap-1">
            {myPlayer.holeCards.length > 0
              ? myPlayer.holeCards.map((c: any, i: number) => <PlayingCard key={i} card={c} size="md" />)
              : null}
          </div>
        </div>
        {/* Current stage bet for you, if any */}
        {myPlayer.currentStageBet && parseInt(myPlayer.currentStageBet) > 0 && (
          <div className="mt-2 flex items-center gap-1.5 justify-center">
            <img src="/assets/musd-chip.png" alt="" className="w-3.5 h-3.5" />
            <span className="text-sm font-semibold text-white">Your bet: {formatChips(myPlayer.currentStageBet)}</span>
          </div>
        )}
      </div>

      {/* ── Action Buttons — sticky bottom on mobile ── */}
      {isMyTurn && status === 'in_progress' && myPlayer.position !== 'folded' && myPlayer.position !== 'eliminated' && myPlayer.position !== 'all_in' && (
        <div
          className="fixed bottom-0 inset-x-0 z-20 px-2 pt-2"
          style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
        >
          <div
            className="flex gap-1.5 rounded-2xl p-2 border border-white/10 shadow-2xl"
            style={{ background: 'rgba(38,38,38,0.95)', backdropFilter: 'blur(8px)' }}
          >
            <button
              onClick={onFold}
              disabled={actionLoading}
              className="flex-1 px-1 py-3 min-h-[44px] bg-red-600 text-white rounded-xl active:bg-red-700 transition font-semibold disabled:opacity-50 text-sm flex items-center justify-center gap-1"
            >
              ✕ Fold
            </button>
            {parseInt(amountToCall || '0') === 0 ? (
              <button
                onClick={onCheck}
                disabled={actionLoading}
                className="flex-1 px-1 py-3 min-h-[44px] bg-yellow-600 text-white rounded-xl active:bg-yellow-700 transition font-semibold disabled:opacity-50 text-sm flex items-center justify-center gap-1"
              >
                ✓ Check
              </button>
            ) : (
              <button
                onClick={onCall}
                disabled={actionLoading}
                className="flex-1 px-1 py-3 min-h-[44px] bg-green-600 text-white rounded-xl active:bg-green-700 transition font-semibold disabled:opacity-50 text-xs flex items-center justify-center gap-1"
              >
                📞 Call {formatChips(amountToCall)}
              </button>
            )}
            <button
              onClick={onRaise}
              disabled={actionLoading}
              className="flex-1 px-1 py-3 min-h-[44px] bg-blue-600 text-white rounded-xl active:bg-blue-700 transition font-semibold disabled:opacity-50 text-sm flex items-center justify-center gap-1"
            >
              ⬆ {(stage !== 'preflop' && parseInt(_currentBet || '0') === 0) ? 'Bet' : 'Raise'}
            </button>
            <button
              onClick={onAllIn}
              disabled={actionLoading}
              className="flex-1 px-1 py-3 min-h-[44px] bg-purple-600 text-white rounded-xl active:bg-purple-700 transition font-semibold disabled:opacity-50 text-sm flex items-center justify-center gap-1"
            >
              💎 All In
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
