// Bộ icon nét (stroke) dùng chung. Màu theo currentColor.
import type { CSSProperties } from 'react';

const P: Record<string, string> = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  video: 'M3 5h18v14H3zM10 9l5 3-5 3z',
  slide: 'M3 4h18v12H3zM12 16v4M8 20h8',
  book: 'M4 5h6a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H4zM20 5h-6a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h6z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  lock: 'M5 11h14v10H5zM8 11V8a4 4 0 0 1 8 0v3',
  x: 'M6 6l12 12M18 6L6 18',
  chevronLeft: 'M15 5l-7 7 7 7',
  chevronRight: 'M9 5l7 7-7 7',
  chevronDown: 'M5 9l7 7 7-7',
  plus: 'M12 5v14M5 12h14',
  history: 'M4 12a8 8 0 1 0 3-6.2M4 4v4h4M12 8v4l3 2',
  send: 'M5 12h14M13 6l6 6-6 6',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1-4 4.5-6 8-6s7 2 8 6',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21c.8-3.5 3.6-5.5 7-5.5s6.2 2 7 5.5M16 3.5a4 4 0 0 1 0 7.5M18 15.5c2 .8 3.4 2.8 4 5.5',
  clock: 'M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 9v4l2 2M9 2h6',
  rewind: 'M4 12a8 8 0 1 0 3-6.2M4 4v4h4',
  captions: 'M3 5h18v14H3zM10 10.5a2 2 0 1 0 0 3M17 10.5a2 2 0 1 0 0 3',
  fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  zoomIn: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM8 11h6M11 8v6M20 20l-4-4',
  zoomOut: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM8 11h6M20 20l-4-4',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16z',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  arrowDown: 'M12 5v14M6 13l6 6 6-6',
  doc: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z',
  note: 'M5 4h14v16l-7-4-7 4z',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  scroll: 'M7 3h10v18H7zM7 9h10M7 15h10',
  page: 'M5 4h14v16H5z',
  question: 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  wand: 'M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8l1.4 1.4M17.8 6.2l1.4-1.4M3 21l9-9M12.2 6.2l-1.4-1.4',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  theater: 'M2 7h20v10H2zM6 7v10M18 7v10',
  fullscreenExit: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.9 8.3 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  key: 'M7.5 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM11 12h10M18 12v3M21 12v2',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  school: 'M2 9l10-5 10 5-10 5zM6 11v5c0 1.5 2.7 3 6 3s6-1.5 6-3v-5M22 9v6',
};

const FILLED: Record<string, string> = {
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
  star: 'M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2 6.3 20.3l1.2-6.4L2.8 9.5l6.4-.8z',
  sparkle: 'M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8zM19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9z',
  trophy: 'M7 3h10v6a5 5 0 0 1-10 0zM5 4H2v2a4 4 0 0 0 5 3.9M19 4h3v2a4 4 0 0 1-5 3.9M10 14h4v4h3v3H7v-3h3z',
};

export type IconName = keyof typeof P | keyof typeof FILLED;

export function Icon({ name, size = 22, stroke = 2.3, style, className, label }: {
  name: IconName; size?: number; stroke?: number; style?: CSSProperties; className?: string; label?: string;
}) {
  const filled = FILLED[name];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} className={className}
      fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'} strokeWidth={stroke}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} aria-label={label} role={label ? 'img' : undefined}>
      <path d={filled || P[name]} />
    </svg>
  );
}

export function Flame({ size = 24, dim = false }: { size?: number; dim?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3 0-4-1-6 1-9z" fill={dim ? '#D6D6D6' : '#FF9F1C'} />
      <path d="M12 13c1 2 3 3 3 5a3 3 0 0 1-6 0c0-1.5 1-2.5 3-5z" fill={dim ? '#EDEDED' : '#FFD166'} />
    </svg>
  );
}

export function Gem({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2l8 6-8 14L4 8z" fill="#1EA7F0" /><path d="M4 8h16L12 22z" fill="#1683C9" /><path d="M8.5 8L12 2l3.5 6z" fill="#8FD6FF" />
    </svg>
  );
}

export function Bolt({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M13 2L4 14h7l-1 8 9-12h-7z" fill="#FFC93C" stroke="#E0A800" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
