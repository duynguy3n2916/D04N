import { useId } from 'react';

// Linh vật "Mầm" — mầm cây nhô ra từ chậu nâu (tự thiết kế).
export type MascotMood = 'happy' | 'wave' | 'think' | 'sad' | 'celebrate';

const INK = '#25313B';
// Bảng xanh lấy đúng theo token trong styles.css để logo khớp màu web.
const GREEN = '#34A30F'; // --green
const GREEN_DARK = '#237008'; // --green-dark
const GREEN_TEXT = '#2B7A0B'; // --green-text
const GREEN_LINE = '#7BD34B'; // --green-line
const GREEN_LEAF = '#5CC02A'; // --green-leaf

function Eyes({ mood }: { mood: MascotMood }) {
  if (mood === 'celebrate') {
    return (
      <>
        <path d="M43 56q6-8.25 12 0" fill="none" stroke={INK} strokeWidth="3.2" strokeLinecap="round" />
        <path d="M65 56q6-8.25 12 0" fill="none" stroke={INK} strokeWidth="3.2" strokeLinecap="round" />
      </>
    );
  }
  const [dx, dy] = mood === 'think' ? [1.9, -2.6] : [0.6, 0.75];
  const eye = (x: number) => (
    <g key={x}>
      <ellipse cx={x} cy={54} rx={7.5} ry={8.1} fill="#fff" />
      <circle cx={x + dx} cy={54 + dy} r={4.65} fill={INK} />
      <circle cx={x + dx + 1.65} cy={54 + dy - 1.9} r={1.65} fill="#fff" />
      <circle cx={x + dx - 1.65} cy={54 + dy + 1.65} r={0.75} fill="#fff" />
    </g>
  );
  return (
    <>
      {eye(49)}{eye(71)}
      {mood === 'sad' && <path d="M41.5 43.9l10.5-3.4M78.5 43.9l-10.5-3.4" stroke={GREEN_DARK} strokeWidth="2.6" strokeLinecap="round" />}
      {mood === 'think' && <path d="M43 42.8q6-3.8 12 0" fill="none" stroke={GREEN_DARK} strokeWidth="2.6" strokeLinecap="round" />}
    </>
  );
}

function Mouth({ mood }: { mood: MascotMood }) {
  switch (mood) {
    case 'sad':
      return <path d="M54.9 69.6q5.1-5.1 10.2 0" fill="none" stroke={INK} strokeWidth="3" strokeLinecap="round" />;
    case 'think':
      return <ellipse cx="62.6" cy="68" rx="2.6" ry="2.2" fill={INK} />;
    case 'celebrate':
      return (
        <>
          <path d="M52.4 65.3h15.3q0 10.2-7.65 10.2q-7.65 0-7.65-10.2z" fill={INK} />
          <path d="M56.2 73q3.8-3.4 7.6 0q-3.8 3-7.6 0z" fill="#FF6B6B" />
        </>
      );
    default:
      return (
        <>
          <path d="M53.2 66.2q6.8 7.7 13.6 0q-6.8 3.4-13.6 0z" fill={INK} />
          <path d="M57 69.8q3-2.2 6 0q-3 1.2-6 0z" fill="#FF6B6B" />
        </>
      );
  }
}

const CONFETTI: [number, number, string, number][] = [[14, 26, '#FF6B6B', 20], [104, 22, '#1E9BF0', -25], [10, 60, '#FFC233', 45],
  [110, 58, '#8B5CF6', 10], [22, 12, '#20C9A6', -30], [98, 8, '#FFC233', 60]];

