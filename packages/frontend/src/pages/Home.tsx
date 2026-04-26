import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { api } from '../services/api';

interface ActiveTable {
  id: string;
  name: string;
  players: number;
  maxPlayers: number;
  smallBlind: string;
  bigBlind: string;
  status: string;
}

export default function Home() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [activeTables, setActiveTables] = useState<ActiveTable[]>([]);
  const [stats, setStats] = useState({ playersOnline: 0, tablesActive: 0 });

  useEffect(() => {
    loadActiveTables();
    const interval = setInterval(loadActiveTables, 15000);
    return () => clearInterval(interval);
  }, []);

  const loadActiveTables = async () => {
    try {
      const response = await api.get('/api/games/lobby');
      const games = response.data.games || [];
      setActiveTables(games.slice(0, 5));
      setStats({
        playersOnline: games.reduce((sum: number, g: any) => sum + g.players, 0),
        tablesActive: games.length,
      });
    } catch (_) {}
  };

  const chipBalance = user ? (Number(user.chips) / 1_000_000).toFixed(2) : '0.00';

  return (
    <div className="min-h-screen bg-brand-bg">
      <div className="max-w-6xl mx-auto px-4 py-10">

        {/* Hero */}
        <div className="text-center mb-14">
          <div className="flex justify-center mb-6">
            <img src="/assets/t3-logo-white.png" alt="T3 Poker" className="w-20 h-20 opacity-90" />
          </div>
          <h1 className="text-5xl font-bold text-white mb-3 tracking-tight">
            T3 Poker
          </h1>
          <p className="text-lg text-gray-400 mb-10">
            Fast. Fair. Crypto-native Texas Hold'em.
          </p>

          <button
            onClick={() => navigate('/lobby')}
            className="px-12 py-4 text-white text-lg font-bold rounded-xl hover:opacity-90 transition-all active:scale-95 shadow-lg"
            style={{ background: 'linear-gradient(135deg, #12ceec, #9c51ff)', boxShadow: '0 8px 30px rgba(18,206,236,0.25)' }}
          >
            Play Now
          </button>
        </div>

        {/* Stats */}
        <div className="flex flex-wrap justify-center gap-3 sm:gap-6 mb-14">
          <div className="rounded-xl px-5 sm:px-8 py-3 sm:py-4 text-center border" style={{ background: 'rgba(18,206,236,0.06)', borderColor: 'rgba(18,206,236,0.15)' }}>
            <p className="text-xl sm:text-2xl font-bold" style={{ color: '#12ceec' }}>{stats.playersOnline}</p>
            <p className="text-gray-500 text-sm">Players Online</p>
          </div>
          <div className="rounded-xl px-8 py-4 text-center border" style={{ background: 'rgba(156,81,255,0.06)', borderColor: 'rgba(156,81,255,0.15)' }}>
            <p className="text-2xl font-bold" style={{ color: '#9c51ff' }}>{stats.tablesActive}</p>
            <p className="text-gray-500 text-sm">Active Tables</p>
          </div>
          <div className="rounded-xl px-8 py-4 text-center border border-white/10 bg-white/5">
            <div className="flex items-center justify-center gap-2">
              <img src="/assets/musd-logo.png" alt="mUSD" className="w-5 h-5" />
              <p className="text-2xl font-bold text-white">{chipBalance}</p>
            </div>
            <p className="text-gray-500 text-sm">Your Balance</p>
          </div>
        </div>

        {/* Live Tables */}
        <div className="bg-white/[0.03] rounded-2xl p-6 mb-8 border border-white/5">
          <div className="flex justify-between items-center mb-5">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              Live Tables
            </h2>
            <button
              onClick={() => navigate('/lobby')}
              className="text-sm hover:underline" style={{ color: '#12ceec' }}
            >
              View All →
            </button>
          </div>

          {activeTables.length === 0 ? (
            <div className="text-center py-10">
              <p className="text-gray-500 mb-4">No active tables right now</p>
              <button
                onClick={() => navigate('/lobby')}
                className="px-6 py-2 rounded-lg hover:opacity-80 transition text-sm text-white"
                style={{ background: 'linear-gradient(135deg, #12ceec, #9c51ff)' }}
              >
                Create a Table
              </button>
            </div>
          ) : (
            <div className="space-y-1">
              {activeTables.map((table) => (
                <div
                  key={table.id}
                  className="flex items-center justify-between bg-white/[0.03] rounded-lg px-4 py-3 hover:bg-white/[0.06] transition cursor-pointer"
                  onClick={() => navigate('/lobby')}
                >
                  <div className="flex items-center gap-4">
                    <div className={`w-2 h-2 rounded-full ${
                      table.status === 'in_progress' ? 'bg-green-400 animate-pulse' : 'bg-yellow-400'
                    }`} />
                    <div>
                      <p className="text-white font-medium text-sm">{table.name}</p>
                      <p className="text-gray-500 text-xs">
                        Blinds {table.smallBlind}/{table.bigBlind}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-white text-sm">{table.players}/{table.maxPlayers}</p>
                    <p className={`text-xs ${
                      table.status === 'waiting' ? 'text-yellow-400' : 'text-green-400'
                    }`}>
                      {table.status === 'waiting' ? 'Open' : 'Playing'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Feature Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          {[
            {
              title: 'Instant Play',
              desc: 'Join a table in seconds. No downloads, no waiting.',
              gradient: 'from-brand-cyan/10 to-transparent',
              border: 'border-brand-cyan/10',
            },
            {
              title: 'Crypto-Native',
              desc: 'Deposit and withdraw stablecoins. Fast and transparent.',
              gradient: 'from-brand-purple/10 to-transparent',
              border: 'border-brand-purple/10',
            },
            {
              title: 'Fair Play',
              desc: 'Provably fair dealing. Full hand history. No hidden edges.',
              gradient: 'from-green-500/10 to-transparent',
              border: 'border-green-500/10',
            },
          ].map(({ title, desc, gradient, border }) => (
            <div key={title} className={`bg-gradient-to-br ${gradient} rounded-xl p-5 border ${border}`}>
              <h3 className="text-white font-bold mb-2">{title}</h3>
              <p className="text-gray-400 text-sm">{desc}</p>
            </div>
          ))}
        </div>

        {/* Leaderboards placeholder */}
        <div className="bg-white/[0.03] rounded-2xl p-6 border border-white/5">
          <h2 className="text-lg font-bold text-white mb-4">Leaderboards</h2>
          <p className="text-gray-600 text-center py-8 text-sm">Coming soon — top players, creators, and earners.</p>
        </div>
      </div>
    </div>
  );
}
