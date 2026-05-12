import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { api } from '../services/api';
import { useSocket } from '../hooks/useSocket';
import { playTurnNotification, showTurnNotification, requestNotificationPermission, initAudioContext } from '../utils/sounds';
import { ShowdownModal } from '../components/ShowdownModal';
import { PokerTable } from '../components/PokerTable';
import { TurnTimer } from '../components/TurnTimer';
import { AudioToggle } from '../components/AudioToggle';
import { playCheckSound } from '../utils/gameAudio';

interface PlayerInfo {
  userId: string;
  username: string;
  seatIndex: number;
  chipStack: string;
  holeCards: any[];
  position: string;
}

interface GameState {
  gameId: string;
  gameName: string;
  status: string;
  creatorId: string;
  smallBlind: string;
  bigBlind: string;
  pot: string;
  currentBet: string;
  amountToCall: string;
  stage: string;
  board: any[];
  playerCount: number;
  myPlayer: PlayerInfo;
  opponents: PlayerInfo[];
  opponent: PlayerInfo | null; // backward compat
  isMyTurn: boolean;
  activePlayerUserId?: string;
  turnStartedAt?: string;
  dealerSeatIndex?: number;
  sbSeatIndex?: number;
  bbSeatIndex?: number;
}

export default function GameRoom() {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const { socket, isConnected } = useSocket();
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [showRaiseModal, setShowRaiseModal] = useState(false);
  const [raiseAmount, setRaiseAmount] = useState('');
  const [gameCompleted, setGameCompleted] = useState(false);
  const [showdownData, setShowdownData] = useState<any>(null);
  const [foldWinData, setFoldWinData] = useState<any>(null);
  const [nextHandCountdown, setNextHandCountdown] = useState<number | null>(null);
  const previousTurn = useRef<boolean>(false);
  // Final standings snapshot captured BEFORE closeGame zeroes every chipStack.
  // closeGame refunds in-table chipStack back to off-table ChipBalance and
  // writes 0 to every GamePlayer.chipStack — so the post-close gameState
  // legitimately shows everyone at 0. We keep the last in-progress stacks
  // here so the Game Over modal can show meaningful final standings.
  const finalStandingsRef = useRef<Array<{ userId: string; username: string; chipStack: string }> | null>(null);
  const [finalStandings, setFinalStandings] = useState<Array<{ userId: string; username: string; chipStack: string }> | null>(null);

  // Snapshot the last meaningful (non-zero) stacks so the Game Over modal
  // can render real final standings even after closeGame zeroes chipStack.
  // Fires on EVERY state push while game is still in_progress; the last
  // one before status flips to 'completed' wins.
  const captureFinalStandingsIfNeeded = (state: any) => {
    if (!state) return;
    if (state.status !== 'in_progress') return;
    const allPlayers = [state.myPlayer, ...(state.opponents || [])].filter(Boolean);
    if (allPlayers.length === 0) return;
    const totalChips = allPlayers.reduce(
      (sum: number, p: any) => sum + parseFloat(p.chipStack || '0'),
      0
    );
    if (totalChips <= 0) return;
    const snap = allPlayers.map((p: any) => ({
      userId: p.userId,
      username: p.username,
      chipStack: p.chipStack,
    }));
    finalStandingsRef.current = snap;
    setFinalStandings(snap);
  };

  // Load game state
  const loadGameState = async (showLoader = false) => {
    if (!gameId) return;

    try {
      if (showLoader) setLoading(true);
      const response = await api.get(`/api/games/${gameId}/state`);
      captureFinalStandingsIfNeeded(response.data);
      setGameState(response.data);
      setError('');
      
      // Don't auto-set gameCompleted - only showdown event should do that
      // (Otherwise old modal shows instead of showdown modal)
      
      // Detect turn change - play notification if it just became your turn
      const isNowMyTurn = response.data.isMyTurn;
      const wasMyTurn = previousTurn.current;
      
      if (isNowMyTurn && !wasMyTurn && !loading) {
        // Turn just switched to you!
        playTurnNotification();
        showTurnNotification();
      }
      
      previousTurn.current = isNowMyTurn;
    } catch (err: any) {
      console.error('Load game state error:', err);
      const status = err.response?.status;
      const msg = err.response?.data?.message || '';

      // Server says we're not in this game (404, or explicit 'You are not
      // in this game'). This used to fall through silently, leaving the
      // UI rendering stale gameState.myPlayer at the bottom of the table
      // forever (the 'phantom seat' bug Shaun hit 2026-05-11 — he saw
      // himself + no bots even though server-side only the bots were
      // seated). Bounce to lobby instead.
      const notInGame =
        status === 404 ||
        /not in this game/i.test(msg) ||
        /game not found/i.test(msg);
      if (notInGame) {
        setGameState(null);
        navigate('/lobby');
        return;
      }

      // Only show error if we don't have any game state yet (initial load).
      // Don't kick player out for transient refresh errors.
      if (!gameState) {
        setError(msg || 'Failed to load game');
      }
    } finally {
      setLoading(false);
    }
  };

  // FALLBACK POLLING: if socket fails, poll every 15 seconds as safety net
  useEffect(() => {
    if (!gameId || !gameState || gameState.status !== 'in_progress') return;
    const interval = setInterval(() => {
      loadGameState();
    }, 15000);
    return () => clearInterval(interval);
  }, [gameId, gameState?.status]);

  useEffect(() => {
    loadGameState(true); // Show loader on initial load only
    
    // Request notification permission
    requestNotificationPermission();
  }, [gameId]);

  // Real-time updates
  useEffect(() => {
    if (!socket || !gameId) return;

    // Join game room
    socket.emit('join:game', gameId);

    // On reconnect, rejoin room and reload state
    const onReconnect = () => {
      socket.emit('join:game', gameId);
      loadGameState();
    };
    socket.on('connect', onReconnect);

    // Instant action event — update everything from socket data directly.
    //
    // Playtest 2026-05-11 surfaced two UX bugs in this merge path:
    //   (a) "Your turn" alert fired up to 5s late because it was only
    //       wired into the polling loadGameState(), not the socket push.
    //   (b) Check->Call flicker on the action buttons: when a peer raised
    //       just before our turn, the UI briefly showed Check (because
    //       amountToCall was still 0 from before the merge applied) and
    //       then snapped to Call. Cause was that React batched setState
    //       didn't apply atomically with the alert-firing block; we now
    //       compute the new my-state in one place and use it for both.
    socket.on('game:action', (data: any) => {
      if (data?.action === 'check') playCheckSound();

      let firedTurnAlert = false;
      setGameState(prev => {
        if (!prev) return prev;

        const newCurrentBet = data.currentBet || prev.currentBet;
        const isNowMyTurn = data.nextPlayer === user?.id;
        const wasMyTurn = prev.isMyTurn;

        // Update opponents' last action + chip-on-felt amount.
        const updatedOpponents = prev.opponents?.map((o: any) => ({
          ...o,
          lastAction: o.userId === data.userId ? data.action : o.lastAction,
          currentStageBet: o.userId === data.userId && data.actionAmount
            ? String(parseInt(o.currentStageBet || '0') + parseInt(data.actionAmount || '0'))
            : o.currentStageBet,
        })) || [];

        // Update my player. If I'm the one who acted, record my lastAction
        // + grow my own stage bet by data.actionAmount. If a NEW turn just
        // landed on me (peer's action made me active), clear any stale
        // lastAction from this hand so the action label doesn't briefly
        // misrepresent the current button state.
        let updatedMyPlayer = prev.myPlayer;
        if (data.userId === prev.myPlayer.userId) {
          updatedMyPlayer = {
            ...prev.myPlayer,
            lastAction: data.action,
            currentStageBet: data.actionAmount
              ? String(parseInt(prev.myPlayer.currentStageBet || '0') + parseInt(data.actionAmount || '0'))
              : prev.myPlayer.currentStageBet,
          };
        } else if (isNowMyTurn && !wasMyTurn) {
          // New turn landed on us. Clear stale lastAction so we don't show
          // "Check" on our seat while the Call button is mid-flicker.
          updatedMyPlayer = { ...prev.myPlayer, lastAction: null };
        }

        // Always recompute amountToCall when it's our turn, from the
        // authoritative new currentBet + our latest stage contribution.
        // This is what closes the check->call flicker for good.
        const myStageBet = parseInt(updatedMyPlayer.currentStageBet || '0');
        const newCurrentBetN = parseInt(newCurrentBet || '0');
        const amountToCall = isNowMyTurn
          ? String(Math.max(0, newCurrentBetN - myStageBet))
          : prev.amountToCall;

        // Instant turn-alert: socket-driven, no 0-5s polling delay.
        if (isNowMyTurn && !wasMyTurn) {
          firedTurnAlert = true;
        }

        return {
          ...prev,
          isMyTurn: isNowMyTurn,
          activePlayerUserId: data.nextPlayer || prev.activePlayerUserId,
          pot: data.pot || prev.pot,
          currentBet: newCurrentBet,
          amountToCall,
          stage: data.stage || prev.stage,
          myPlayer: updatedMyPlayer,
          opponents: updatedOpponents,
        };
      });

      // Side-effect after the state commit, NOT inside the reducer (no
      // double-fires under StrictMode).
      if (firedTurnAlert) {
        previousTurn.current = true;
        try { playTurnNotification(); } catch { /* audio context not ready */ }
        try { showTurnNotification(); } catch { /* notifications denied */ }
      }

      // Full state refresh handled by game:state broadcast from server
    });

    // Full game state from server. Fire the turn alert here too —
    // game:state pushes can arrive before/instead of game:action when the
    // server broadcasts a fresh personalized state, so without this the
    // alert can still feel laggy. previousTurn.current acts as a 1-trip
    // dedupe key, matching the game:action path.
    socket.on('game:state', (state: any) => {
      if (!state) return;
      const wasMyTurn = previousTurn.current;
      const isNowMyTurn = !!state.isMyTurn;
      captureFinalStandingsIfNeeded(state);
      setGameState(state);
      setLoading(false);
      if (isNowMyTurn && !wasMyTurn) {
        previousTurn.current = true;
        try { playTurnNotification(); } catch { /* audio context not ready */ }
        try { showTurnNotification(); } catch { /* notifications denied */ }
      } else if (!isNowMyTurn && wasMyTurn) {
        previousTurn.current = false;
      }
    });

    socket.on('game:started', () => {
      loadGameState(); // Initial hand setup — need full load
    });

    socket.on('player:joined', () => {
      loadGameState(); // Player count changed — need full load
    });

    socket.on('game:showdown', (data: any) => {
      setShowdownData(data);
    });

    socket.on('game:fold-win', (data: any) => {
      setFoldWinData(data);
    });

    socket.on('game:next-hand-countdown', (data: any) => {
      // Start countdown timer
      let remaining = data.seconds || 20;
      setNextHandCountdown(remaining);
      const interval = setInterval(() => {
        remaining--;
        setNextHandCountdown(remaining);
        if (remaining <= 0) clearInterval(interval);
      }, 1000);
    });

    socket.on('game:new-hand', () => {
      setShowdownData(null);
      setFoldWinData(null);
      setGameCompleted(false);
      setNextHandCountdown(null);
      // State will come via game:state event from broadcastGameState
    });

    socket.on('game:turn-warning', () => {
      // Timer warning — no reload needed, frontend timer handles display
    });

    return () => {
      socket.off('connect');
      socket.off('game:action');
      socket.off('game:updated');
      socket.off('game:state');
      socket.off('game:started');
      socket.off('player:joined');
      socket.off('game:fold-win');
      socket.off('game:showdown');
      socket.off('game:new-hand');
      socket.off('game:next-hand-countdown');
      socket.off('game:turn-warning');
      socket.emit('leave:game', gameId);
    };
  }, [socket, gameId]);

  const formatChips = (chips: string) => {
    return (parseInt(chips) / 1_000_000).toFixed(2);
  };

  const handleAction = async (action: string, raiseAmt?: number) => {
    if (!gameId) return;

    // Initialize audio on first click
    initAudioContext();

    setActionLoading(true);
    setError('');

    // Immediately mark as not-my-turn so buttons hide instantly
    setGameState(prev => prev ? ({ ...prev, isMyTurn: false }) : prev);

    try {
      await api.post(`/api/games/${gameId}/action`, {
        action,
        raiseAmount: raiseAmt,
      });
      // Socket.io will handle state updates
    } catch (err: any) {
      setError(err.response?.data?.message || `Failed to ${action}`);
      console.error('Action error:', err);
      // Restore turn if action failed
      loadGameState();
    } finally {
      setActionLoading(false);
    }
  };

  const handleFold = () => handleAction('fold');
  const handleCheck = () => handleAction('check');
  const handleCall = () => handleAction('call');
  
  const handleRaiseClick = () => {
    setShowRaiseModal(true);
    setRaiseAmount((parseFloat(gameState?.currentBet || '0') / 1_000_000 * 2).toFixed(2));
  };

  const handleRaiseConfirm = () => {
    setShowRaiseModal(false);
    handleAction('raise', parseFloat(raiseAmount));
  };

  const handleCancelGame = async () => {
    if (!gameId) return;
    
    if (!confirm('Are you sure you want to cancel this game? Your buy-in will be refunded.')) {
      return;
    }

    try {
      await api.post(`/api/games/${gameId}/cancel`);
      navigate('/lobby');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to cancel game');
    }
  };

  /**
   * Leave the table.
   *
   *  - waiting status: chips are refunded immediately to off-table balance.
   *    If you're the last player, the game is cancelled.
   *  - in_progress status: you forfeit any open-hand commitments, but your
   *    remaining chip stack is paid out when the game ends. This unblocks
   *    your account so you can join other games / withdraw, once the
   *    server-side active-game lock releases (i.e. once the table
   *    eventually closes via natural completion or admin cancel).
   *
   * The leave button used to just `navigate('/lobby')` which left the
   * GamePlayer row intact server-side, locking the user out of new games
   * with the very confusing error "You are already in this game". Reported
   * by Shaun 2026-05-11.
   */
  const handleLeaveGame = async () => {
    if (!gameId) return;

    const status = gameState?.status;
    const message = status === 'in_progress'
      ? 'Leave the table?\n\nYou will forfeit the current hand. Your remaining chips will be paid out when the game ends (you stay seated until then).'
      : 'Leave the table? Your buy-in will be refunded.';

    if (!confirm(message)) return;

    try {
      await api.post(`/api/games/${gameId}/leave`);
      // Disconnect from the socket room politely on the way out so peers
      // get an updated player list without waiting for socket timeout.
      try { socket?.emit('leave:game', gameId); } catch { /* socket may be down */ }
      navigate('/lobby');
    } catch (err: any) {
      // 400 with a message means the server rejected a leave (e.g.
      // mid-stuck state); fall back to navigating anyway so the user
      // isn't trapped in the room. The lobby's 'You are already in this
      // game' guard will surface the truth.
      const msg = err.response?.data?.message || 'Failed to leave table';
      setError(msg);
      // Still navigate — better UX than trapping the user.
      navigate('/lobby');
    }
  };

  const formatCard = (card: any) => {
    if (!card || !card.rank || !card.suit) return '??';
    
    const suitSymbols: Record<string, string> = {
      hearts: '♥',
      diamonds: '♦',
      clubs: '♣',
      spades: '♠',
    };
    
    const suitColors: Record<string, string> = {
      hearts: 'text-red-500',
      diamonds: 'text-red-500',
      clubs: 'text-gray-900',
      spades: 'text-gray-900',
    };
    
    return (
      <span className={suitColors[card.suit]}>
        {card.rank}{suitSymbols[card.suit]}
      </span>
    );
  };

  if (!user) {
    navigate('/login');
    return null;
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-green-900 to-gray-900 flex items-center justify-center">
        <div className="text-white text-xl">Loading game...</div>
      </div>
    );
  }

  if (error || !gameState) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-green-900 to-gray-900 flex items-center justify-center">
        <div className="rounded-2xl p-8 max-w-md border border-white/10 shadow-2xl" style={{background:'#262626'}}>
          <h2 className="text-2xl font-bold text-white mb-4">Error</h2>
          <p className="text-gray-300 mb-6">{error || 'Game not found'}</p>
          <button
            onClick={() => navigate('/lobby')}
            className="w-full px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition"
          >
            Back to Lobby
          </button>
        </div>
      </div>
    );
  }

  // Show eliminated state
  if (gameState?.myPlayer.position === 'eliminated' && gameState?.status === 'in_progress') {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{background:'#262626'}}>
        <div className="rounded-2xl p-8 max-w-md w-full mx-4 border border-white/10 text-center" style={{background:'rgba(255,255,255,0.03)'}}>
          <div className="w-14 h-14 mx-auto rounded-full flex items-center justify-center mb-4" style={{background:'rgba(239,68,68,0.1)'}}>
            <svg className="w-7 h-7 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-white mb-2">You've Been Eliminated</h2>
          <p className="text-gray-400 text-sm mb-6">You ran out of chips. Better luck next time!</p>
          <button
            onClick={handleLeaveGame}
            className="w-full py-3 text-white font-semibold rounded-xl hover:opacity-90 transition"
            style={{background:'linear-gradient(135deg, #12ceec, #9c51ff)'}}
          >
            Back to Lobby
          </button>
        </div>
      </div>
    );
  }

  // Show game completed screen
  if (gameState?.status === 'completed') {
    // Prefer the pre-close snapshot (real stacks). Fall back to current
    // gameState only if no snapshot was captured (shouldn't happen in
    // normal play but keeps the modal renderable).
    const allPlayers =
      finalStandings ?? finalStandingsRef.current
        ? (finalStandings ?? finalStandingsRef.current)!
        : ([gameState.myPlayer, ...(gameState.opponents || [])] as any);
    return (
      <div className="min-h-screen flex items-center justify-center" style={{background:'#262626'}}>
        <div className="rounded-2xl p-8 max-w-md w-full mx-4 border border-white/10 shadow-2xl" style={{background:'rgba(255,255,255,0.03)'}}>
          <div className="text-center mb-6">
            <div className="w-14 h-14 mx-auto rounded-full flex items-center justify-center mb-3" style={{background:'linear-gradient(135deg, rgba(18,206,236,0.15), rgba(156,81,255,0.15))'}}>
              <img src="/assets/musd-chip.png" alt="" className="w-8 h-8" />
            </div>
            <h2 className="text-2xl font-bold text-white">Game Over</h2>
            <p className="text-gray-500 text-sm mt-1">Final standings</p>
          </div>
          
          <div className="space-y-2 mb-6">
            {allPlayers
              .sort((a, b) => parseFloat(b.chipStack) - parseFloat(a.chipStack))
              .map((p, i) => (
                <div key={p.userId} className="flex justify-between items-center rounded-lg p-3 border" style={{background:'rgba(255,255,255,0.03)', borderColor: i === 0 ? 'rgba(18,206,236,0.3)' : 'rgba(255,255,255,0.05)'}}>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 text-xs w-4">{i + 1}.</span>
                    <span className={`text-sm font-medium ${i === 0 ? 'text-white' : 'text-gray-400'}`}>
                      {p.username}{p.userId === user?.id ? ' (You)' : ''}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <img src="/assets/musd-logo.png" alt="" className="w-3.5 h-3.5" />
                    <span className={`text-sm font-bold ${i === 0 ? 'text-white' : 'text-gray-400'}`} style={i === 0 ? {color:'#12ceec'} : {}}>
                      {formatChips(p.chipStack)}
                    </span>
                  </div>
                </div>
              ))}
          </div>
          
          <button
            onClick={() => navigate('/lobby')}
            className="w-full py-3 text-white font-semibold rounded-xl hover:opacity-90 transition active:scale-[0.98]"
            style={{background:'linear-gradient(135deg, #12ceec, #9c51ff)'}}
          >
            Back to Lobby
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{background:'#262626'}}>
      <div className="max-w-6xl mx-auto px-4 py-4">
        {/* Header */}
        <div className="flex justify-between items-center mb-3 sm:mb-4">
          <div>
            <h1 className="text-lg sm:text-2xl font-bold text-white">{gameState.gameName}</h1>
            <p className="text-gray-500 text-xs sm:text-sm">
              Blinds: {formatChips(gameState.smallBlind)} / {formatChips(gameState.bigBlind)}
            </p>
          </div>
          <div className="flex gap-2 items-center">
            <AudioToggle variant="compact" />
            {gameState.status === 'waiting' && (gameState.playerCount || 1) <= 1 && (
              <button
                onClick={handleCancelGame}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition text-sm"
              >
                Cancel
              </button>
            )}
            <button
              onClick={handleLeaveGame}
              className="px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600 transition text-sm"
            >
              Leave
            </button>
          </div>
        </div>

        {/* Waiting for Players */}
        {gameState.status === 'waiting' && (
          <div className="mb-6 rounded-xl p-6 border" style={{background:'rgba(18,206,236,0.06)', borderColor:'rgba(18,206,236,0.2)'}}>
            <h2 className="text-2xl font-bold text-white text-center mb-4">
              ⏳ Waiting for Players... ({gameState.playerCount || 1}/9)
            </h2>
            
            {/* Show different UI for creator vs other players */}
            {gameState.myPlayer.userId === gameState.creatorId ? (
              // Creator view
              <>
                <p className="text-gray-300 text-center mb-4">
                  Share this game with friends, or click Start Game when ready (minimum 2 players)
                </p>
                <div className="flex justify-center">
                  <button
                    onClick={async () => {
                      try {
                        await api.post(`/api/games/${gameId}/start`);
                        await loadGameState();
                      } catch (err: any) {
                        setError(err.response?.data?.message || 'Failed to start game');
                      }
                    }}
                    disabled={(gameState.playerCount || 1) < 2}
                    className="px-8 py-4 text-white text-lg font-bold rounded-xl hover:opacity-90 transition shadow-lg disabled:opacity-50 disabled:cursor-not-allowed active:scale-95"
                    style={{background:'linear-gradient(135deg, #12ceec, #9c51ff)'}}
                  >
                    Start Game Now
                  </button>
                </div>
                {(gameState.playerCount || 1) < 2 ? (
                  <p className="text-yellow-400 text-center mt-2 text-sm">
                    Need at least 2 players to start
                  </p>
                ) : (
                  <p className="text-gray-500 text-center mt-2 text-xs">
                    Game will auto-start in 2 minutes if not started manually
                  </p>
                )}
              </>
            ) : (
              // Other players view
              <>
                <p className="text-gray-300 text-center mb-4 text-lg">
                  🕐 Waiting for host to start the game...
                </p>
                <p className="text-yellow-400 text-center text-sm">
                  Game will auto-start in 2 minutes
                </p>
              </>
            )}
          </div>
        )}



        {/* Global turn-timer overlay (renders nothing when not
            in-progress / no turnStartedAt). Glow + big countdown only
            when it's the local user's turn AND <=10s remain. */}
        {gameState.status === 'in_progress' && (
          <TurnTimer
            turnStartedAt={gameState.turnStartedAt || null}
            isMyTurn={gameState.isMyTurn}
          />
        )}

        {/* Poker Table */}
        <PokerTable
          myPlayer={gameState.myPlayer}
          opponents={gameState.opponents || (gameState.opponent ? [gameState.opponent] : [])}
          board={gameState.board}
          pot={gameState.pot}
          currentBet={gameState.currentBet}
          stage={gameState.stage}
          isMyTurn={gameState.isMyTurn}
          activePlayerUserId={gameState.activePlayerUserId || null}
          turnStartedAt={gameState.turnStartedAt || null}
          dealerSeatIndex={gameState.dealerSeatIndex}
          sbSeatIndex={gameState.sbSeatIndex}
          bbSeatIndex={gameState.bbSeatIndex}
          status={gameState.status}
          amountToCall={gameState.amountToCall || '0'}
          formatChips={formatChips}
          formatCard={formatCard}
          onFold={handleFold}
          onCheck={handleCheck}
          onCall={handleCall}
          onRaise={handleRaiseClick}
          onAllIn={async () => {
            try {
              setActionLoading(true);
              await api.post(`/api/games/${gameId}/action`, { action: 'all-in' });
              await loadGameState();
            } catch (err: any) {
              setError(err.response?.data?.message || 'Action failed');
            } finally {
              setActionLoading(false);
            }
          }}
          actionLoading={actionLoading}
        />

        {/* Error Display */}
        {error && (
          <div className="mt-3 p-3 bg-red-500 bg-opacity-20 border border-red-500 rounded-lg text-red-200 text-sm text-center">
            {error}
          </div>
        )}


        {/* Raise Modal */}
        {showRaiseModal && (() => {
          const stack = parseFloat(formatChips(gameState?.myPlayer.chipStack || '0'));
          const pot = parseFloat(formatChips(gameState?.pot || '0'));
          const currentBetNum = parseFloat(formatChips(gameState?.currentBet || '0'));
          const bbNum = parseFloat(formatChips(gameState?.bigBlind || '200000'));
          const minRaise = Math.max(currentBetNum + bbNum, bbNum * 2); // At least current bet + BB
          const currentAmount = parseFloat(raiseAmount) || minRaise;

          /**
           * Playtest 2026-05-11 feedback (Shaun): quick buttons should
           * size the raise as a fraction of the POT (the conventional
           * poker shorthand), NOT a fraction of remaining stack.
           *   25% = quarter pot, 50% = half pot, 100% = full pot.
           * All-In stays stack-based (no pot reference).
           * All values are clamped to [minRaise, stack] so the slider
           * stays in legal-action territory.
           */
          const setQuickPotPct = (pct: number) => {
            const val = Math.round(pot * pct * 100) / 100;
            setRaiseAmount(Math.min(stack, Math.max(minRaise, val)).toFixed(2));
          };
          const setAllIn = () => {
            setRaiseAmount(stack.toFixed(2));
          };

          return (
            <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
              <div className="rounded-2xl p-6 max-w-sm w-full border border-white/10 shadow-2xl" style={{background:'#262626'}}>
                {/* Header */}
                <div className="flex justify-between items-center mb-5">
                  <h2 className="text-lg font-bold text-white">Raise</h2>
                  <button onClick={() => setShowRaiseModal(false)} className="text-gray-500 hover:text-white transition text-xl">×</button>
                </div>

                {/* Amount display */}
                <div className="text-center mb-5">
                  <div className="flex items-center justify-center gap-2">
                    <img src="/assets/musd-logo.png" alt="" className="w-5 h-5" />
                    <span className="text-3xl font-bold text-white">{raiseAmount || minRaise.toFixed(2)}</span>
                  </div>
                  <p className="text-gray-500 text-xs mt-1">Stack: {stack.toFixed(2)}</p>
                </div>

                {/* Slider */}
                <div className="mb-4 px-1">
                  <input
                    type="range"
                    min={minRaise}
                    max={stack}
                    step={0.1}
                    value={currentAmount}
                    onChange={(e) => setRaiseAmount(parseFloat(e.target.value).toFixed(2))}
                    className="w-full"
                  />
                  <div className="flex justify-between text-[10px] text-gray-600 mt-1">
                    <span>{minRaise.toFixed(2)}</span>
                    <span>{stack.toFixed(2)}</span>
                  </div>
                </div>

                {/* Quick buttons — sized off the POT, not the stack.
                    'All In' is the exception and snaps to remaining stack. */}
                <div className="grid grid-cols-4 gap-2 mb-2">
                  {[
                    { label: '½ pot', pct: 0.5 },
                    { label: '¾ pot', pct: 0.75 },
                    { label: 'Pot',  pct: 1.0 },
                  ].map(({ label, pct }) => (
                    <button
                      key={label}
                      onClick={() => setQuickPotPct(pct)}
                      className="py-2 rounded-lg text-xs font-semibold text-white border border-white/10 hover:bg-white/10 transition active:scale-95"
                      style={{background:'rgba(255,255,255,0.03)'}}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    onClick={setAllIn}
                    className="py-2 rounded-lg text-xs font-semibold text-white border border-purple-500/30 hover:bg-purple-500/20 transition active:scale-95"
                    style={{background:'rgba(156,81,255,0.1)'}}
                  >
                    All In
                  </button>
                </div>
                <p className="text-[10px] text-gray-600 mb-5 text-center">Pot: {pot.toFixed(2)} · Stack: {stack.toFixed(2)}</p>

                {/* Manual input */}
                <div className="mb-5">
                  <input
                    type="number"
                    value={raiseAmount}
                    onChange={(e) => setRaiseAmount(e.target.value)}
                    min={minRaise}
                    max={stack}
                    step="0.1"
                    className="w-full px-4 py-2.5 text-white text-center rounded-lg border border-white/10 focus:outline-none focus:ring-1 focus:ring-cyan-400 text-sm"
                    style={{background:'rgba(255,255,255,0.05)'}}
                    placeholder="Enter amount"
                  />
                </div>

                {/* Action buttons */}
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowRaiseModal(false)}
                    className="flex-1 py-3 text-white rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleRaiseConfirm}
                    disabled={!raiseAmount || parseFloat(raiseAmount) <= 0}
                    className="flex-1 py-3 text-white rounded-xl hover:opacity-90 transition disabled:opacity-50 font-semibold text-sm active:scale-[0.98]"
                    style={{background:'linear-gradient(135deg, #12ceec, #9c51ff)'}}
                  >
                    Raise to {raiseAmount || minRaise.toFixed(2)}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

      {/* Fold Win Display — same style as showdown modal */}
      {foldWinData && !showdownData && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="rounded-2xl shadow-2xl max-w-md w-full overflow-hidden border border-white/10" style={{background:'#262626'}}>
            {/* Header — matches showdown modal */}
            <div className="p-5" style={{background:'linear-gradient(135deg, #12ceec, #9c51ff)'}}>
              <h2 className="text-2xl font-bold text-center text-white">HAND COMPLETE</h2>
            </div>

            <div className="p-6 space-y-5">
              {/* Winner announcement */}
              <div className="text-center">
                <p className="text-2xl font-bold text-white mb-1">
                  {foldWinData.winnerId === user?.id ? 'You Win!' : `${foldWinData.winnerName} Wins!`}
                </p>
                <p className="text-gray-400 text-sm">Everyone else folded</p>
              </div>

              {/* Pot awarded */}
              <div className="rounded-xl border border-white/5 p-5 text-center" style={{background:'rgba(255,255,255,0.02)'}}>
                <p className="text-gray-500 text-sm mb-1">Pot Awarded</p>
                <div className="flex items-center justify-center gap-2">
                  <img src="/assets/musd-chip.png" alt="" className="w-7 h-7" />
                  <p className="text-3xl font-bold text-white">{formatChips(foldWinData.pot)}</p>
                </div>
              </div>

              {/* Countdown */}
              {nextHandCountdown !== null && nextHandCountdown > 0 && (
                <div className="text-center">
                  <p className="text-sm" style={{color:'#12ceec'}}>
                    Next hand in {nextHandCountdown}s
                  </p>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex gap-3 mt-4">
                <button
                  onClick={() => { setFoldWinData(null); loadGameState(); }}
                  className="flex-1 py-2.5 text-white text-sm font-semibold rounded-xl hover:opacity-90 transition"
                  style={{background:'linear-gradient(135deg, #12ceec, #9c51ff)'}}
                >
                  Play Next Hand
                </button>
                <button
                  onClick={handleLeaveGame}
                  className="flex-1 py-2.5 text-gray-400 text-sm rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition"
                >
                  Leave
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Showdown Modal */}
      {showdownData && (
        <>
          <ShowdownModal
            isOpen={!!showdownData}
            pot={showdownData.pot}
            sidePots={showdownData.sidePots}
            communityCards={showdownData.communityCards}
            players={showdownData.players}
            winnerIds={showdownData.winnerIds}
            currentUserId={user?.id || ''}
            onClose={() => {
              setShowdownData(null);
              setGameCompleted(false);
              loadGameState();
            }}
          />
          {/* Buttons overlay */}
          <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[60] flex gap-3">
            <button
              onClick={() => { setShowdownData(null); setGameCompleted(false); loadGameState(); }}
              className="px-5 py-2.5 text-white text-sm font-semibold rounded-xl hover:opacity-90 transition"
              style={{background:'linear-gradient(135deg, #12ceec, #9c51ff)'}}
            >
              Play Next Hand
            </button>
            <button
              onClick={handleLeaveGame}
              className="px-5 py-2.5 text-gray-400 text-sm rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition"
            >
              Leave Table
            </button>
          </div>
          {/* Next hand countdown overlay */}
          {nextHandCountdown !== null && nextHandCountdown > 0 && (
            <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[60] backdrop-blur-sm rounded-full px-6 py-2 border" style={{background:'rgba(0,0,0,0.8)', borderColor:'rgba(18,206,236,0.3)'}}>
              <p className="text-white text-center text-sm">
                Next hand in <span className="font-bold text-lg" style={{color:'#12ceec'}}>{nextHandCountdown}s</span>
              </p>
            </div>
          )}
        </>
      )}
      </div>
    </div>
  );
}
