// Logo "mầm": mầm hai lá lệch nhau, màu theo màu chủ đạo (biến CSS do lib/theme.ts đặt).

/** Biểu tượng logo: mầm hai lá lệch nhau, màu theo màu chủ đạo. */
export function LogoMark({ size = 34 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M32 56V30" style={{ stroke: 'var(--brand)' }} strokeWidth="6" strokeLinecap="round" fill="none" />
      <path d="M32 32C32 18 22 10 8 10c0 14 10 22 24 22z" style={{ fill: 'var(--brand)' }} />
      <path d="M32 28c0-12 9-19 22-19 0 12-9 19-22 19z" style={{ fill: 'var(--brand-mid)' }} />
    </svg>
  );
}

export function Logo({ size = 34 }: { size?: number }) {
  return (
    <span className="logo">
      <LogoMark size={size} />
      <span className="logo-text">mầm</span>
    </span>
  );
}
