import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { storage } from '../lib/api';
import { Icon, type IconName } from './Icon';

type Variant = 'green' | 'blue' | 'ghost' | 'red' | 'danger-ghost' | 'soft';

export function Button({ variant = 'green', size = 'md', icon, loading, children, className = '', ...rest }: {
  variant?: Variant; size?: 'sm' | 'md' | 'lg'; icon?: IconName; loading?: boolean; children?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`btn btn-${variant} btn-${size} ${className}`} disabled={loading || rest.disabled} {...rest}>
      {loading ? <span className="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={size === 'sm' ? 16 : 20} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon, label, onClick, active, className = '', disabled }: {
  icon: IconName; label: string; onClick?: () => void; active?: boolean; className?: string; disabled?: boolean;
}) {
  return (
    <button type="button" className={`iconbtn ${active ? 'iconbtn-on' : ''} ${className}`} aria-label={label} title={label}
      onClick={onClick} disabled={disabled}>
      <Icon name={icon} size={20} />
    </button>
  );
}

export function Badge({ tone = 'gray', children }: { tone?: 'gray' | 'green' | 'blue' | 'orange' | 'red' | 'purple' | 'yellow'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Progress({ value, tone = 'green', height = 14, label }: { value: number; tone?: 'green' | 'yellow' | 'blue'; height?: number; label?: string }) {
  const v = Math.max(0, Math.min(1, value || 0));
  return (
    <div className="progress" style={{ height }} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)}>
      <div className={`progress-fill progress-${tone}`} style={{ width: `${v * 100}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------- Hiệu ứng nhẹ

const FX_KEY = 'mam.reduceFx';

/** Đúng khi được phép chạy hiệu ứng: không bật "Giảm hiệu ứng" và hệ điều hành không yêu cầu giảm chuyển động. */
export function motionOk() {
  if (document.documentElement.classList.contains('reduce-fx')) return false;
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** Áp lựa chọn "Giảm hiệu ứng" đã lưu. Gọi một lần khi khởi động app. */
export function applyReduceFx(on: boolean = storage.get(FX_KEY) === '1') {
  document.documentElement.classList.toggle('reduce-fx', on);
}

export function setReduceFx(on: boolean) {
  storage.set(FX_KEY, on ? '1' : '0');
  applyReduceFx(on);
}

/** Số đếm lên mượt khi giá trị đổi (XP, chuỗi ngày). Tắt khi giảm hiệu ứng. */
export function CountUp({ value, decimals = 0 }: { value: number; decimals?: number }) {
  const cur = useRef(value);
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (!motionOk()) { cur.current = value; setShown(value); return; }
    const from = cur.current, start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / 900), e = 1 - Math.pow(1 - p, 3);
      const v = from + (value - from) * e;
      cur.current = v;
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{shown.toLocaleString('vi-VN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</>;
}

/** Pháo giấy nhẹ khi trả lời đúng hoặc đạt bài kiểm tra. */
export function celebrate(pieces = 36) {
  if (!motionOk()) return;
  const colors = ['#34A30F', '#1E9BF0', '#8B5CF6', '#FFC233', '#FF922B', '#FF6B6B'];
  for (let i = 0; i < pieces; i++) {
    const c = document.createElement('i');
    c.className = 'confetti';
    c.style.left = `${Math.random() * 100}vw`;
    c.style.background = colors[i % colors.length];
    c.style.setProperty('--x', `${Math.random() * 160 - 80}px`);
    c.style.animationDuration = `${1.7 + Math.random()}s`;
    c.style.animationDelay = `${Math.random() * 0.2}s`;
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 3000);
  }
}

export function Spinner({ label = 'Đang tải…' }: { label?: string }) {
  return <div className="loading"><span className="spinner spinner-dark" aria-hidden="true" />{label}</div>;
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="errorbox" role="alert">
      <span>{message}</span>
      {onRetry && <Button variant="ghost" size="sm" onClick={onRetry}>Thử lại</Button>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><strong>{title}</strong>{children && <div>{children}</div>}</div>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Modal({ open, onClose, title, children, wide, dismissable = true }: {
  open: boolean; onClose?: () => void; title?: string; children: ReactNode; wide?: boolean; dismissable?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeOptions = useRef({ onClose, dismissable });
  useEffect(() => { closeOptions.current = { onClose, dismissable }; }, [onClose, dismissable]);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const options = closeOptions.current;
      if (e.key === 'Escape' && options.dismissable) options.onClose?.();
    };
    ref.current?.addEventListener('keydown', onKey);
    const el = ref.current;
    return () => { el?.removeEventListener('keydown', onKey); prev?.focus?.(); };
    // Chỉ đặt/khôi phục focus khi mở hoặc đóng, không làm lại khi form render vì đang gõ.
  }, [open]);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => { if (dismissable && e.target === e.currentTarget) onClose?.(); }}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        {title && (
          <div className="modal-head">
            <h2>{title}</h2>
            {dismissable && <IconButton icon="x" label="Đóng" onClick={onClose} />}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Toast

type Toast = { id: number; text: string; tone: 'info' | 'success' | 'error' | 'xp' };
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, text, tone }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast toast-${t.tone}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);


// ---------------------------------------------------------------- Confirm

type ConfirmOpts = { title?: string; okLabel?: string; danger?: boolean };
type ConfirmState = ConfirmOpts & { message: string; resolve: (ok: boolean) => void };
const ConfirmCtx = createContext<(message: string, opts?: ConfirmOpts) => Promise<boolean>>(async () => false);
let globalAsk: ((message: string, opts?: ConfirmOpts) => Promise<boolean>) | null = null;

/** Gọi được ở bất kỳ đâu (không cần hook): `if (!await confirmDialog('Xóa?', { danger: true })) return;` */
export function confirmDialog(message: string, opts?: ConfirmOpts): Promise<boolean> {
  return globalAsk ? globalAsk(message, opts) : Promise.resolve(window.confirm(message));
}

/** Hộp thoại xác nhận của app (thay cho window.confirm): await confirm('...') trả về true/false. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null);
  const ask = useCallback((message: string, opts: ConfirmOpts = {}) =>
    new Promise<boolean>((resolve) => setState({ message, resolve, ...opts })), []);
  useEffect(() => { globalAsk = ask; return () => { globalAsk = null; }; }, [ask]);
  const close = (ok: boolean) => { state?.resolve(ok); setState(null); };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      <Modal open={!!state} onClose={() => close(false)} title={state?.title || 'Xác nhận'}>
        <div className="modal-body">
          <p style={{ fontWeight: 700 }}>{state?.message}</p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => close(false)}>Hủy</Button>
            <Button variant={state?.danger ? 'red' : 'green'} autoFocus onClick={() => close(true)}>{state?.okLabel || 'Đồng ý'}</Button>
          </div>
        </div>
      </Modal>
    </ConfirmCtx.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmCtx);
