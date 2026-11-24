// Màu chủ đạo của giao diện: mặc định Đỏ đô (DEFAULT_THEME), người dùng đổi được trong Cài đặt (lưu ở trình duyệt).
// Mọi sắc độ khác (nền, viền, chữ nhấn...) được suy ra từ màu đó và áp lên :root bằng biến CSS mà styles/theme.css dùng.
import { storage } from './api';


export type ThemePreset = { id: string; name: string; color: string };

export const THEME_PRESETS: ThemePreset[] = [
  { id: 'do-do', name: 'Đỏ đô', color: '#8B1E2D' },
  { id: 'cam-dat', name: 'Cam đất', color: '#C2410C' },
  { id: 'xanh-mam', name: 'Xanh mầm', color: '#2B8A3E' },
  { id: 'xanh-ngoc', name: 'Xanh ngọc', color: '#0B7285' },
  { id: 'xanh-duong', name: 'Xanh dương', color: '#3B5BDB' },
  { id: 'tim', name: 'Tím', color: '#6741D9' },
];
export const DEFAULT_THEME = THEME_PRESETS[0].color;

type RGB = [number, number, number];
const hexToRgb = (hex: string): RGB => {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)) as RGB;
};
const rgbToHex = (c: RGB) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
/** Trộn màu a với b theo tỉ lệ t (0 = a, 1 = b). */
const mix = (a: string, b: string, t: number) => { const x = hexToRgb(a), y = hexToRgb(b); return rgbToHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as RGB); };
const luminance = (hex: string) => {
  const [r, g, b] = hexToRgb(hex).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrastWithWhite = (hex: string) => 1.05 / (luminance(hex) + 0.05);
const hue = (hex: string) => {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};

export const isValidColor = (v: string) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);

/** Từ một màu, suy ra toàn bộ biến màu. Màu quá sáng được làm tối dần để chữ trắng trên nút vẫn đọc rõ (tương phản ≥ 4.5). */
export function themeVars(input: string): Record<string, string> {
  let brand = isValidColor(input) ? rgbToHex(hexToRgb(input)) : DEFAULT_THEME;
  for (let i = 0; i < 20 && contrastWithWhite(brand) < 4.5; i++) brand = mix(brand, '#000000', 0.08);
  const h = hue(brand);
  const reddish = h < 18 || h > 330;
  const vars: Record<string, string> = {
    '--brand': brand,
    '--brand-hover': mix(brand, '#000000', 0.1),
    '--brand-strong': mix(brand, '#000000', 0.22),
    '--brand-mid': mix(brand, '#FFFFFF', 0.35),
    '--brand-line': mix(brand, '#FFFFFF', 0.62),
    '--brand-tint': mix(brand, '#FFFFFF', 0.82),
    '--brand-soft': mix(brand, '#FFFFFF', 0.91),
    '--t-bg': mix('#FFFFFF', brand, 0.035),
    '--t-wash': mix('#FFFFFF', brand, 0.06),
    '--t-ink': mix('#17120F', brand, 0.1),
    '--t-muted': mix('#6A6260', brand, 0.12),
    '--t-line': mix('#E7E2DF', brand, 0.08),
  };
  // Màu báo sai/lỗi: nếu màu chủ đạo đã là đỏ thì dùng cam đất cho lỗi để không lẫn với nút chính.
  if (reddish) Object.assign(vars, { '--red': '#B45309', '--red-dark': '#8A3F06', '--red-soft': '#FDEBD3', '--red-line': '#F5C38B', '--red-text': '#9A4507' });
  else Object.assign(vars, { '--red': '#D03A40', '--red-dark': '#9E2730', '--red-soft': '#FDE3E2', '--red-line': '#F2A3A0', '--red-text': '#B3261E' });
  return vars;
}

export function applyTheme(color: string) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(themeVars(color))) root.style.setProperty(k, v);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', themeVars(color)['--brand']);
}

const THEME_KEY = 'mam.theme';

/** Màu người dùng đã chọn (hoặc mặc định). */
export function savedTheme(): string {
  const v = storage.get(THEME_KEY);
  return v && isValidColor(v) ? v : DEFAULT_THEME;
}

/** Đổi màu chủ đạo ngay lập tức và nhớ lựa chọn. */
export function setTheme(color: string) {
  if (!isValidColor(color)) return;
  storage.set(THEME_KEY, color.toUpperCase() === DEFAULT_THEME.toUpperCase() ? null : color);
  applyTheme(color);
}
