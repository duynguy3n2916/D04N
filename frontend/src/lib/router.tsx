// Router dạng hash (#/duong-dan) — không cần cấu hình phía server, chạy được khi FastAPI phục vụ file tĩnh.
import { useSyncExternalStore, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

function current() { return window.location.hash.replace(/^#/, '') || '/'; }

export function navigate(path: string, replace = false) {
  const url = '#' + path;
  if (replace) window.history.replaceState(null, '', url);
  else window.location.hash = path;
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

// Một nguồn đường dẫn dùng chung cho cả app. Khi đổi trang, trình duyệt hỗ trợ View Transitions (Chrome, Edge...)
// sẽ chụp trang cũ rồi chuyển mượt sang trang mới (hiệu ứng trong styles/polish.css); trình duyệt khác đổi ngay.
let currentPath = current();
const listeners = new Set<() => void>();

function reducedMotion() {
  return document.documentElement.classList.contains('reduce-fx') || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

window.addEventListener('hashchange', () => {
  const next = current();
  if (next === currentPath) return;
  const apply = () => { currentPath = next; listeners.forEach((l) => l()); };
  // Đổi qua lại trong cùng một trang có danh sách bên cạnh (vd. giữa các cuộc trò chuyện trong Tin nhắn):
  // đổi ngay, không chạy hiệu ứng chuyển trang (hiệu ứng làm cả trang mờ đi rồi trượt lên, trông như bị nhảy).
  const section = (p: string) => p.split('?')[0].split('/')[1] || '';
  if (section(next) === 'messages' && section(currentPath) === 'messages') { apply(); return; }
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !reducedMotion() && document.visibilityState === 'visible') doc.startViewTransition(() => flushSync(apply));
  else apply();
});

function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

export function useLocation(): string {
  return useSyncExternalStore(subscribe, () => currentPath);
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
