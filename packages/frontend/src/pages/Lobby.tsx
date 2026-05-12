import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { api } from '../services/api';
import { useSocket } from '../hooks/useSocket';
import { styles, cls } from '../styles/theme';

interface Game {
  id: string;
  name: string;
  minBuyIn: string;
  maxBuyIn: string;
  smallBlind: string;
  bigBlind: string;
  players: number;
  maxPlayers: number;
  status: string;
  creator: string;
  createdAt: string;
}

export default function Lobby() {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const { socket, isConnected } = useSocket();
  const [games, setGames] = useState<Game[]>([]);
  const [historyGames, setHistoryGames] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'active' | 'history'>('active');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showCreateConfirm, setShowCreateConfirm] = useState(false);
  const [showJoinConfirm, setShowJoinConfirm] = useState(false);
  const [selectedGame, setSelectedGame] = useState<Game | null>(null);
  const [joinBuyIn, setJoinBuyIn] = useState('');
  const [createLoading, setCreateLoading] = useState(false);
  const [gameName, setGameName] = useState('');
  // Defaults updated after playtest 2026-05-11 (Shaun): 5-chip start was
  // effectively an instant all-in given 0.10/0.20 blinds. 10/20 gives a
  // working stack-to-BB ratio of 50, which is closer to a normal SNG/MTT
  // starting depth.
  const [minBuyIn, setMinBuyIn] = useState('10');
  const [maxBuyIn, setMaxBuyIn] = useState('20');
  const [creatorBuyIn, setCreatorBuyIn] = useState('10');
  const [smallBlind, setSmallBlind] = useState('0.10');
  const [bigBlind, setBigBlind] = useState('0.20');

  // Load games
  useEffect(() => {
    loadGames();
  }, []);

  useEffect(() => {
    if (activeTab === 'history') loadHistory();
  }, [activeTab]);

  // Real-time updates
  useEffect(() => {
    if (!socket) return;

    socket.on('game:created', () => {
      loadGames();
    });

    socket.on('game:started', () => {
      loadGames();
    });

    // Refresh lobby seat counts when ANY player joins/leaves a game.
    // Without this, the lobby cards stay stale and a user can click
    // Join on a game that already filled its last seat - getting a
    // confusing 'already taken' error. (Playtest 2026-05-12: Shaun
    // saw an extra real player apparently take his seat; refresh
    // resolved it.)
    socket.on('player:joined', () => {
      loadGames();
    });
    socket.on('game:closed', () => {
      loadGames();
    });
    socket.on('game:updated', () => {
      loadGames();
    });

    return () => {
      socket.off('game:created');
      socket.off('game:started');
      socket.off('player:joined');
      socket.off('game:closed');
      socket.off('game:updated');
    };
  }, [socket]);

  const loadGames = async () => {
    try {
      setLoading(true);
      const response = await api.get('/api/games/lobby');
      setGames(response.data.games || []);
      setError('');
    } catch (err) {
      setError('Failed to load games');
      console.error('Load games error:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadHistory = async () => {
    try {
      const response = await api.get('/api/games/history');
      setHistoryGames(response.data.games || []);
    } catch (err) {
      console.error('Load history error:', err);
    }
  };

  const handleCreateGameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    
    // Validate user has enough chips
    const userChips = parseFloat(user?.chips || '0') / 1_000_000;
    const minAmount = parseFloat(minBuyIn);
    
    if (userChips < minAmount) {
      setError(`Insufficient chips. You have ${userChips.toFixed(2)}, need at least ${minAmount.toFixed(2)}`);
      return;
    }
    
    // Set default creator buy-in to min
    setCreatorBuyIn(minBuyIn);
    // Show confirmation
    setShowCreateModal(false);
    setShowCreateConfirm(true);
  };

  const handleCreateGameConfirm = async () => {
    setCreateLoading(true);
    setError('');

    try {
      const response = await api.post('/api/games/create', {
        name: gameName,
        minBuyIn: parseFloat(minBuyIn),
        maxBuyIn: parseFloat(maxBuyIn),
        creatorBuyIn: parseFloat(creatorBuyIn),
        smallBlind: parseFloat(smallBlind),
        bigBlind: parseFloat(bigBlind),
      });

      setShowCreateConfirm(false);
      setGameName('');
      setMinBuyIn('5');
      setMaxBuyIn('20');
      setSmallBlind('0.10');
      setBigBlind('0.20');
      
      // Redirect creator to game room (waiting for opponent)
      navigate(`/game/${response.data.game.id}`);
    } catch (err: any) {
      setError(
        err.response?.data?.message || 'Failed to create game'
      );
      setShowCreateConfirm(false);
    } finally {
      setCreateLoading(false);
    }
  };

  const handleCreateGameCancel = () => {
    setShowCreateConfirm(false);
    setShowCreateModal(true);
  };

  const handleJoinGameClick = (game: Game) => {
    setError('');
    
    // Validate user has enough chips
    const userChips = parseFloat(user?.chips || '0') / 1_000_000;
    const minAmount = parseFloat(game.minBuyIn);
    
    if (userChips < minAmount) {
      setError(`Insufficient chips. You have ${userChips.toFixed(2)}, need at least ${minAmount.toFixed(2)}`);
      return;
    }
    
    setSelectedGame(game);
    setJoinBuyIn(game.minBuyIn); // Default to minimum
    setShowJoinConfirm(true);
  };

  const handleJoinGameConfirm = async () => {
    if (!selectedGame) return;
    
    setShowJoinConfirm(false);
    
    try {
      setError('');
      const response = await api.post(`/api/games/${selectedGame.id}/join`, {
        buyInAmount: parseFloat(joinBuyIn),
      });
      
      // Navigate to game room
      navigate(`/game/${selectedGame.id}`);
    } catch (err: any) {
      setError(
        err.response?.data?.message || 'Failed to join game'
      );
    } finally {
      setSelectedGame(null);
    }
  };

  const handleJoinGameCancel = () => {
    setShowJoinConfirm(false);
    setSelectedGame(null);
  };

  const handleLogout = async () => {
    try {
      await logout();
      navigate('/login');
    } catch (error) {
      console.error('Logout error:', error);
      navigate('/login');
    }
  };

  const formatChips = (chips: string) => {
    return (parseInt(chips) / 1000000).toFixed(2);
  };

  if (!user) {
    navigate('/login');
    return null;
  }

  return (
    <div className="min-h-screen" style={{ background: '#262626' }}>
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-white">Game Lobby</h1>
        </div>

        {/* Error Message */}
        {error && (
          <div className="mb-6 p-4 rounded-lg text-red-300 border" style={{ background: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.2)' }}>
            {error}
          </div>
        )}

        {/* Create Game Button */}
        <div className="mb-6">
          <button
            onClick={() => setShowCreateModal(true)}
            className="px-8 py-3 text-white rounded-xl hover:opacity-90 transition text-base font-semibold active:scale-95"
            style={{ background: 'linear-gradient(135deg, #12ceec, #9c51ff)' }}
          >
            + Create New Game
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 rounded-lg p-1 max-w-xs" style={{ background: 'rgba(255,255,255,0.03)' }}>
          <button
            onClick={() => setActiveTab('active')}
            className={`flex-1 py-2 px-4 rounded-md text-sm font-semibold transition ${
              activeTab === 'active' ? 'text-white' : 'text-gray-400 hover:text-white'
            }`}
            style={activeTab === 'active' ? { background: 'rgba(18,206,236,0.15)', color: '#12ceec' } : {}}
          >
            Active Games
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={`flex-1 py-2 px-4 rounded-md text-sm font-semibold transition ${
              activeTab === 'history' ? 'text-white' : 'text-gray-400 hover:text-white'
            }`}
            style={activeTab === 'history' ? { background: 'rgba(156,81,255,0.15)', color: '#9c51ff' } : {}}
          >
            History
          </button>
        </div>

        {/* Active Games Tab */}
        {activeTab === 'active' && (
        <div className="rounded-2xl p-6 border" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.05)' }}>
          <h2 className="text-xl font-bold text-white mb-4">Available Games</h2>
          
          {loading ? (
            <p className="text-gray-400">Loading games...</p>
          ) : games.length === 0 ? (
            <p className="text-gray-400">No games available. Create one to get started!</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {games.map((game) => (
                <div
                  key={game.id}
                  className="rounded-xl p-5 border transition hover:border-white/20"
                  style={{ background: 'rgba(255,255,255,0.03)', borderColor: 'rgba(255,255,255,0.06)' }}
                >
                  <h3 className="text-lg font-bold text-white mb-2">{game.name}</h3>
                  <div className="space-y-1.5 text-sm text-gray-400 mb-4">
                    <p>Buy-in: <span className="text-white">{game.minBuyIn} - {game.maxBuyIn}</span> chips</p>
                    <p>Blinds: <span className="text-white">{game.smallBlind} / {game.bigBlind}</span></p>
                    <p>Players: <span className="text-white">{game.players} / {game.maxPlayers}</span></p>
                    <p className="text-xs text-gray-500">by {game.creator}</p>
                  </div>
                  
                  {game.status === 'waiting' && (
                    <button
                      onClick={() => handleJoinGameClick(game)}
                      className="w-full px-4 py-2.5 text-white rounded-lg transition text-sm font-semibold hover:opacity-90 active:scale-[0.98]"
                      style={{ background: 'linear-gradient(135deg, #12ceec, #9c51ff)' }}
                    >
                      Join Game
                    </button>
                  )}
                  
                  {game.status === 'in_progress' && (
                    <div className="w-full px-4 py-2.5 rounded-lg text-center text-sm font-medium" style={{ background: 'rgba(18,206,236,0.1)', color: '#12ceec' }}>
                      In Progress
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        )}

        {/* History Tab */}
        {activeTab === 'history' && (
          <div className="rounded-2xl p-6 border" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.05)' }}>
            <h2 className="text-xl font-bold text-white mb-4">Completed Matches</h2>
            {historyGames.length === 0 ? (
              <p className="text-gray-500">No completed matches yet.</p>
            ) : (
              <div className="space-y-2">
                {historyGames.map((game: any) => (
                  <div key={game.id} className="rounded-lg p-4 flex justify-between items-center" style={{ background: 'rgba(255,255,255,0.03)' }}>
                    <div>
                      <h3 className="text-white font-semibold">{game.name}</h3>
                      <p className="text-gray-400 text-sm">
                        {game.players} players • {game.handsPlayed} hands • {game.playerNames.join(', ')}
                      </p>
                    </div>
                    <div className="text-right">
                      <span className={`text-xs px-2 py-1 rounded ${
                        game.status === 'completed' ? 'bg-green-900 text-green-400' : 'bg-gray-600 text-gray-300'
                      }`}>
                        {game.status === 'completed' ? 'Finished' : 'Cancelled'}
                      </span>
                      {game.completedAt && (
                        <p className="text-gray-500 text-xs mt-1">
                          {new Date(game.completedAt).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Create Game Modal */}
        {showCreateModal && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50">
            <div className="rounded-2xl p-8 border border-white/10 shadow-2xl max-w-md w-full mx-4" style={{background:'#262626'}}>
              <h2 className="text-2xl font-bold text-white mb-6">Create New Game</h2>
              
              <form onSubmit={handleCreateGameSubmit} className="space-y-4">
                <div>
                  <label className="block text-gray-300 mb-2">Game Name</label>
                  <input
                    type="text"
                    value={gameName}
                    onChange={(e) => setGameName(e.target.value)}
                    className="w-full px-4 py-3 text-white rounded-lg border border-white/10 focus:ring-2 focus:ring-cyan-400 focus:outline-none" style={{background:'rgba(255,255,255,0.05)'}}
                    placeholder="My Poker Game"
                    required
                  />
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-gray-300 mb-2">Min Buy-in</label>
                    <input
                      type="number"
                      value={minBuyIn}
                      onChange={(e) => setMinBuyIn(e.target.value)}
                      min="0.01"
                      step="0.01"
                      className="w-full px-4 py-3 text-white rounded-lg border border-white/10 focus:ring-2 focus:ring-cyan-400 focus:outline-none" style={{background:'rgba(255,255,255,0.05)'}}
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-gray-300 mb-2">Max Buy-in</label>
                    <input
                      type="number"
                      value={maxBuyIn}
                      onChange={(e) => setMaxBuyIn(e.target.value)}
                      min="0.01"
                      step="0.01"
                      className="w-full px-4 py-3 text-white rounded-lg border border-white/10 focus:ring-2 focus:ring-cyan-400 focus:outline-none" style={{background:'rgba(255,255,255,0.05)'}}
                      required
                    />
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-gray-300 mb-2">Small Blind</label>
                    <input
                      type="number"
                      value={smallBlind}
                      onChange={(e) => setSmallBlind(e.target.value)}
                      min="0.01"
                      step="0.01"
                      className="w-full px-4 py-3 text-white rounded-lg border border-white/10 focus:ring-2 focus:ring-cyan-400 focus:outline-none" style={{background:'rgba(255,255,255,0.05)'}}
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-gray-300 mb-2">Big Blind</label>
                    <input
                      type="number"
                      value={bigBlind}
                      onChange={(e) => setBigBlind(e.target.value)}
                      min="0.01"
                      step="0.01"
                      className="w-full px-4 py-3 text-white rounded-lg border border-white/10 focus:ring-2 focus:ring-cyan-400 focus:outline-none" style={{background:'rgba(255,255,255,0.05)'}}
                      required
                    />
                  </div>
                </div>
                
                <div className="flex gap-4 mt-6">
                  <button
                    type="button"
                    onClick={() => {
                      setShowCreateModal(false);
                      setGameName('');
                      setBuyIn('1.0');
                      setSmallBlind('0.5');
                      setBigBlind('1.0');
                      setError('');
                    }}
                    className="flex-1 px-6 py-3 text-white rounded-lg hover:bg-white/10 bg-white/5 border border-white/10 transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="flex-1 px-6 py-3 text-white font-semibold rounded-lg hover:opacity-90 transition active:scale-[0.98]"
                    style={{background:'linear-gradient(135deg, #12ceec, #9c51ff)'}}
                  >
                    Next
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Create Game Confirmation Modal */}
        {showCreateConfirm && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50">
            <div className="rounded-2xl p-8 border border-white/10 shadow-2xl max-w-md w-full mx-4" style={{background:'#262626'}}>
              <h2 className="text-2xl font-bold text-white mb-4">⚠️ Confirm Game Creation</h2>
              
              <div className="rounded-lg p-4 border border-white/5 mb-6">
                <p className="text-gray-300 mb-3">
                  You're about to create a multiplayer game with:
                </p>
                <ul className="space-y-2 text-white">
                  <li>• <strong>Buy-in Range:</strong> {minBuyIn} - {maxBuyIn} chips</li>
                  <li>• <strong>Blinds:</strong> {smallBlind} / {bigBlind}</li>
                </ul>

                {/* Creator buy-in selector */}
                <div className="mt-4 pt-4 border-t border-white/10">
                  <label className="block text-gray-300 mb-2 text-sm">Your buy-in ({minBuyIn} - {maxBuyIn} chips)</label>
                  <input
                    type="range"
                    min={minBuyIn}
                    max={maxBuyIn}
                    step="0.5"
                    value={creatorBuyIn}
                    onChange={(e) => setCreatorBuyIn(e.target.value)}
                    className="w-full"
                  />
                  <div className="flex justify-between items-center mt-2">
                    <span className="text-gray-400 text-xs">{minBuyIn}</span>
                    <span className="text-white text-xl font-bold">{parseFloat(creatorBuyIn).toFixed(2)} chips</span>
                    <span className="text-gray-400 text-xs">{maxBuyIn}</span>
                  </div>
                </div>
              </div>

              <p className="text-gray-300 mb-6">
                Are you sure you want to create this game?
              </p>
              
              <div className="flex gap-4">
                <button
                  onClick={handleCreateGameCancel}
                  disabled={createLoading}
                  className="flex-1 px-6 py-3 text-white rounded-lg hover:bg-white/10 bg-white/5 border border-white/10 transition disabled:opacity-50"
                >
                  No, Go Back
                </button>
                <button
                  onClick={handleCreateGameConfirm}
                  disabled={createLoading}
                  className="flex-1 px-6 py-3 text-white rounded-lg hover:opacity-90 transition disabled:opacity-50 font-semibold"
                  style={{background:'linear-gradient(135deg, #12ceec, #9c51ff)'}}
                >
                  {createLoading ? 'Creating...' : 'Yes, Create Game'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Join Game Confirmation Modal */}
        {showJoinConfirm && selectedGame && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50">
            <div className="rounded-2xl p-8 border border-white/10 shadow-2xl max-w-md w-full mx-4" style={{background:'#262626'}}>
              <h2 className="text-2xl font-bold text-white mb-4">⚠️ Confirm Join Game</h2>
              
              <div className="rounded-lg p-4 border border-white/5 mb-6">
                <p className="text-gray-300 mb-3">
                  You're about to join:
                </p>
                <ul className="space-y-2 text-white">
                  <li>• <strong>Game:</strong> {selectedGame.name}</li>
                  <li>• <strong>Blinds:</strong> {selectedGame.smallBlind} / {selectedGame.bigBlind}</li>
                  <li>• <strong>Creator:</strong> {selectedGame.creator}</li>
                </ul>

                {/* Buy-in selector */}
                <div className="mt-4 pt-4 border-t border-white/10">
                  <label className="block text-gray-300 mb-2 text-sm">Choose your buy-in ({selectedGame.minBuyIn} - {selectedGame.maxBuyIn} chips)</label>
                  <input
                    type="range"
                    min={selectedGame.minBuyIn}
                    max={selectedGame.maxBuyIn}
                    step="0.5"
                    value={joinBuyIn}
                    onChange={(e) => setJoinBuyIn(e.target.value)}
                    className="w-full h-2 rounded-lg appearance-none cursor-pointer accent-green-500"
                  />
                  <div className="flex justify-between items-center mt-2">
                    <span className="text-gray-400 text-xs">{selectedGame.minBuyIn}</span>
                    <span className="text-white text-xl font-bold">{parseFloat(joinBuyIn).toFixed(2)} chips</span>
                    <span className="text-gray-400 text-xs">{selectedGame.maxBuyIn}</span>
                  </div>
                </div>

                <p className="text-yellow-400 mt-3 text-sm">
                  {parseFloat(joinBuyIn).toFixed(2)} chips will be deducted from your balance.
                </p>
              </div>
              
              <div className="flex gap-4">
                <button
                  onClick={handleJoinGameCancel}
                  className="flex-1 px-6 py-3 text-white rounded-lg hover:bg-white/10 bg-white/5 border border-white/10 transition"
                >
                  No, Cancel
                </button>
                <button
                  onClick={handleJoinGameConfirm}
                  className="flex-1 px-6 py-3 text-white rounded-lg hover:opacity-90 transition font-semibold"
                  style={{background:'linear-gradient(135deg, #12ceec, #9c51ff)'}}
                >
                  Yes, Join Game
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
