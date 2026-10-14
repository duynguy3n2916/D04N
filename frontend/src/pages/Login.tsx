import { useEffect, useState, type FormEvent } from 'react';
import { Logo, Mascot } from '../components/Mascot';
import { PasswordInput, PasswordRules, passwordOk } from '../components/PasswordInput';
import { Button, ErrorBox, Field } from '../components/ui';
import { api, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import { navigate } from '../lib/router';

interface AuthConfig { allow_registration: boolean; login_hint: string | null; password_reset_email?: boolean }

const TITLE = { login: 'Đăng nhập', register: 'Tạo tài khoản học sinh', forgot: 'Quên mật khẩu' };

export function Login() {
  const { login, register, notice } = useAuth();
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>(() => (location.hash.includes('register') ? 'register' : 'login'));
  const [f, setF] = useState({ username: '', password: '', confirm: '', display_name: '', email: '', class_code: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => { api<AuthConfig>('/ai/auth/config').then(setCfg).catch(() => setCfg({ allow_registration: false, login_hint: null })); }, []);
  useEffect(() => { setError(null); setSent(null); }, [mode]);

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const uname = f.username.trim().toLowerCase();
  const canRegister = /^[a-z0-9][a-z0-9._-]{2,63}$/.test(uname) && passwordOk(f.password, uname) && f.password === f.confirm && !!f.display_name.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (mode === 'forgot') {
        const r = await api<{ message: string }>('/ai/auth/forgot-password', { json: { identifier: f.username.trim() } });
        setSent(r.message);
      } else if (mode === 'login') await login(f.username.trim(), f.password);
      else await register({ username: uname, password: f.password, display_name: f.display_name.trim(),
        email: f.email.trim() || undefined, class_code: f.class_code.trim() || undefined });
    } catch (err) {
      setError(errorText(err));
    } finally { setBusy(false); }
  };

  return (
    <div className="login-page">
      <header className="login-top">
        <Logo size={38} />
        <span className="muted" style={{ fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.6px', fontSize: 14 }}>Trợ lý AI học tập</span>
      </header>
      <main className="login-main">
        <div className="login-hero">
          <Mascot size={240} mood="wave" label="Linh vật Mầm vẫy tay" />
          <h1>Học mỗi ngày, có <span className="grad-word">AI</span> kèm cặp từng bước</h1>
          <p>Xem bài giảng, trả lời câu hỏi ngay trong video và hỏi Tutor bất cứ lúc nào.</p>
        </div>

        <form className="login-form" onSubmit={submit} aria-label={TITLE[mode]}>
          <h2 style={{ fontSize: 28 }}>{TITLE[mode]}</h2>
          {notice && mode === 'login' && <div className="notice">{notice}</div>}

          {mode === 'forgot' ? (
            <>
              <p className="muted" style={{ fontWeight: 700 }}>Nhập tên đăng nhập hoặc email của tài khoản. Nếu tài khoản có email, hệ thống gửi link đặt mật khẩu mới.</p>
              <Field label="Tên đăng nhập hoặc email">
                <input value={f.username} onChange={set('username')} required autoFocus autoComplete="username" />
              </Field>
              {sent && <div className="notice" role="status">{sent}</div>}
            </>
          ) : mode === 'login' ? (
            <>
              <Field label="Tên đăng nhập hoặc email">
                <input value={f.username} onChange={set('username')} required autoFocus autoComplete="username" />
              </Field>
              <Field label="Mật khẩu">
                <PasswordInput value={f.password} onChange={set('password')} required autoComplete="current-password" />
              </Field>
            </>
          ) : (
            <>
              <Field label="Họ và tên"><input value={f.display_name} onChange={set('display_name')} required autoFocus autoComplete="name" /></Field>
              <Field label="Tên đăng nhập" hint="Chữ thường không dấu, số, dấu chấm hoặc gạch ngang. Ví dụ: an.nguyen">
                <input value={f.username} onChange={set('username')} required autoComplete="username" autoCapitalize="none" spellCheck={false} />
              </Field>
              <Field label="Mật khẩu">
                <PasswordInput value={f.password} onChange={set('password')} required autoComplete="new-password" />
              </Field>
              {f.password && <PasswordRules value={f.password} username={uname} />}
              <Field label="Nhập lại mật khẩu">
                <PasswordInput value={f.confirm} onChange={set('confirm')} required autoComplete="new-password" />
              </Field>
              {f.confirm && f.confirm !== f.password && <span className="small" style={{ color: 'var(--red-text)', fontWeight: 800 }}>Hai mật khẩu chưa khớp.</span>}
              <div className="form-grid">
                <Field label="Email (tùy chọn)"><input type="email" value={f.email} onChange={set('email')} autoComplete="email" /></Field>
                <Field label="Mã vào lớp (tùy chọn)" hint="Giáo viên cung cấp">
                  <input value={f.class_code} onChange={set('class_code')} maxLength={16} style={{ textTransform: 'uppercase' }} />
                </Field>
              </div>
            </>
          )}

          {error && <ErrorBox message={error} />}
          <Button type="submit" size="lg" loading={busy} disabled={(mode === 'register' && !canRegister) || (mode === 'forgot' && !f.username.trim())}>
            {mode === 'login' ? 'Đăng nhập' : mode === 'forgot' ? (sent ? 'Gửi lại link' : 'Gửi link đặt lại mật khẩu') : 'Tạo tài khoản'}
          </Button>

          {cfg?.allow_registration && mode !== 'forgot' && (
            <p className="muted" style={{ textAlign: 'center', fontWeight: 700 }}>
              {mode === 'login' ? 'Chưa có tài khoản? ' : 'Đã có tài khoản? '}
              <button type="button" className="linkbtn" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
                {mode === 'login' ? 'Tạo tài khoản học sinh' : 'Đăng nhập'}
              </button>
            </p>
          )}
          {mode === 'login' && (cfg?.password_reset_email ? (
            <p className="muted small" style={{ textAlign: 'center', fontWeight: 700 }}>
              <button type="button" className="linkbtn" onClick={() => setMode('forgot')}>Quên mật khẩu?</button>
            </p>
          ) : (
            <p className="muted small" style={{ textAlign: 'center' }}>Quên mật khẩu? Nhờ giáo viên hoặc quản trị viên cấp lại mật khẩu tạm.</p>
          ))}
          {mode === 'forgot' && (
            <p className="muted small" style={{ textAlign: 'center', fontWeight: 700 }}>
              <button type="button" className="linkbtn" onClick={() => setMode('login')}>Quay lại đăng nhập</button>
            </p>
          )}
          {cfg?.login_hint && <p className="hint-box small">{cfg.login_hint}</p>}
        </form>
      </main>
    </div>
  );
}

/** Bắt buộc đổi mật khẩu (tài khoản mới được cấp hoặc vừa được cấp lại mật khẩu tạm). */
export function ForceChangePassword() {
  const { user, changePassword, logout } = useAuth();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = !!cur && passwordOk(next, user?.user_id) && next === confirm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await changePassword(cur, next); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  return (
    <div className="login-page">
      <header className="login-top"><Logo size={38} /></header>
      <main className="login-main">
        <form className="login-form card" onSubmit={submit} aria-label="Đổi mật khẩu" style={{ padding: '26px 28px' }}>
          <Mascot size={90} mood="think" />
          <h2 style={{ fontSize: 26 }}>Đặt mật khẩu của riêng bạn</h2>
          <p className="muted" style={{ fontWeight: 700 }}>
            Xin chào {user?.name || user?.user_id}! Bạn đang dùng mật khẩu tạm do giáo viên cấp. Hãy đổi sang mật khẩu mới để tiếp tục.
          </p>
          <Field label="Mật khẩu tạm"><PasswordInput value={cur} onChange={(e) => setCur(e.target.value)} required autoFocus autoComplete="current-password" /></Field>
          <Field label="Mật khẩu mới"><PasswordInput value={next} onChange={(e) => setNext(e.target.value)} required autoComplete="new-password" /></Field>
          {next && <PasswordRules value={next} username={user?.user_id} />}
          <Field label="Nhập lại mật khẩu mới"><PasswordInput value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" /></Field>
          {confirm && confirm !== next && <span className="small" style={{ color: 'var(--red-text)', fontWeight: 800 }}>Hai mật khẩu chưa khớp.</span>}
          {error && <ErrorBox message={error} />}
          <Button type="submit" size="lg" loading={busy} disabled={!ok}>Lưu mật khẩu mới</Button>
          <button type="button" className="linkbtn" onClick={() => logout()}>Đăng xuất</button>
        </form>
      </main>
    </div>
  );
}

/** Đặt mật khẩu mới từ link trong email (#/reset-password?token=...). Thành công thì đăng nhập luôn. */
export function ResetPassword() {
  const { resetPassword } = useAuth();
  const token = new URLSearchParams(window.location.hash.split('?')[1] || '').get('token') || '';
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = !!token && passwordOk(next) && next === confirm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await resetPassword(token, next); navigate('/', true); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  return (
    <div className="login-page">
      <header className="login-top"><Logo size={38} /></header>
      <main className="login-main">
        <form className="login-form card" onSubmit={submit} aria-label="Đặt mật khẩu mới" style={{ padding: '26px 28px' }}>
          <Mascot size={90} mood="think" />
          <h2 style={{ fontSize: 26 }}>Đặt mật khẩu mới</h2>
          {!token && <ErrorBox message="Link không hợp lệ. Hãy mở đúng link trong email hoặc yêu cầu link mới." />}
          <Field label="Mật khẩu mới"><PasswordInput value={next} onChange={(e) => setNext(e.target.value)} required autoFocus autoComplete="new-password" /></Field>
          {next && <PasswordRules value={next} />}
          <Field label="Nhập lại mật khẩu mới"><PasswordInput value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" /></Field>
          {confirm && confirm !== next && <span className="small" style={{ color: 'var(--red-text)', fontWeight: 800 }}>Hai mật khẩu chưa khớp.</span>}
          {error && <ErrorBox message={error} />}
          <Button type="submit" size="lg" loading={busy} disabled={!ok}>Lưu mật khẩu mới</Button>
          <button type="button" className="linkbtn" onClick={() => navigate('/login', true)}>Quay lại đăng nhập</button>
        </form>
      </main>
    </div>
  );
}
