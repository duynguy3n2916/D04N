import { useState, type InputHTMLAttributes } from 'react';
import { Icon } from './Icon';

/** Ô mật khẩu có nút hiện/ẩn. */
export function PasswordInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const [show, setShow] = useState(false);
  return (
    <span className="pw-wrap">
      <input {...props} type={show ? 'text' : 'password'} />
      <button type="button" className="pw-toggle" onClick={() => setShow((s) => !s)} aria-label={show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'} title={show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}>
        <Icon name={show ? 'eyeOff' : 'eye'} size={20} />
      </button>
    </span>
  );
}

/** Gợi ý độ mạnh: đủ 8 ký tự, có chữ, có số. */
export function PasswordRules({ value, username }: { value: string; username?: string }) {
  const rules = [
    { ok: value.length >= 8, t: 'Ít nhất 8 ký tự' },
    { ok: /[A-Za-zÀ-ỹ]/.test(value) && /\d/.test(value), t: 'Có cả chữ và số' },
    { ok: !username || value.toLowerCase() !== username.toLowerCase(), t: 'Khác tên đăng nhập' },
  ];
  return (
    <ul className="pw-rules" aria-label="Yêu cầu mật khẩu">
      {rules.map((r) => (
        <li key={r.t} className={r.ok ? 'ok' : ''}><Icon name={r.ok ? 'check' : 'x'} size={14} stroke={3} />{r.t}</li>
      ))}
    </ul>
  );
}

export const passwordOk = (v: string, username?: string) =>
  v.length >= 8 && /[A-Za-zÀ-ỹ]/.test(v) && /\d/.test(v) && (!username || v.toLowerCase() !== username.toLowerCase());
