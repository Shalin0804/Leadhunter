import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FiTarget, FiSearch, FiTrendingUp, FiUsers } from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

export default function Login() {
  const { login } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [email, setEmail] = useState('admin@leadhunter.local');
  const [password, setPassword] = useState('Admin@123456');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await login(email.trim(), password);
      toast.success('Welcome back');
      navigate('/dashboard');
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-hero">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 26 }}>
            <span className="logo-mark" style={{ width: 40, height: 40 }}>
              <FiTarget size={20} />
            </span>
            <strong style={{ fontSize: 18 }}>LeadHunter CRM</strong>
          </div>
          <h1>Discover New Businesses. Find Opportunities. Win Clients.</h1>
          <p>
            A B2B lead-generation CRM built around discovering recently registered companies and turning
            them into qualified sales opportunities.
          </p>
          <div className="feat">
            <FiSearch /> Company discovery with new-registration filters
          </div>
          <div className="feat">
            <FiTrendingUp /> Automated lead scoring &amp; service recommendations
          </div>
          <div className="feat">
            <FiUsers /> Full pipeline, tasks, notes and CSV import
          </div>
        </motion.div>
      </div>

      <div className="login-form-side">
        <motion.div className="login-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <h2>Sign in</h2>
          <p className="sub">Use your LeadHunter CRM admin account.</p>
          {error && <div className="error-box mb-3">{error}</div>}
          <form onSubmit={submit}>
            <div className="field">
              <label>Email</label>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
              />
            </div>
            <div className="field">
              <label>Password</label>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            <button className="btn btn-primary btn-block" disabled={loading}>
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
          <div className="demo-hint">
            <strong>Development login</strong>
            <br />
            admin@leadhunter.local / Admin@123456
          </div>
        </motion.div>
      </div>
    </div>
  );
}
