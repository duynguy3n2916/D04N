// Router dạng hash (#/duong-dan) — không cần cấu hình phía server, chạy được khi FastAPI phục vụ file tĩnh.
import { useEffect, useState, type AnchorHTMLAttributes, type ReactNode } from 'react';

function current() { return window.location.hash.replace(/^#/, '') || '/'; }

export function navigate(path: string, replace = false) {
  const url = '#' + path;
  if (replace) window.history.replaceState(null, '', url);
  else window.location.hash = path;
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useLocation(): string {
  const [path, setPath] = useState(current());
  useEffect(() => {
    const on = () => setPath(current());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return path;
}

/** So khớp mẫu '/lesson/:lessonId/:itemId?' → params hoặc null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('?')[0].split('/').filter(Boolean);
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i];
    const optional = seg.endsWith('?');
    const name = seg.replace(/^:/, '').replace(/\?$/, '');
    if (seg.startsWith(':')) {
      if (s[i] === undefined) { if (optional) continue; return null; }
      params[name] = decodeURIComponent(s[i]);
    } else if (seg !== s[i]) return null;
  }
  if (s.length > p.length) return null;
  return params;
}

export function Link({ to, children, ...rest }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a href={'#' + to} {...rest}>{children}</a>;
}
