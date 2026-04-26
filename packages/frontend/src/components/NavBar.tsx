import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { getAvatarSrc } from '../utils/avatars';

export function NavBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuthStore();
  const [mobileOpen, setMobileOpen] = useState(false);

  if (!user) return null;
  if (location.pathname.startsWith('/game/')) return null;

  const isActive = (path: string) => location.pathname === path;
  const chipBalance = (Number(user.chips) / 1_000_000).toFixed(2);
  const avatarSrc = getAvatarSrc(user.avatarId || 2);

  const navItems = [
    { path: '/home', label: 'Home' },
    { path: '/lobby', label: 'Lobby' },
    { path: '/dashboard', label: 'Account' },
  ];

  const navTo = (path: string) => {
    navigate(path);
    setMobileOpen(false);
  };

  return (
    <nav className="sticky top-0 z-50 border-b border-white/5" style={{background:'rgba(38,38,38,0.95)', backdropFilter:'blur(12px)'}}>
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex items-center justify-between h-14">
          {/* Left: Logo */}
          <div className="flex items-center gap-4">
            <button onClick={() => navTo('/home')} className="flex items-center gap-2 hover:opacity-80 transition">
              <img src="/assets/t3-logo-white.png" alt="T3" className="w-7 h-7" />
              <span className="text-white font-bold text-lg hidden sm:block">T3 Poker</span>
            </button>

            {/* Desktop Nav */}
            <div className="hidden sm:flex gap-0.5">
              {navItems.map(({ path, label }) => (
                <button
                  key={path}
                  onClick={() => navTo(path)}
                  className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
                    isActive(path) ? 'text-white' : 'text-gray-400 hover:text-white hover:bg-white/5'
                  }`}
                  style={isActive(path) ? {background:'rgba(18,206,236,0.12)', color:'#12ceec'} : {}}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Right */}
          <div className="flex items-center gap-3">
            {/* Balance */}
            <button
              onClick={() => navTo('/dashboard')}
              className="flex items-center gap-1.5 rounded-full px-3 py-1.5 border border-white/10 hover:bg-white/5 transition"
              style={{background:'rgba(255,255,255,0.03)'}}
            >
              <img src="/assets/musd-logo.png" alt="mUSD" className="w-4 h-4" />
              <span className="text-white font-semibold text-sm">{chipBalance}</span>
            </button>

            {/* Avatar — desktop */}
            <button onClick={() => navTo('/dashboard')} className="hidden sm:flex items-center gap-2 hover:opacity-80 transition">
              <div className="w-8 h-8 rounded-full overflow-hidden ring-1 ring-white/10">
                {avatarSrc ? <img src={avatarSrc} alt="" className="w-full h-full object-cover" /> : (
                  <div className="w-full h-full flex items-center justify-center text-white text-sm font-bold" style={{background:'#262626'}}>
                    {user.username?.charAt(0).toUpperCase()}
                  </div>
                )}
              </div>
            </button>

            {/* Mobile hamburger */}
            <button
              onClick={() => setMobileOpen(!mobileOpen)}
              className="sm:hidden text-gray-400 hover:text-white transition p-1"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {mobileOpen
                  ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                }
              </svg>
            </button>

            {/* Desktop logout */}
            <button onClick={() => { logout(); navigate('/login'); }} className="hidden sm:block text-gray-600 hover:text-red-400 transition text-xs">
              Logout
            </button>
          </div>
        </div>

        {/* Mobile dropdown */}
        {mobileOpen && (
          <div className="sm:hidden pb-4 border-t border-white/5 mt-2 pt-3 space-y-1">
            {navItems.map(({ path, label }) => (
              <button
                key={path}
                onClick={() => navTo(path)}
                className={`block w-full text-left px-4 py-2.5 rounded-lg text-sm font-medium transition ${
                  isActive(path) ? 'text-white' : 'text-gray-400 hover:text-white hover:bg-white/5'
                }`}
                style={isActive(path) ? {background:'rgba(18,206,236,0.12)', color:'#12ceec'} : {}}
              >
                {label}
              </button>
            ))}
            <button
              onClick={() => { logout(); navigate('/login'); setMobileOpen(false); }}
              className="block w-full text-left px-4 py-2.5 rounded-lg text-sm font-medium text-red-400 hover:bg-red-500/10 transition"
            >
              Logout
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
