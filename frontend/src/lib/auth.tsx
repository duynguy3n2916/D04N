import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, savedUser, setMustChangeHandler, setSession, setUnauthorizedHandler, type AuthResponse, type User } from './api';
import { navigate } from './router';

export interface RegisterInput { username: string; password: string; display_name?: string; email?: string; class_code?: string }

interface AuthCtx {
  user: User | null;
  /** Thông báo hiện ở màn hình đăng nhập (vd: phiên bị thu hồi). */
  notice: string | null;
  login: (username: string, password: string) => Promise<User>;
  register: (p: RegisterInput) => Promise<User>;
  changePassword: (current: string, next: string) => Promise<void>;
  /** Cập nhật thông tin người dùng (sau khi sửa hồ sơ / vào lớp). */
  setUser: (u: User) => void;
  refresh: () => Promise<void>;
  logout: (notice?: string) => void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(savedUser());
  const [notice, setNotice] = useState<string | null>(null);

  const accept = (r: AuthResponse) => { setSession(r.access_token, r.user); setUserState(r.user); setNotice(null); return r.user; };
  const setUser = useCallback((u: User) => { setSession(getToken(), u); setUserState(u); }, []);

  const logout = useCallback((msg?: string) => {
    setSession(null, null); setUserState(null); setNotice(msg || null); navigate('/login');
  }, []);

  const refresh = useCallback(async () => {
    if (!getToken()) return;
    try { setUser(await api<User>('/ai/auth/me')); } catch { /* 401 đã được xử lý bởi handler */ }
  }, [setUser]);

  useEffect(() => {
    setUnauthorizedHandler((code, message) => logout(code === 'TOKEN_EXPIRED' || code === 'SESSION_REVOKED' || code === 'ACCOUNT_DISABLED' ? message : undefined));
    setMustChangeHandler(() => setUserState((u) => (u ? { ...u, must_change_password: true } : u)));
    refresh(); // đồng bộ vai trò / lớp mới nhất
  }, [logout, refresh]);

  const value: AuthCtx = {
    user, notice, setUser, refresh, logout,
    login: async (username, password) => accept(await api<AuthResponse>('/ai/auth/login', { json: { username, password } })),
    register: async (p) => accept(await api<AuthResponse>('/ai/auth/register', { json: p })),
    changePassword: async (current, next) => {
      accept(await api<AuthResponse>('/ai/auth/change-password', { json: { current_password: current, new_password: next } }));
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth ngoài AuthProvider');
  return c;
}

export const isTeacher = (u: User | null) => !!u && (u.role === 'teacher' || u.role === 'admin');
