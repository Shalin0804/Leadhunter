import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { authApi } from '../services/endpoints';
import { tokenStore } from '../services/api';

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [permissions, setPermissions] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    if (!tokenStore.get()) {
      setLoading(false);
      return;
    }
    try {
      const { user: u, permissions: p } = await authApi.me();
      setUser(u);
      setPermissions(p || []);
    } catch {
      tokenStore.clear();
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  const login = async (email, password) => {
    const { token, user: u, permissions: p } = await authApi.login(email, password);
    tokenStore.set(token);
    setUser(u);
    setPermissions(p || []);
    return u;
  };

  const logout = async () => {
    await authApi.logout();
    tokenStore.clear();
    setUser(null);
    setPermissions([]);
  };

  // UI hint only — the server enforces every permission itself.
  const can = useCallback((perm) => permissions.includes(perm), [permissions]);

  return (
    <AuthContext.Provider value={{ user, permissions, can, loading, login, logout, isAuthenticated: !!user }}>
      {children}
    </AuthContext.Provider>
  );
}
