// Linh vật "Mầm" — mầm cây tròn màu xanh (tự thiết kế).
export function Mascot({ size = 120, mood = 'happy', label }: { size?: number; mood?: 'happy' | 'wave' | 'think' | 'sad'; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d="M58 34C46 12 24 14 20 28c14 8 28 10 38 6z" fill="#7BD34B" />
      <path d="M62 34c12-22 34-20 38-6-14 8-28 10-38 6z" fill="#5CC02A" />
      <circle cx="60" cy="74" r="40" fill="#34A30F" />
      <ellipse cx="60" cy="90" rx="24" ry="16" fill="#5CC02A" />
      <circle cx="46" cy="68" r="11" fill="#fff" /><circle cx="74" cy="68" r="11" fill="#fff" />
      {mood === 'think' ? (
        <><circle cx="50" cy="65" r="5" fill="#2B2B2B" /><circle cx="78" cy="65" r="5" fill="#2B2B2B" /></>
      ) : (
        <><circle cx="48" cy="70" r="5" fill="#2B2B2B" /><circle cx="76" cy="70" r="5" fill="#2B2B2B" /></>
      )}
      <circle cx="36" cy="82" r="5" fill="#FF9EA8" opacity=".7" /><circle cx="84" cy="82" r="5" fill="#FF9EA8" opacity=".7" />
      {mood === 'sad' ? (
        <path d="M52 92q8-6 16 0" stroke="#1D5E06" strokeWidth="4" fill="none" strokeLinecap="round" />
      ) : mood === 'wave' ? (
        <path d="M50 84q10 10 20 0" stroke="#1D5E06" strokeWidth="4" fill="#1D5E06" strokeLinecap="round" />
      ) : (
        <path d="M52 86q8 7 16 0" stroke="#1D5E06" strokeWidth="4" fill="none" strokeLinecap="round" />
      )}
      {mood === 'wave' && <path d="M98 62c8-6 12-14 10-20" stroke="#34A30F" strokeWidth="9" fill="none" strokeLinecap="round" />}
    </svg>
  );
}

export function Logo({ size = 34 }: { size?: number }) {
  return (
    <span className="logo">
      <Mascot size={size} />
      <span className="logo-text">mầm</span>
    </span>
  );
}
