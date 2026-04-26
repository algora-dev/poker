import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/authStore';
import { NavBar } from './components/NavBar';
import Login from './pages/Login';
import Signup from './pages/Signup';
import Home from './pages/Home';
import Dashboard from './pages/Dashboard';
import Lobby from './pages/Lobby';
import GameRoom from './pages/GameRoom';

function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}

function AppContent() {
  return (
    <>
      <NavBar />
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route
          path="/home"
          element={
            <ProtectedRoute>
              <Home />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/lobby"
          element={
            <ProtectedRoute>
              <Lobby />
            </ProtectedRoute>
          }
        />
        <Route
          path="/game/:gameId"
          element={
            <ProtectedRoute>
              <GameRoom />
            </ProtectedRoute>
          }
        />
      </Routes>
    </>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function RootRedirect() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  if (isAuthenticated) {
    return <Navigate to="/home" replace />;
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-brand-bg">
      <div className="text-center">
        <img src="/assets/t3-logo-white.png" alt="T3 Poker" className="w-24 h-24 mx-auto mb-6 opacity-90" />
        <h1 className="text-5xl font-bold mb-3 text-white tracking-tight">
          T3 Poker
        </h1>
        <p className="text-lg text-gray-400 mb-10">
          Crypto-native Texas Hold'em
        </p>
        <div className="flex gap-3 justify-center">
          <a
            href="/login"
            className="px-8 py-3 bg-gradient-to-r from-brand-cyan to-brand-purple text-white font-bold rounded-xl hover:opacity-90 transition-all active:scale-95 shadow-lg shadow-brand-cyan/20"
          >
            Login
          </a>
          <a
            href="/signup"
            className="px-8 py-3 bg-white/5 border border-white/10 text-white font-bold rounded-xl hover:bg-white/10 transition"
          >
            Sign Up
          </a>
        </div>
      </div>
    </div>
  );
}

export default App;
