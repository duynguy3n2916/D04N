import { useEffect, useRef, useState } from 'react';
import { DEFAULT_THEME, getSavedTheme, saveTheme, THEME_PRESETS, themeVars } from '../lib/theme';
import { Icon } from './Icon';

/** Màu đang dùng, tự cập nhật khi đổi ở nơi khác (thanh bên hoặc trang Hồ sơ). */
export function useThemeColor(): [string, (c: string) => void] {
  const [color, setColor] = useState(getSavedTheme);
  useEffect(() => {
    const on = (e: Event) => setColor((e as CustomEvent<string>).detail);
    window.addEventListener('mam-theme', on);
    return () => window.removeEventListener('mam-theme', on);
  }, []);
  return [color, saveTheme];
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function Swatches({ color, onPick, labels }: { color: string; onPick: (c: string) => void; labels: boolean }) {
  const custom = !THEME_PRESETS.some((p) => same(p.color, color));
  return (
    <div className="theme-swatches" role="group" aria-label="Màu chủ đạo">
      {THEME_PRESETS.map((p) => (
        <button key={p.id} type="button" className="theme-swatch" aria-pressed={same(p.color, color)} title={p.name} onClick={() => onPick(p.color)}>
          <span className="theme-dot" style={{ background: p.color }}>{same(p.color, color) && <Icon name="check" size={16} />}</span>
          {labels ? p.name : <span className="sr-only">{p.name}</span>}
        </button>
      ))}
      <label className="theme-swatch theme-custom" aria-pressed={custom} title="Tự chọn màu">
        <span className="theme-dot" style={{ background: custom ? themeVars(color)['--brand'] : 'conic-gradient(#e03131, #f08c00, #2f9e44, #1971c2, #6741d9, #e03131)' }}>
          {custom && <Icon name="check" size={16} />}
        </span>
        {labels ? 'Tự chọn' : <span className="sr-only">Tự chọn màu</span>}
        <input type="color" value={themeVars(color)['--brand']} onChange={(e) => onPick(e.target.value)} aria-label="Tự chọn màu chủ đạo" />
      </label>
    </div>
  );
}

/** Thẻ "Giao diện" trong trang Hồ sơ. */
export function ThemeSettings() {
  const [color, setColor] = useThemeColor();
  const adjusted = themeVars(color)['--brand'];
  return (
    <div className="card col" style={{ gap: 14 }}>
      <div className="card-title" style={{ marginBottom: 0 }}>
        <h2>Giao diện</h2>
        {!same(color, DEFAULT_THEME) && <button type="button" className="linkbtn" onClick={() => setColor(DEFAULT_THEME)}>Về mặc định</button>}
      </div>
      <p className="muted small">Chọn màu chủ đạo cho nút, điểm nhấn và thanh tiến độ. Màu được lưu trên trình duyệt này.</p>
      <Swatches color={color} onPick={setColor} labels />
      {!same(adjusted, color) && THEME_PRESETS.every((p) => !same(p.color, color)) && (
        <p className="small muted">Màu bạn chọn hơi sáng nên đã được làm đậm thêm một chút để chữ trên nút vẫn dễ đọc.</p>
      )}
      <div className="theme-preview" aria-label="Xem trước">
        <span className="btn btn-green btn-sm">Nút chính</span>
        <span className="btn btn-ghost btn-sm">Nút phụ</span>
        <span className="badge badge-blue">Nhãn</span>
        <span className="progress" style={{ width: 120, height: 10 }}><span className="progress-fill progress-green" style={{ display: 'block', width: '60%' }} /></span>
      </div>
    </div>
  );
}

/** Nút bảng màu ở chân thanh bên: mở nhanh bộ chọn màu. */
export function ThemeQuickPicker() {
  const [color, setColor] = useThemeColor();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'static' }}>
      <button type="button" className={`iconbtn ${open ? 'iconbtn-on' : ''}`} aria-label="Đổi màu giao diện" title="Đổi màu giao diện"
        aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="theme-dot" style={{ width: 20, height: 20, background: 'var(--brand)' }} />
      </button>
      {open && (
        <div className="card theme-pop" role="dialog" aria-label="Màu giao diện">
          <strong>Màu giao diện</strong>
          <Swatches color={color} onPick={setColor} labels={false} />
        </div>
      )}
    </div>
  );
}
