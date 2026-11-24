import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, loadSession, setSession, setUnauthorizedHandler, type AuthResponse, type User } from './api';

interface AuthCtx {
  /** undefined = đang đọc phiên đã lưu; null = chưa đăng nhập. */
  user: User | null | undefined;
  notice: string | null;
  login: (username: string, password: string) => Promise<User>;
  changePassword: (current: string, next: string) => Promise<void>;
  logout: (notice?: string) => void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);

  const accept = async (r: AuthResponse) => { await setSession(r.access_token, r.user); setUser(r.user); setNotice(null); return r.user; };

  const logout = useCallback((msg?: string) => {
    setSession(null, null); setUser(null); setNotice(msg || null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler((msg) => logout(msg));
    loadSession().then(async (u) => {
      setUser(u);
      if (u) {
        // đồng bộ vai trò / lớp mới nhất (401 đã được handler xử lý)
        try { const fresh = await api<User>('/ai/auth/me'); setUser(fresh); } catch { /* giữ bản đã lưu khi mất mạng */ }
      }
    });
  }, [logout]);

  const value: AuthCtx = {
    user, notice, logout,
    // tài khoản quản trị vào app sẽ thấy giao diện giáo viên; các trang quản trị chỉ có trên web
    login: async (username, password) => accept(await api<AuthResponse>('/ai/auth/login', { json: { username, password } })),
    changePassword: async (current, next) => {
      await accept(await api<AuthResponse>('/ai/auth/change-password', { json: { current_password: current, new_password: next } }));
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth ngoài AuthProvider');
  return c;
}

export const isTeacher = (u: User | null | undefined) => !!u && (u.role === 'teacher' || u.role === 'admin');
