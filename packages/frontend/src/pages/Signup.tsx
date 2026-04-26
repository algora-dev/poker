import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { authApi } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { styles, cls } from '../styles/theme';

export default function Signup() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((state) => state.setAuth);
  const [formData, setFormData] = useState({
    email: '', username: '', password: '', confirmPassword: '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (formData.password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setLoading(true);
    try {
      const response = await authApi.signup({
        email: formData.email,
        username: formData.username,
        password: formData.password,
      });
      setAuth(response.user, response.accessToken, response.refreshToken);
      navigate('/home');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Signup failed. Please try again.');
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
        <h1 className="text-2xl font-bold text-white text-center mb-1">Create Account</h1>
        <p className="text-gray-500 text-center mb-6 text-sm">Join the table</p>

        {error && (
          <div className="rounded-lg p-3 mb-4 border text-sm" style={styles.error}>{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className={cls.label + ' block mb-1.5'}>Email</label>
            <input
              type="email" required
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              className={cls.input} style={styles.input}
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className={cls.label + ' block mb-1.5'}>Username</label>
            <input
              type="text" required
              value={formData.username}
              onChange={(e) => setFormData({ ...formData, username: e.target.value })}
              className={cls.input} style={styles.input}
              placeholder="pokerpro99"
            />
          </div>
          <div>
            <label className={cls.label + ' block mb-1.5'}>Password</label>
            <input
              type="password" required
              value={formData.password}
              onChange={(e) => setFormData({ ...formData, password: e.target.value })}
              className={cls.input} style={styles.input}
              placeholder="••••••••"
            />
          </div>
          <div>
            <label className={cls.label + ' block mb-1.5'}>Confirm Password</label>
            <input
              type="password" required
              value={formData.confirmPassword}
              onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
              className={cls.input} style={styles.input}
              placeholder="••••••••"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className={'w-full py-3 ' + cls.btnPrimary}
            style={styles.btnPrimary}
          >
            {loading ? 'Creating account...' : 'Sign Up'}
          </button>
        </form>

        <p className="text-center text-gray-500 mt-6 text-sm">
          Already have an account?{' '}
          <Link to="/login" className="hover:underline" style={{color:'#12ceec'}}>Login</Link>
        </p>
      </div>
    </div>
  );
}
