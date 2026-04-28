import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { api } from '../services/api';
import { useSocket } from '../hooks/useSocket';
import { playTurnNotification, showTurnNotification, requestNotificationPermission, initAudioContext } from '../utils/sounds';
import { ShowdownModal } from '../components/ShowdownModal';
import { PokerTable } from '../components/PokerTable';
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

  // Load game state
  const loadGameState = async (showLoader = false) => {
    if (!gameId) return;

    try {
      if (showLoader) setLoading(true);
      const response = await api.get(`/api/games/${gameId}/state`);
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
      setError(err.response?.data?.message || 'Failed to load game');
      console.error('Load game state error:', err);
    } finally {
      setLoading(false);
    }
  };

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

    // Listen for game updates
    socket.on('game:updated', (data: any) => {
      if (data?.action === 'check') playCheckSound();
      loadGameState();
    });

    socket.on('game:started', () => {
      loadGameState();
    });

    socket.on('player:joined', () => {
      loadGameState();
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
      loadGameState();
    });

    socket.on('game:turn-warning', () => {
      // Timer warning — no reload needed, frontend timer handles display
    });

    return () => {
      socket.off('game:updated');
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

    try {
      await api.post(`/api/games/${gameId}/action`, {
        action,
        raiseAmount: raiseAmt,
      });

      // Game state will update via Socket.io
      await loadGameState();
    } catch (err: any) {
      setError(err.response?.data?.message || `Failed to ${action}`);
      console.error('Action error:', err);
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

  // Show game completed screen
  if (gameState?.status === 'completed') {
    const allPlayers = [gameState.myPlayer, ...(gameState.opponents || [])];
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
          <div className="flex gap-2">
            {gameState.status === 'waiting' && (gameState.playerCount || 1) <= 1 && (
              <button
                onClick={handleCancelGame}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition text-sm"
              >
                Cancel
              </button>
            )}
            <button
              onClick={() => navigate('/lobby')}
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
          const currentBetNum = parseFloat(formatChips(gameState?.currentBet || '0'));
          const bbNum = parseFloat(formatChips(gameState?.bigBlind || '200000'));
          const minRaise = Math.max(currentBetNum + bbNum, bbNum * 2); // At least current bet + BB
          const currentAmount = parseFloat(raiseAmount) || minRaise;

          const setQuick = (pct: number) => {
            if (pct === 1) {
              setRaiseAmount(stack.toFixed(2));
              return;
            }
            const val = Math.round(stack * pct * 100) / 100;
            // Clamp between minRaise and stack
            setRaiseAmount(Math.min(stack, Math.max(minRaise, val)).toFixed(2));
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

                {/* Quick buttons */}
                <div className="grid grid-cols-4 gap-2 mb-5">
                  {[
                    { label: '25%', pct: 0.25 },
                    { label: '50%', pct: 0.5 },
                    { label: '75%', pct: 0.75 },
                    { label: 'All In', pct: 1 },
                  ].map(({ label, pct }) => (
                    <button
                      key={label}
                      onClick={() => setQuick(pct)}
                      className={`py-2 rounded-lg text-xs font-semibold transition active:scale-95 ${
                        pct === 1
                          ? 'text-white border border-purple-500/30 hover:bg-purple-500/20'
                          : 'text-white border border-white/10 hover:bg-white/10'
                      }`}
                      style={pct === 1 ? {background:'rgba(156,81,255,0.1)'} : {background:'rgba(255,255,255,0.03)'}}
                    >
                      {label}
                    </button>
                  ))}
                </div>

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
          {/* Next hand countdown overlay */}
          {nextHandCountdown !== null && nextHandCountdown > 0 && (
            <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[60] backdrop-blur-sm rounded-full px-6 py-3 border" style={{background:'rgba(0,0,0,0.8)', borderColor:'rgba(18,206,236,0.3)'}}>
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
