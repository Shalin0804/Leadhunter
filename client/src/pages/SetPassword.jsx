import { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { FiTarget } from 'react-icons/fi';
import { authApi } from '../services/endpoints';

// Public page behind the one-time invite / password-reset link.
export default function SetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [state, setState] = useState({ busy: false, error: null, done: false });

  const submit = async (e) => {
    e.preventDefault();
    if (password !== confirm) return setState({ busy: false, error: 'Passwords do not match', done: false });
    setState({ busy: true, error: null, done: false });
    try {
      await authApi.setPassword(token, password);
      setState({ busy: false, error: null, done: true });
    } catch (err) {
      setState({ busy: false, error: err.message, done: false });
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-form-side" style={{ flex: 1 }}>
        <div className="login-card">
          <div className="flex items-center gap-2 mb-3">
            <span className="logo-mark"><FiTarget /></span>
            <strong>LeadHunter CRM</strong>
          </div>
          <h2>Set your password</h2>
          {!token ? (
            <div className="error-box">This link is missing its token. Ask your administrator for a new one.</div>
          ) : state.done ? (
            <>
              <p className="sub">Your password is set.</p>
              <Link className="btn btn-primary btn-block" to="/login">Go to sign in</Link>
            </>
          ) : (
            <form onSubmit={submit}>
              <p className="sub">Use at least 8 characters. This link works once.</p>
              {state.error && <div className="error-box mb-3">{state.error}</div>}
              <div className="field">
                <label>New password</label>
                <input className="input" type="password" minLength={8} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
              </div>
              <div className="field">
                <label>Confirm password</label>
                <input className="input" type="password" minLength={8} maxLength={128} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
              </div>
              <button className="btn btn-primary btn-block" disabled={state.busy}>{state.busy ? 'Saving…' : 'Set password'}</button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
