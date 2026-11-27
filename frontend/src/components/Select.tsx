import {
  Children, Fragment, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

/* Ô chọn (dropdown) dùng chung cho toàn bộ web, thay cho <select> mặc định của trình duyệt.
   - Viết giống <select>: con là <option> / <optgroup>, nên đổi sang rất ít sửa.
   - Danh sách mở ra theo màu chủ đạo (--brand...), bo góc, có dấu tích ở mục đang chọn.
   - Danh sách nổi bằng portal (position: fixed), tự lật lên trên khi thiếu chỗ, không bị cắt trong modal/drawer
     và không đẩy nội dung bên dưới.
   - Bàn phím: ↑/↓ Home/End PageUp/PageDown, Enter/Space chọn, Esc/Tab đóng, gõ chữ để nhảy tới mục.
   - Danh sách dài (> 10 mục) có ô tìm nhanh. */

export interface SelectOption { value: string; label: string; group?: string; disabled?: boolean }

type Variant = 'field' | 'pill' | 'compact';

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

function collect(children: ReactNode, group: string | undefined, out: SelectOption[]) {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const p = child.props as { value?: string | number; children?: ReactNode; label?: string; disabled?: boolean };
    if (child.type === 'option') {
      const label = textOf(p.children);
      out.push({ value: p.value != null ? String(p.value) : label, label, group, disabled: !!p.disabled });
    } else if (child.type === 'optgroup') {
      collect(p.children, p.label, out);
    } else if (child.type === Fragment) {
      collect(p.children, group, out);
    }
  });
  return out;
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

interface Pos { left: number; top?: number; bottom?: number; width: number; maxHeight: number }

