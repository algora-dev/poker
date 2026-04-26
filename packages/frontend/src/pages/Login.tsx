import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { authApi } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { styles, cls } from '../styles/theme';

export default function Login() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((state) => state.setAuth);
  const [formData, setFormData] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const response = await authApi.login(formData);
      setAuth(response.user, response.accessToken, response.refreshToken);
      navigate('/home');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Login failed. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={styles.page}>
      <div className="max-w-md w-full rounded-2xl p-8 border border-white/10" style={styles.card}>
        <div className="flex justify-center mb-6">
          <img src="/assets/t3-logo-white.png" alt="T3" className="w-12 h-12 opacity-80" />
        </div>
        <h1 className="text-2xl font-bold text-white text-center mb-1">Welcome Back</h1>
        <p className="text-gray-500 text-center mb-6 text-sm">Login to play</p>

        {error && (
          <div className="rounded-lg p-3 mb-4 border text-sm" style={styles.error}>{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className={cls.label + ' block mb-1.5'}>Email</label>
            <input
              type="email"
              required
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              className={cls.input}
              style={styles.input}
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className={cls.label + ' block mb-1.5'}>Password</label>
            <input
              type="password"
              required
              value={formData.password}
              onChange={(e) => setFormData({ ...formData, password: e.target.value })}
              className={cls.input}
              style={styles.input}
              placeholder="••••••••"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className={'w-full py-3 ' + cls.btnPrimary}
            style={styles.btnPrimary}
          >
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </form>

        <p className="text-center text-gray-500 mt-6 text-sm">
          Don't have an account?{' '}
          <Link to="/signup" className="hover:underline" style={{color:'#12ceec'}}>Sign up</Link>
        </p>
      </div>
    </div>
  );
}
