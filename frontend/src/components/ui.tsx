import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
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
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && dismissable) onClose?.(); };
    ref.current?.addEventListener('keydown', onKey);
    const el = ref.current;
    return () => { el?.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [open, dismissable, onClose]);
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