export function Select({
  value, onChange, children, options: optionsProp, disabled, className, style, id, placeholder,
  variant = 'field', searchable, 'aria-label': ariaLabel, title,
}: {
  value: string | number;
  onChange: (value: string) => void;
  children?: ReactNode;
  options?: SelectOption[];
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  id?: string;
  placeholder?: string;
  variant?: Variant;
  searchable?: boolean;
  'aria-label'?: string;
  title?: string;
}) {
  const options = useMemo(() => optionsProp || collect(children, undefined, []), [optionsProp, children]);
  const current = String(value ?? '');
  const selectedIndex = options.findIndex((o) => o.value === current);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const canSearch = searchable ?? options.length > 10;

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState<Pos | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const listId = useId();

  const visible = useMemo(() => {
    const q = fold(query.trim());
    return options.map((o, i) => ({ o, i })).filter(({ o }) => !q || fold(o.label).includes(q));
  }, [options, query]);

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight, gap = 6, margin = 8;
    const width = Math.min(Math.max(r.width, 200), vw - margin * 2);
    const left = Math.min(Math.max(margin, r.left), vw - width - margin);
    const below = vh - r.bottom - gap - margin, above = r.top - gap - margin;
    const want = Math.min(320, (popRef.current?.scrollHeight || 320));
    if (below >= want || below >= above) setPos({ left, width, top: r.bottom + gap, maxHeight: Math.max(120, Math.min(320, below)) });
    else setPos({ left, width, bottom: vh - r.top + gap, maxHeight: Math.max(120, Math.min(320, above)) });
  }, []);

  const close = useCallback((refocus = true) => {
    setOpen(false); setQuery(''); setPos(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const openList = () => {
    if (disabled) return;
    setActive(selectedIndex >= 0 && !options[selectedIndex].disabled ? selectedIndex : options.findIndex((o) => !o.disabled));
    setOpen(true);
  };

  const choose = (index: number) => {
    const o = options[index];
    if (!o || o.disabled) return;
    if (o.value !== current) onChange(o.value);
    close();
  };

  useLayoutEffect(() => { if (open) place(); }, [open, place, visible.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popRef.current?.contains(t)) return;
      close(false);
    };
    const onScroll = (e: Event) => { if (!popRef.current?.contains(e.target as Node)) place(); };
    // Esc chỉ đóng danh sách, không đóng luôn modal/drawer/menu chứa nó (bắt ở pha capture, trước các listener khác).
    const onEsc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onEsc, true);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    if (canSearch) requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      window.removeEventListener('keydown', onEsc, true);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, place, close, canSearch]);

  useEffect(() => {
    if (!open || active < 0) return;
    popRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  // Nếu ô tìm lọc mất mục đang sáng thì sáng mục đầu tiên còn lại.
  useEffect(() => {
    if (open && !visible.some((v) => v.i === active)) setActive(visible.find((v) => !v.o.disabled)?.i ?? -1);
  }, [open, visible, active]);

  const move = (step: number | 'first' | 'last') => {
    const ids = visible.filter((v) => !v.o.disabled).map((v) => v.i);
    if (!ids.length) return;
    if (step === 'first') return setActive(ids[0]);
    if (step === 'last') return setActive(ids[ids.length - 1]);
    const at = ids.indexOf(active);
    const next = at < 0 ? (step > 0 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, at + step));
    setActive(ids[next]);
  };

  const typeAhead = (ch: string) => {
    const now = Date.now();
    typed.current = { text: (now - typed.current.at < 600 ? typed.current.text : '') + ch, at: now };
    const q = fold(typed.current.text);
    const hit = options.findIndex((o) => !o.disabled && fold(o.label).startsWith(q));
    if (hit < 0) return;
    if (open) setActive(hit);
    else if (options[hit].value !== current) onChange(options[hit].value);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (disabled) return;
    const k = e.key;
    if (!open) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') { e.preventDefault(); openList(); }
      else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) typeAhead(k);
      return;
    }
    if (k === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (k === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (k === 'PageDown') { e.preventDefault(); move(8); }
    else if (k === 'PageUp') { e.preventDefault(); move(-8); }
    else if (k === 'Home' && !canSearch) { e.preventDefault(); move('first'); }
    else if (k === 'End' && !canSearch) { e.preventDefault(); move('last'); }
    else if (k === 'Enter' || (k === ' ' && !canSearch)) { e.preventDefault(); choose(active); }
    else if (k === 'Tab') close(false);
    else if (!canSearch && k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) typeAhead(k);
  };

  const label = selected ? selected.label : (placeholder ?? '');
  const portalTarget = typeof document === 'undefined' ? null : (document.fullscreenElement as HTMLElement | null) || document.body;

  let lastGroup: string | undefined;
  const items: ReactNode[] = [];
  visible.forEach(({ o, i }) => {
    if (o.group && o.group !== lastGroup) items.push(<div key={`g-${i}`} className="dd-group" role="presentation">{o.group}</div>);
    lastGroup = o.group;
    const isSel = i === selectedIndex;
    items.push(
      <div key={i} id={`${listId}-${i}`} data-i={i} role="option" aria-selected={isSel} aria-disabled={o.disabled || undefined}
        className={`dd-option${isSel ? ' sel' : ''}${i === active ? ' active' : ''}${o.disabled ? ' off' : ''}${o.group ? ' in-group' : ''}`}
        onMouseDown={(e) => e.preventDefault()} onMouseMove={() => { if (!o.disabled && i !== active) setActive(i); }}
        onClick={() => choose(i)}>
        <span>{o.label || ' '}</span>
        {isSel && <Icon name="check" size={16} />}
      </div>,
    );
  });

  return (
    <>
      <button ref={triggerRef} type="button" id={id} title={title ?? (label.length > 30 ? label : undefined)}
        className={`dd dd-${variant}${open ? ' open' : ''}${current ? ' has-value' : ''}${className ? ` ${className}` : ''}`}
        style={style} disabled={disabled} role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 && !canSearch ? `${listId}-${active}` : undefined} aria-label={ariaLabel}
        onClick={() => (open ? close() : openList())} onKeyDown={onKeyDown}>
        <span className={`dd-value${selected ? '' : ' dd-placeholder'}`}>{label || ' '}</span>
        <Icon name="chevronDown" size={15} className="dd-caret" />
      </button>
      {open && portalTarget && createPortal(
        <div ref={popRef} className="dd-pop" style={{ left: pos?.left ?? -9999, top: pos?.top, bottom: pos?.bottom, width: pos?.width, maxHeight: pos?.maxHeight, visibility: pos ? 'visible' : 'hidden' }}>
          {canSearch && (
            <div className="dd-search">
              <Icon name="search" size={15} />
              <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} placeholder="Tìm…"
                aria-label="Tìm trong danh sách" aria-controls={listId} aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined} />
            </div>
          )}
          <div id={listId} className="dd-list" role="listbox" aria-label={ariaLabel}>
            {items.length ? items : <div className="dd-empty">Không có mục phù hợp</div>}
          </div>
        </div>,
        portalTarget,
      )}
    </>
  );
}
