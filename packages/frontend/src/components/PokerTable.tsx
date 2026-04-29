import { useState, useEffect, useRef } from 'react';
import { getAvatarSrc } from '../utils/avatars';

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

// Seat positions around an oval table (CSS positions as percentages)
const SEAT_POSITIONS: { top: string; left: string }[] = [
  { top: '85%', left: '50%' },   // 0: bottom center (YOU)
  { top: '75%', left: '13%' },   // 1: bottom-left
  { top: '45%', left: '2%' },    // 2: left
  { top: '12%', left: '10%' },   // 3: top-left
  { top: '2%', left: '33%' },    // 4: top-left-center
  { top: '2%', left: '67%' },    // 5: top-right-center
  { top: '12%', left: '90%' },   // 6: top-right
  { top: '45%', left: '98%' },   // 7: right
  { top: '75%', left: '87%' },   // 8: bottom-right
];

function getRelativeSeatPositions(mySeatIndex: number, totalPlayers: number) {
  const allPlayers: { seatIndex: number; positionIndex: number }[] = [];
  const spacing = 9 / totalPlayers;
  for (let i = 0; i < totalPlayers; i++) {
    const actualSeat = (mySeatIndex + i) % totalPlayers;
    const posIdx = Math.round(i * spacing) % 9;
    allPlayers.push({ seatIndex: actualSeat, positionIndex: posIdx });
  }
  return allPlayers;
}

// ── Card rendering with colored suits ──

const SUIT_SYMBOLS: Record<string, string> = {
  hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠',
};
const SUIT_COLORS: Record<string, string> = {
  hearts: 'text-red-500', diamonds: 'text-red-500',
  clubs: 'text-gray-900', spades: 'text-gray-900',
};

function CardFace({ card, small }: { card: any; small?: boolean }) {
  const suit = card.suit as string;
  const rank = card.rank as string;
  const symbol = SUIT_SYMBOLS[suit] || '?';
  const color = SUIT_COLORS[suit] || 'text-gray-900';
  const w = small ? 'w-9 h-[52px]' : 'w-10 sm:w-12 h-[56px] sm:h-[68px]';

  return (
    <div className={`relative bg-white rounded-md shadow-md select-none border border-gray-200 overflow-hidden ${w}`}>
      <div className={`absolute top-0.5 left-0.5 leading-tight ${color}`}>
        <div className="text-[10px] sm:text-[11px] font-bold">{rank}</div>
        <div className="text-[11px] sm:text-xs -mt-0.5">{symbol}</div>
      </div>
      <div className={`absolute inset-0 flex items-center justify-center text-lg sm:text-2xl ${color}`}>
        {symbol}
      </div>
    </div>
  );
}

