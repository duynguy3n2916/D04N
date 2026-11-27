import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { Select } from './Select';

/* Mẫu "danh sách quản lý" dùng chung cho các trang giáo viên:
   ô số liệu → viên lọc + ô tìm → bảng (chọn nhiều) → thanh thao tác nổi ở đáy. */

export interface Kpi { label: string; value: ReactNode; hint?: string; brand?: boolean }

export function KpiRow({ items }: { items: Kpi[] }) {
  return (
    <div className="m-kpis">
      {items.map((k) => (
        <div key={k.label} className={`kpi m-kpi ${k.brand ? 'kpi-brand' : ''}`}>
          <span className="kpi-label">{k.label}</span>
          <strong>{k.value}</strong>
          {k.hint && <span className="m-kpi-hint">{k.hint}</span>}
        </div>
      ))}
    </div>
  );
}

export function FilterPills<T extends string>({ options, value, onChange, label }: {
  options: { id: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void; label: string;
}) {
  return (
    <div className="m-pills" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id || 'all'} type="button" className={`m-pill ${value === o.id ? 'on' : ''}`} aria-pressed={value === o.id} onClick={() => onChange(o.id)}>
          {o.label}{o.count != null && <span className="m-pill-n">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Ô chọn dạng viên (cho danh sách dài như bài học). */
export function PillSelect({ value, onChange, label, children }: { value: string; onChange: (v: string) => void; label: string; children: ReactNode }) {
  return <Select variant="pill" value={value} onChange={onChange} aria-label={label}>{children}</Select>;
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="m-search">
      <Icon name="search" size={18} />
      <span className="sr-only">{placeholder}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      {value && <button type="button" className="m-search-x" aria-label="Xóa từ khóa" onClick={() => onChange('')}><Icon name="x" size={14} /></button>}
    </label>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="m-toolbar">{children}</div>;
}

/** Chọn nhiều hàng trong bảng. */
export function useSelection(ids: string[]) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const visible = useMemo(() => new Set(ids), [ids]);
  const selected = useMemo(() => [...sel].filter((id) => visible.has(id)), [sel, visible]);
  const toggle = useCallback((id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);
  const allOn = ids.length > 0 && selected.length === ids.length;
  const toggleAll = useCallback(() => setSel(allOn ? new Set() : new Set(ids)), [allOn, ids]);
  const clear = useCallback(() => setSel(new Set()), []);
  return { selected, has: (id: string) => sel.has(id) && visible.has(id), toggle, toggleAll, allOn, clear };
}

export function Check({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className="m-check" onClick={(e) => e.stopPropagation()}>
      <input type="checkbox" checked={checked} onChange={onChange} aria-label={label} />
      <span aria-hidden="true">{checked && <Icon name="check" size={13} stroke={3.4} />}</span>
    </label>
  );
}

/** Thanh thao tác nổi ở đáy màn hình, chỉ hiện khi có hàng được chọn. */
export function BulkBar({ count, noun, onClear, children }: { count: number; noun: string; onClear: () => void; children: ReactNode }) {
  if (!count) return null;
  return (
    <div className="m-bulk" role="region" aria-label="Thao tác với mục đã chọn">
      <span>Đã chọn {count} {noun}</span>
      {children}
      <button type="button" className="m-bulk-x" onClick={onClear} aria-label="Bỏ chọn"><Icon name="x" size={16} /></button>
    </div>
  );
}

/** Nhãn trạng thái màu: ok = xanh lá, wait = màu chủ đạo, bad = màu lỗi, ai = nền tối, muted = xám. */
export function StatusTag({ tone, children }: { tone: 'ok' | 'wait' | 'bad' | 'ai' | 'muted'; children: ReactNode }) {
  return <span className={`m-tag m-tag-${tone}`}>{children}</span>;
}

/** Ngăn trượt từ bên phải để sửa/xem chi tiết một hàng. Esc hoặc bấm nền để đóng. */
export function Drawer({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return (
    <div className="m-drawer-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <aside className={`m-drawer ${wide ? 'm-drawer-wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} tabIndex={-1}
        ref={(el) => { if (el && !el.contains(document.activeElement)) el.focus(); }}>
        <header className="m-drawer-head">
          <strong>{title}</strong>
          <button type="button" className="iconbtn" aria-label="Đóng" onClick={onClose}><Icon name="x" size={20} /></button>
        </header>
        <div className="m-drawer-body">{children}</div>
        {footer && <footer className="m-drawer-foot">{footer}</footer>}
      </aside>
    </div>
  );
}
