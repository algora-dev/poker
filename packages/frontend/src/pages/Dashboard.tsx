import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { authApi, api } from '../services/api';
import DepositModal from '../components/DepositModal';
import { WithdrawModal } from '../components/WithdrawModal';
import { AvatarPicker } from '../components/AvatarPicker';
import { AudioToggle } from '../components/AudioToggle';
import { getAvatarSrc } from '../utils/avatars';
import { useSocket } from '../hooks/useSocket';

export default function Dashboard() {
  const navigate = useNavigate();
  const { user, logout, setAuth, accessToken, refreshToken } = useAuthStore();
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const [recentGames, setRecentGames] = useState<any[]>([]);
  // Phase 10 [H-04]: deposit/withdraw locked while user is seated at
  // any waiting/in_progress table. Backend enforces too; this is UX.
  const [moneyLock, setMoneyLock] = useState<{
    locked: boolean;
    gameId?: string;
    gameStatus?: 'waiting' | 'in_progress';
    message?: string;
  }>({ locked: false });
  const { isConnected } = useSocket();

  useEffect(() => {
    const fetchUserData = async () => {
      try {
        const freshUser = await authApi.getMe();
        if (accessToken && refreshToken) {
          setAuth(freshUser, accessToken, refreshToken);
        }
      } catch (_) {}
    };
    fetchUserData();
    loadRecentGames();
    loadMoneyLock();
    const lockInterval = setInterval(loadMoneyLock, 15_000);
    return () => clearInterval(lockInterval);
  }, []);

  const loadRecentGames = async () => {
    try {
      const response = await api.get('/api/games/history');
      setRecentGames(response.data.games?.slice(0, 5) || []);
    } catch (_) {}
  };

  const loadMoneyLock = async () => {
    try {
      const response = await api.get('/api/wallet/money-lock');
      setMoneyLock(response.data);
    } catch (_) {
      // Fail-closed: if the check itself fails, lock the buttons.
      setMoneyLock({ locked: true, message: 'Could not check active-game status' });
    }
  };

  if (!user) {
    navigate('/login');
    return null;
  }

  const chipBalance = (Number(user.chips) / 1_000_000).toFixed(2);
  const avatarSrc = getAvatarSrc(user.avatarId || 2);

  return (
    <div className="min-h-screen bg-brand-bg">
      <div className="max-w-5xl mx-auto px-4 py-8">

        {/* Profile Header */}
        <div className="bg-white/[0.03] rounded-2xl p-6 mb-6 border border-white/5">
          <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-6">
            {/* Avatar */}
            <button
              onClick={() => setShowAvatarPicker(true)}
              className="relative group flex-shrink-0"
            >
              <div className="w-20 h-20 rounded-full overflow-hidden ring-2 ring-white/10 group-hover:ring-brand-cyan transition">
                {avatarSrc ? (
                  <img src={avatarSrc} alt="Avatar" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full bg-brand-bg flex items-center justify-center text-3xl text-white font-bold">
                    {user.username?.charAt(0).toUpperCase()}
                  </div>
                )}
              </div>
              <div className="absolute inset-0 rounded-full bg-black/60 opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
                <span className="text-white text-xs font-bold">Change</span>
              </div>
            </button>

            {/* Info */}
            <div className="flex-1">
              <h1 className="text-2xl font-bold text-white">{user.username}</h1>
              <p className="text-gray-500 text-sm">{user.email}</p>
              <div className="flex items-center gap-3 mt-2">
                <span
                  className="text-xs px-2 py-0.5 rounded-full border"
                  style={isConnected
                    ? { background: 'rgba(18,206,236,0.1)', color: '#12ceec', borderColor: 'rgba(18,206,236,0.2)' }
                    : { background: 'rgba(239,68,68,0.1)', color: '#ef4444', borderColor: 'rgba(239,68,68,0.2)' }
                  }
                >
                  {isConnected ? 'Online' : 'Offline'}
                </span>
                {user.walletAddress && (
                  <span className="text-gray-600 text-xs font-mono">
                    {user.walletAddress.slice(0, 6)}...{user.walletAddress.slice(-4)}
                  </span>
                )}
              </div>
            </div>

            {/* Balance */}
            <div className="text-right">
              <p className="text-gray-500 text-xs mb-1">Balance</p>
              <div className="flex items-center justify-end gap-2">
                <img src="/assets/musd-logo.png" alt="mUSD" className="w-6 h-6" />
                <p className="text-3xl font-bold text-white">{chipBalance}</p>
              </div>
              <p className="text-gray-600 text-xs">mUSD chips</p>
            </div>
          </div>
        </div>

        {/* Action Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <button
            disabled={moneyLock.locked}
            onClick={() => !moneyLock.locked && setShowDepositModal(true)}
            title={moneyLock.locked ? moneyLock.message ?? 'Locked while in an active table' : ''}
            className={`rounded-xl p-5 text-left transition group border ${moneyLock.locked ? 'opacity-50 cursor-not-allowed' : ''}`}
            style={{ background: 'linear-gradient(135deg, rgba(18,206,236,0.08), transparent)', borderColor: 'rgba(18,206,236,0.15)' }}
            onMouseEnter={(e) => { if (!moneyLock.locked) e.currentTarget.style.borderColor = 'rgba(18,206,236,0.35)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(18,206,236,0.15)'; }}
          >
            <img src="/assets/musd-logo.png" alt="" className="w-8 h-8 mb-3" />
            <h3 className="text-white font-bold mb-1">Deposit</h3>
            <p className="text-gray-500 text-sm">
              {moneyLock.locked ? 'Locked: leave your active table first' : 'Add chips with mUSD on Linea'}
            </p>
            <div className="mt-3 text-sm font-medium group-hover:translate-x-1 transition-transform" style={{ color: '#12ceec' }}>
              {moneyLock.locked ? 'Locked' : 'Deposit →'}
            </div>
          </button>

          <button
            disabled={moneyLock.locked}
            onClick={() => !moneyLock.locked && setShowWithdrawModal(true)}
            title={moneyLock.locked ? moneyLock.message ?? 'Locked while in an active table' : ''}
            className={`rounded-xl p-5 text-left transition group border ${moneyLock.locked ? 'opacity-50 cursor-not-allowed' : ''}`}
            style={{ background: 'linear-gradient(135deg, rgba(156,81,255,0.08), transparent)', borderColor: 'rgba(156,81,255,0.15)' }}
            onMouseEnter={(e) => { if (!moneyLock.locked) e.currentTarget.style.borderColor = 'rgba(156,81,255,0.35)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(156,81,255,0.15)'; }}
          >
            <img src="/assets/musd-logo.png" alt="" className="w-8 h-8 mb-3" />
            <h3 className="text-white font-bold mb-1">Withdraw</h3>
            <p className="text-gray-500 text-sm">
              {moneyLock.locked ? 'Locked: leave your active table first' : 'Cash out chips to your wallet'}
            </p>
            <div className="mt-3 text-sm font-medium group-hover:translate-x-1 transition-transform" style={{ color: '#9c51ff' }}>
              {moneyLock.locked ? 'Locked' : 'Withdraw →'}
            </div>
          </button>

          <button
            onClick={() => navigate('/lobby')}
            className="rounded-xl p-5 text-left transition group border"
            style={{ background: 'linear-gradient(135deg, rgba(34,197,94,0.08), transparent)', borderColor: 'rgba(34,197,94,0.15)' }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(34,197,94,0.35)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(34,197,94,0.15)'; }}
          >
            <div className="w-8 h-8 mb-3 rounded-lg bg-green-500/20 flex items-center justify-center">
              <svg className="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h3 className="text-white font-bold mb-1">Play</h3>
            <p className="text-gray-500 text-sm">Join a table and start playing</p>
            <div className="mt-3 text-green-400 text-sm font-medium group-hover:translate-x-1 transition-transform">
              Game Lobby →
            </div>
          </button>
        </div>

        {/* Two columns */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Wallet */}
          <div className="bg-white/[0.03] rounded-2xl p-6 border border-white/5">
            <h2 className="text-base font-bold text-white mb-4">Wallet</h2>
            {user.walletAddress ? (
              <div className="space-y-2">
                {[
                  { label: 'Connected Wallet', value: user.walletAddress },
                  { label: 'Network', value: 'Linea Mainnet' },
                  { label: 'Token', value: 'mUSD (Stablecoin)' },
                ].map(({ label, value }) => (
                  <div key={label} className="bg-white/[0.03] rounded-lg p-3">
                    <p className="text-gray-500 text-xs">{label}</p>
                    <p className="text-white text-sm font-mono break-all">{value}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8">
                <p className="text-gray-500 mb-3">No wallet connected</p>
                <button
                  onClick={() => setShowDepositModal(true)}
                  className="px-4 py-2 bg-brand-cyan/10 text-brand-cyan border border-brand-cyan/20 rounded-lg hover:bg-brand-cyan/20 transition text-sm"
                >
                  Connect & Deposit
                </button>
              </div>
            )}
          </div>

          {/* Recent Games */}
          <div className="bg-white/[0.03] rounded-2xl p-6 border border-white/5">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-base font-bold text-white">Recent Games</h2>
              <button onClick={() => navigate('/lobby')} className="text-gray-500 text-xs hover:text-white transition">
                View All
              </button>
            </div>
            {recentGames.length === 0 ? (
              <p className="text-gray-600 text-center py-8 text-sm">No games played yet</p>
            ) : (
              <div className="space-y-1">
                {recentGames.map((game: any) => (
                  <div key={game.id} className="bg-white/[0.03] rounded-lg px-4 py-3 flex justify-between items-center">
                    <div>
                      <p className="text-white text-sm font-medium">{game.name}</p>
                      <p className="text-gray-500 text-xs">{game.players} players · {game.handsPlayed} hands</p>
                    </div>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                      game.status === 'completed'
                        ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                        : 'bg-white/5 text-gray-500 border border-white/10'
                    }`}>
                      {game.status === 'completed' ? 'Finished' : 'Cancelled'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Settings */}
        <div className="mt-6 bg-white/[0.03] rounded-2xl p-6 border border-white/5">
          <h2 className="text-base font-bold text-white mb-2">Settings</h2>
          <AudioToggle variant="settings" />
        </div>

        {/* Stats */}
        <div className="mt-6 bg-white/[0.03] rounded-2xl p-6 border border-white/5">
          <h2 className="text-base font-bold text-white mb-4">Your Stats</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {['Games Played', 'Hands Won', 'Total Profit', 'Best Hand'].map((label) => (
              <div key={label} className="text-center">
                <p className="text-2xl font-bold text-white">—</p>
                <p className="text-gray-600 text-xs">{label}</p>
              </div>
            ))}
          </div>
          <p className="text-gray-700 text-center text-xs mt-4">Stats tracking coming soon</p>
        </div>

        {/* Modals */}
        <DepositModal isOpen={showDepositModal} onClose={() => setShowDepositModal(false)} />
        <WithdrawModal
          isOpen={showWithdrawModal}
          onClose={() => setShowWithdrawModal(false)}
          chipBalance={chipBalance}
          walletAddress={user.walletAddress}
        />
        <AvatarPicker
          currentAvatarId={user.avatarId || null}
          isOpen={showAvatarPicker}
          onClose={() => setShowAvatarPicker(false)}
          onSelect={(avatarId) => {
            if (accessToken && refreshToken) setAuth({ ...user, avatarId }, accessToken, refreshToken);
          }}
        />
      </div>
    </div>
  );
}