function CardBack({ small }: { small?: boolean }) {
  const w = small ? 'w-9 h-[52px]' : 'w-10 sm:w-12 h-[56px] sm:h-[68px]';
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
  const totalPlayers = allPlayers.length;
  const seatLayout = getRelativeSeatPositions(myPlayer.seatIndex, totalPlayers);

  const seatToPlayer = new Map<number, Player>();
  for (const p of allPlayers) {
    seatToPlayer.set(p.seatIndex, p);
  }

  // ── Turn countdown timer ──
  const TURN_TOTAL = 9999; // Timer disabled
  
  const [timeLeft, setTimeLeft] = useState(TURN_TOTAL);
  const warningSoundPlayed = useRef(false);

  useEffect(() => {
    if (!turnStartedAt || status !== 'in_progress') {
      setTimeLeft(TURN_TOTAL);
      warningSoundPlayed.current = false;
      return;
    }
    const interval = setInterval(() => {
      const elapsed = (Date.now() - new Date(turnStartedAt).getTime()) / 1000;
      const remaining = Math.max(0, Math.ceil(TURN_TOTAL - elapsed));
      setTimeLeft(remaining);

      if (remaining <= WARNING_AT && remaining > 0 && isMyTurn && !warningSoundPlayed.current) {
        warningSoundPlayed.current = true;
        try {
          const ctx = new AudioContext();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.frequency.value = 880;
          gain.gain.value = 0.3;
          osc.start();
          osc.stop(ctx.currentTime + 0.2);
        } catch (_) {}
      }
    }, 200);
    return () => clearInterval(interval);
  }, [turnStartedAt, status, isMyTurn]);

  useEffect(() => {
    // Immediately reset timer when active player changes
    setTimeLeft(TURN_TOTAL);
    warningSoundPlayed.current = false;
  }, [activePlayerUserId]);

  const isWarning = false; // Timer disabled

  // ── Stage label ──
  const stageLabel: Record<string, string> = {
    preflop: 'Pre-Flop', flop: 'Flop', turn: 'Turn', river: 'River',
    showdown: 'Showdown', completed: 'Complete', waiting: 'Waiting',
  };

  return (
    <div className="relative w-full mx-auto" style={{ paddingBottom: 'clamp(50%, 40vw, 45%)', maxWidth: '960px', minHeight: '300px' }}>

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

        {/* T3 logos at ends of table */}
        <div className="absolute top-1/2 left-[12%] -translate-y-1/2 select-none">
          <img src="/assets/t3-logo-white.png" alt="T3" className="w-16 h-16 opacity-[0.12]" />
        </div>
        <div className="absolute top-1/2 right-[12%] -translate-y-1/2 select-none">
          <img src="/assets/t3-logo-white.png" alt="T3" className="w-16 h-16 opacity-[0.12]" />
        </div>

        {/* ── Center: Pot + Community Cards ── */}
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-center">
          {/* Pot display */}
          <div className="mb-3 flex flex-col items-center gap-1">
            {/* Main pot */}
            <div className="bg-black/50 backdrop-blur-sm rounded-full px-4 sm:px-5 py-1.5 inline-flex items-center gap-2">
              <img src="/assets/musd-chip.png" alt="" className="w-5 h-5 sm:w-6 sm:h-6" />
              <span className="text-white text-lg sm:text-xl font-bold">{formatChips(pot)}</span>
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
          <div className="flex gap-1 sm:gap-2 justify-center">
            {board.length === 0 ? (
              status === 'in_progress' ? (
                <div className="flex gap-1 sm:gap-2">
                  {[0,1,2,3,4].map(i => (
                    <div key={i} className="w-10 sm:w-12 h-[56px] sm:h-[68px] rounded-md border border-green-600/30 bg-green-900/30" />
                  ))}
                </div>
              ) : null
            ) : (
              <>
                {board.map((card: any, i: number) => (
                  <CardFace key={i} card={card} />
                ))}
                {Array.from({ length: 5 - board.length }).map((_, i) => (
                  <div key={`empty-${i}`} className="w-10 sm:w-12 h-[56px] sm:h-[68px] rounded-md border border-green-600/20 bg-green-900/20" />
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Player seats ── */}
      {seatLayout.map(({ seatIndex, positionIndex }) => {
        const player = seatToPlayer.get(seatIndex);
        if (!player) return null;

        const isMe = player.userId === myPlayer.userId;
        const isActive = player.userId === activePlayerUserId;
        const isFolded = player.position === 'folded';
        const isEliminated = player.position === 'eliminated';
        const isAllIn = player.position === 'all_in';
        const pos = SEAT_POSITIONS[positionIndex];

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
                <div className="absolute -top-1 -right-1 w-6 h-6 sm:w-7 sm:h-7 rounded-full flex items-center justify-center text-[9px] sm:text-[10px] font-bold text-black z-10" style={{background:'#ffffff', boxShadow:'0 1px 4px rgba(0,0,0,0.4)'}}>D</div>
              )}
              {player.seatIndex === sbSeatIndex && player.seatIndex !== dealerSeatIndex && !isEliminated && (
                <div className="absolute -top-1 -left-1 w-6 h-6 sm:w-7 sm:h-7 rounded-full flex items-center justify-center text-[9px] sm:text-[10px] font-bold text-white z-10" style={{background:'#12ceec', boxShadow:'0 1px 4px rgba(0,0,0,0.4)'}}>SB</div>
              )}
              {player.seatIndex === bbSeatIndex && !isEliminated && (
                <div className="absolute -top-1 -left-1 w-6 h-6 sm:w-7 sm:h-7 rounded-full flex items-center justify-center text-[9px] sm:text-[10px] font-bold text-white z-10" style={{background:'#9c51ff', boxShadow:'0 1px 4px rgba(0,0,0,0.4)'}}>BB</div>
              )}

              {/* Avatar circle */}
              <div className={`
                w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center text-sm sm:text-lg font-bold shadow-lg overflow-hidden
                ${isActive && isWarning ? 'animate-pulse' : ''}
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
                mt-1.5 rounded-lg px-3 sm:px-4 py-1.5 text-center min-w-[120px] sm:min-w-[160px]
                ${isActive ? 'bg-yellow-900/80 border border-yellow-500/50' :
                  isMe ? 'bg-green-900/80 border border-green-600/40' :
                  'bg-gray-900/80 border border-gray-700/40'}
              `}>
                <div className={`text-xs sm:text-sm font-semibold truncate max-w-[90px] sm:max-w-[140px] ${
                  isActive ? 'text-yellow-200' :
                  isMe ? 'text-green-300' :
                  isFolded ? 'text-gray-500' :
                  'text-white'
                }`}>
                  {player.username}{isMe ? ' (You)' : ''}
                </div>
                <div className={`text-[11px] sm:text-xs ${isEliminated ? 'text-gray-600' : 'text-yellow-400/80'}`}>
                  {formatChips(player.chipStack)}
                </div>

                {/* Status badges */}
                {isFolded && <div className="text-[9px] text-red-400 font-bold">FOLDED</div>}
                {isEliminated && <div className="text-[9px] text-gray-500 font-bold">ELIMINATED</div>}
                {isAllIn && <div className="text-[9px] text-purple-400 font-bold animate-pulse">ALL IN</div>}

                {/* Timer bar - HIDDEN */}
                {false && (
                  <div className="mt-1">
                    <div className="h-1 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-200 ${
                          isWarning ? 'bg-red-500 animate-pulse' : 'bg-green-400'
                        }`}
                        style={{ width: `${(timeLeft / TURN_TOTAL) * 100}%` }}
                      />
                    </div>
                    <div className={`text-[9px] text-center mt-0.5 font-mono ${
                      isWarning ? 'text-red-400' : 'text-gray-500'
                    }`}>
                      {timeLeft}s
                    </div>
                  </div>
                )}
              </div>

              {/* Cards */}
              <div className="flex gap-0.5 sm:gap-1 mt-1">
                {isMe ? (
                  player.holeCards.length > 0 ? (
                    player.holeCards.map((card: any, i: number) => (
                      <CardFace key={i} card={card} small />
                    ))
                  ) : null
                ) : (
                  !isEliminated && !isFolded && (
                    <>
                      <CardBack small />
                      <CardBack small />
                    </>
                  )
                )}
              </div>

              {/* Last action + bet indicator */}
              {(player.lastAction || (player.currentStageBet && parseInt(player.currentStageBet) > 0)) && (
                <div className="flex items-center gap-1 mt-1">
                  {player.currentStageBet && parseInt(player.currentStageBet) > 0 && (
                    <>
                      <img src="/assets/musd-chip.png" alt="" className="w-3.5 h-3.5" />
                      <span className="text-[10px] font-semibold text-white">{formatChips(player.currentStageBet)}</span>
                    </>
                  )}
                  {player.lastAction && player.lastAction !== 'blind' && (
                    <span className={`text-[9px] font-bold uppercase ml-1 ${
                      player.lastAction === 'fold' ? 'text-red-400' :
                      player.lastAction === 'raise' ? 'text-yellow-400' :
                      player.lastAction === 'all-in' ? 'text-purple-400' :
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

      {/* ── Action Buttons ── */}
      {isMyTurn && status === 'in_progress' && myPlayer.position !== 'folded' && myPlayer.position !== 'eliminated' && myPlayer.position !== 'all_in' && (
        <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 translate-y-full pt-4 sm:pt-6 z-20 w-full px-2 sm:w-auto sm:px-0">
          <div className="flex gap-1.5 sm:gap-2 rounded-2xl p-2 sm:p-3 border border-white/5 shadow-2xl justify-center" style={{background:'rgba(38,38,38,0.95)', backdropFilter:'blur(8px)'}}>
            <button
              onClick={onFold}
              disabled={actionLoading}
              className="px-3 sm:px-5 py-2 sm:py-2.5 bg-red-600 text-white rounded-xl hover:bg-red-700 transition font-semibold disabled:opacity-50 text-sm flex items-center gap-1.5 shadow-lg"
            >
              <span>✕</span> Fold
            </button>
            {parseInt(amountToCall || '0') === 0 ? (
              <button
                onClick={onCheck}
                disabled={actionLoading}
                className="px-3 sm:px-5 py-2 sm:py-2.5 bg-yellow-600 text-white rounded-xl hover:bg-yellow-700 transition font-semibold disabled:opacity-50 text-sm flex items-center gap-1.5 shadow-lg"
              >
                <span>✓</span> Check
              </button>
            ) : (
              <button
                onClick={onCall}
                disabled={actionLoading}
                className="px-3 sm:px-5 py-2 sm:py-2.5 bg-green-600 text-white rounded-xl hover:bg-green-700 transition font-semibold disabled:opacity-50 text-sm flex items-center gap-1.5 shadow-lg"
              >
                <span>📞</span> Call {formatChips(amountToCall)}
              </button>
            )}
            <button
              onClick={onRaise}
              disabled={actionLoading}
              className="px-3 sm:px-5 py-2 sm:py-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition font-semibold disabled:opacity-50 text-sm flex items-center gap-1.5 shadow-lg"
            >
              <span>⬆</span> Raise
            </button>
            <button
              onClick={onAllIn}
              disabled={actionLoading}
              className="px-3 sm:px-5 py-2 sm:py-2.5 bg-purple-600 text-white rounded-xl hover:bg-purple-700 transition font-semibold disabled:opacity-50 text-sm flex items-center gap-1.5 shadow-lg"
            >
              <span>💎</span> All In
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