function Extras({ mood }: { mood: MascotMood }) {
  if (mood === 'wave') {
    return (
      <>
        <path d="M88 70q12-6 14-22" fill="none" stroke={GREEN_TEXT} strokeWidth="7" strokeLinecap="round" />
        <circle cx="102" cy="46" r="5.5" fill={GREEN_LEAF} />
        <path d="M110 36q4 4 2 10M115 40q3 3 1 7" fill="none" stroke="#FFC233" strokeWidth="2.4" strokeLinecap="round" />
      </>
    );
  }
  if (mood === 'think') {
    return (
      <>
        <circle cx="96" cy="36" r="3" fill="#B9A6F7" />
        <circle cx="103" cy="27" r="4.5" fill="#B9A6F7" />
      </>
    );
  }
  if (mood === 'sad') return <path d="M36 58q-3 5 0 7q3-2 0-7z" fill="#7CC7FF" />;
  if (mood === 'celebrate') {
    return (
      <>
        {CONFETTI.map(([x, y, c, a]) => <rect key={`${x}-${y}`} x={x} y={y} width="6" height="3.4" rx="1.4" fill={c} transform={`rotate(${a} ${x + 3} ${y + 1.7})`} />)}
        <path d="M26 70q-10-6-10-20M94 70q10-6 10-20" fill="none" stroke={GREEN_TEXT} strokeWidth="7" strokeLinecap="round" />
      </>
    );
  }
  return null;
}

export function Mascot({ size = 120, mood = 'happy', label }: { size?: number; mood?: MascotMood; label?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <defs>
        <radialGradient id={`${id}b`} cx=".38" cy=".3" r=".8">
          <stop offset="0" stopColor={GREEN_LINE} /><stop offset=".6" stopColor={GREEN} /><stop offset="1" stopColor={GREEN_DARK} />
        </radialGradient>
        <linearGradient id={`${id}p`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#B98258" /><stop offset="1" stopColor="#8A5733" />
        </linearGradient>
      </defs>
      <ellipse cx="60" cy="115" rx="28" ry="3.6" fill="#000" opacity=".08" />
      {/* lá */}
      <g className="m-leaf">
        <path d="M60 30v-8" stroke={GREEN_TEXT} strokeWidth="3.6" strokeLinecap="round" />
        <path d="M60 23C54 8 36 6 30 15c8 10 22 12 30 8z" fill={GREEN_LINE} />
        <path d="M57 21c-7-5-15-7-23-6" fill="none" stroke={GREEN_TEXT} strokeWidth="1.6" strokeLinecap="round" opacity=".55" />
        <path d="M61 22C67 7 85 5 91 14c-8 10-22 12-30 8z" fill={GREEN_LEAF} />
        <path d="M64 20c7-5 15-6 23-5" fill="none" stroke={GREEN_TEXT} strokeWidth="1.6" strokeLinecap="round" opacity=".55" />
      </g>
      {/* đầu */}
      <circle cx="60" cy="58" r="30" fill={`url(#${id}b)`} />
      <ellipse cx="45" cy="42" rx="7" ry="4" fill="#fff" opacity=".35" transform="rotate(-30 45 42)" />
      <ellipse cx="40" cy="64" rx="5" ry="3.1" fill="#FF8FA3" opacity=".75" />
      <ellipse cx="80" cy="64" rx="5" ry="3.1" fill="#FF8FA3" opacity=".75" />
      <g className="m-eyes"><Eyes mood={mood} /></g>
      <Mouth mood={mood} />
      {/* chậu nâu viền vàng */}
      <path d="M32 80h56l-7 33H39z" fill={`url(#${id}p)`} />
      <rect x="28" y="76" width="64" height="11" rx="5" fill="#9E6A43" />
      <rect x="34" y="92" width="52" height="6" rx="3" fill="#FFC233" />
      <circle cx="47" cy="105" r="2" fill="#fff" opacity=".5" />
      <circle cx="60" cy="106" r="2" fill="#fff" opacity=".5" />
      <circle cx="73" cy="105" r="2" fill="#fff" opacity=".5" />
      <Extras mood={mood} />
    </svg>
  );
}

export function Logo({ size = 34 }: { size?: number }) {
  return (
    <span className="logo">
      <Mascot size={size} />
      <span className="logo-text">mầm<i className="logo-swoosh" aria-hidden="true" /></span>
    </span>
  );
}
