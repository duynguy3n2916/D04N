import { useEffect, useState, type CSSProperties } from 'react';
import { storage, type TranscriptSegment } from '../lib/api';

const SIZES = [75, 100, 125, 150, 200];
const COLORS = ['#ffffff', '#ffeb3b', '#00ffff'];
const OPACITIES = [0, 0.5, 0.75, 1];
const DEFAULTS = { size: 100, color: '#ffffff', opacity: 0.75 };
type Appearance = typeof DEFAULTS;

function savedAppearance(): Appearance {
  try {
    const value = JSON.parse(storage.get('mam.captionStyle') || '{}');
    return {
      size: SIZES.includes(value.size) ? value.size : DEFAULTS.size,
      color: COLORS.includes(value.color) ? value.color : DEFAULTS.color,
      opacity: OPACITIES.includes(value.opacity) ? value.opacity : DEFAULTS.opacity,
    };
  } catch { return DEFAULTS; }
}

export function useVideoCaptions() {
  const [enabled, setEnabled] = useState(storage.get('mam.captions') !== '0');
  const [appearance, setAppearance] = useState(savedAppearance);
  useEffect(() => { storage.set('mam.captions', enabled ? '1' : '0'); }, [enabled]);
  useEffect(() => { storage.set('mam.captionStyle', JSON.stringify(appearance)); }, [appearance]);
  return { enabled, setEnabled, appearance, setAppearance };
}

export type CaptionPreferences = ReturnType<typeof useVideoCaptions>;

export function activeCaption(segments: TranscriptSegment[], time: number) {
  return segments.find((s) => time >= s.start_time && time < s.end_time);
}

export function VideoCaption({ text, preferences }: { text?: string; preferences: CaptionPreferences }) {
  if (!preferences.enabled || !text) return null;
  const { size, color, opacity } = preferences.appearance;
  const style = { '--caption-scale': size / 100, color, background: `rgba(0,0,0,${opacity})` } as CSSProperties;
  return <div className="player-caption" style={style}>{text}</div>;
}

export function CaptionSettings({ preferences, available }: { preferences: CaptionPreferences; available: boolean }) {
  const { enabled, setEnabled, appearance, setAppearance } = preferences;
  return (
    <fieldset className="caption-settings" onKeyDown={(e) => e.stopPropagation()}>
      <legend>Phụ đề</legend>
      {!available && <p className="small muted">Video chưa có phụ đề. Nhập .srt/.vtt hoặc phiên âm để hiển thị.</p>}
      <label className="menu-row"><span>Hiển thị phụ đề</span>
        <input type="checkbox" checked={enabled} disabled={!available} onChange={(e) => setEnabled(e.target.checked)} />
      </label>
      <label className="menu-row"><span>Cỡ chữ</span>
        <select value={appearance.size} onChange={(e) => setAppearance({ ...appearance, size: Number(e.target.value) })}>
          {SIZES.map((size) => <option key={size} value={size}>{size}%</option>)}
        </select>
      </label>
      <label className="menu-row"><span>Màu chữ</span>
        <select value={appearance.color} onChange={(e) => setAppearance({ ...appearance, color: e.target.value })}>
          <option value="#ffffff">Trắng</option><option value="#ffeb3b">Vàng</option><option value="#00ffff">Xanh lam</option>
        </select>
      </label>
      <label className="menu-row"><span>Độ đậm nền</span>
        <select value={appearance.opacity} onChange={(e) => setAppearance({ ...appearance, opacity: Number(e.target.value) })}>
          {OPACITIES.map((opacity) => <option key={opacity} value={opacity}>{opacity * 100}%</option>)}
        </select>
      </label>
      <div className="caption-preview"><VideoCaption text="Ví dụ phụ đề trong video" preferences={{ ...preferences, enabled: true }} /></div>
      <button type="button" className="pill" onClick={() => setAppearance(DEFAULTS)}>Khôi phục mặc định</button>
    </fieldset>
  );
}
