import { useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { PasswordInput, PasswordRules, passwordOk } from '../components/PasswordInput';
import { Badge, Button, ErrorBox, Field, useToast } from '../components/ui';
import { api, errorText, type ClassInfo, type User } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync } from '../lib/hooks';

/** Phần "Tài khoản" trong trang Hồ sơ: thông tin cá nhân, lớp học, đổi mật khẩu, đăng xuất mọi thiết bị. */
export function AccountSection() {
  const { user, setUser, changePassword, logout } = useAuth();
  const toast = useToast();
  const me = useAsync((s) => api<User & { classes: ClassInfo[] }>('/ai/auth/me', { signal: s }), []);

  // thông tin
  const [info, setInfo] = useState<{ display_name: string; email: string } | null>(null);
  const cur = info ?? { display_name: me.data?.display_name || '', email: me.data?.email || '' };
  const [savingInfo, setSavingInfo] = useState(false);
  const saveInfo = async (e: FormEvent) => {
    e.preventDefault(); setSavingInfo(true);
    try {
      const u = await api<User>('/ai/auth/me', { method: 'PATCH', json: cur });
      setUser({ ...user!, ...u }); setInfo(null); me.reload(); toast('Đã lưu thông tin', 'success');
    } catch (err) { toast(errorText(err), 'error'); } finally { setSavingInfo(false); }
  };

  // lớp
  const [code, setCode] = useState('');
  const [joining, setJoining] = useState(false);
  const join = async (e: FormEvent) => {
    e.preventDefault(); setJoining(true);
    try {
      const r = await api<{ class: ClassInfo; user: User }>('/ai/auth/join-class', { json: { code: code.trim() } });
      setUser({ ...user!, ...r.user }); setCode(''); me.reload(); toast(`Đã vào lớp ${r.class.name}`, 'success');
    } catch (err) { toast(errorText(err), 'error'); } finally { setJoining(false); }
  };
  const leave = async (c: ClassInfo) => {
    if (!window.confirm(`Rời lớp ${c.name}? Bạn sẽ không thấy khóa học của lớp này nữa.`)) return;
    try { const u = await api<User>(`/ai/auth/leave-class/${encodeURIComponent(c.class_id)}`, { method: 'POST' }); setUser({ ...user!, ...u }); me.reload(); }
    catch (err) { toast(errorText(err), 'error'); }
  };

  // mật khẩu
  const [pw, setPw] = useState({ cur: '', next: '', confirm: '' });
  const [pwBusy, setPwBusy] = useState(false);
  const [pwErr, setPwErr] = useState<string | null>(null);
  const pwOk = !!pw.cur && passwordOk(pw.next, user?.user_id) && pw.next === pw.confirm;
  const savePw = async (e: FormEvent) => {
    e.preventDefault(); setPwBusy(true); setPwErr(null);
    try { await changePassword(pw.cur, pw.next); setPw({ cur: '', next: '', confirm: '' }); toast('Đã đổi mật khẩu. Các thiết bị khác đã bị đăng xuất.', 'success'); }
    catch (err) { setPwErr(errorText(err)); } finally { setPwBusy(false); }
  };

  const logoutAll = async () => {
    if (!window.confirm('Đăng xuất khỏi mọi thiết bị, kể cả thiết bị này?')) return;
    try { await api('/ai/auth/logout-all', { method: 'POST' }); logout('Bạn đã đăng xuất khỏi mọi thiết bị.'); }
    catch (err) { toast(errorText(err), 'error'); }
  };

  const dirty = info !== null && (info.display_name !== (me.data?.display_name || '') || info.email !== (me.data?.email || ''));

  return (
    <section className="col" style={{ gap: 20 }} aria-label="Tài khoản">
      <h2 style={{ fontSize: 22, marginTop: 8 }}>Tài khoản</h2>
      {me.error && <ErrorBox message={me.error} onRetry={me.reload} />}

      <form className="card col" style={{ gap: 12 }} onSubmit={saveInfo}>
        <div className="card-title" style={{ marginBottom: 0 }}><h2>Thông tin</h2><Badge tone="blue">{user?.user_id}</Badge></div>
        <div className="form-grid">
          <Field label="Họ và tên"><input value={cur.display_name} onChange={(e) => setInfo({ ...cur, display_name: e.target.value })} autoComplete="name" /></Field>
          <Field label="Email" hint="Có thể dùng email để đăng nhập"><input type="email" value={cur.email} onChange={(e) => setInfo({ ...cur, email: e.target.value })} autoComplete="email" /></Field>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}><Button type="submit" loading={savingInfo} disabled={!dirty}>Lưu</Button></div>
      </form>

      <div className="card col" style={{ gap: 12 }}>
        <h2>Lớp học</h2>
        {me.data && !me.data.classes.length && <p className="muted" style={{ fontWeight: 700 }}>Bạn chưa thuộc lớp nào.</p>}
        {me.data?.classes.map((c) => (
          <div key={c.class_id} className="row" style={{ justifyContent: 'space-between' }}>
            <span className="row" style={{ gap: 8 }}><Icon name="school" size={20} /><strong>{c.name}</strong><span className="muted small">{c.class_id}</span>
              {c.join_code && <span className="code-chip" title="Mã vào lớp">{c.join_code}</span>}</span>
            {user?.role === 'student' && <Button size="sm" variant="ghost" onClick={() => leave(c)}>Rời lớp</Button>}
          </div>
        ))}
        {user?.role === 'student' && (
          <form className="row" onSubmit={join} style={{ alignItems: 'flex-end' }}>
            <Field label="Vào lớp bằng mã"><input value={code} onChange={(e) => setCode(e.target.value)} maxLength={16} placeholder="VD: K7P2QM" style={{ textTransform: 'uppercase' }} /></Field>
            <Button type="submit" variant="blue" loading={joining} disabled={code.trim().length < 4}>Vào lớp</Button>
          </form>
        )}
      </div>

      <form className="card col" style={{ gap: 12 }} onSubmit={savePw}>
        <h2><Icon name="key" size={20} /> Đổi mật khẩu</h2>
        <Field label="Mật khẩu hiện tại"><PasswordInput value={pw.cur} onChange={(e) => setPw({ ...pw, cur: e.target.value })} autoComplete="current-password" /></Field>
        <div className="form-grid">
          <Field label="Mật khẩu mới"><PasswordInput value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" /></Field>
          <Field label="Nhập lại mật khẩu mới"><PasswordInput value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} autoComplete="new-password" /></Field>
        </div>
        {pw.next && <PasswordRules value={pw.next} username={user?.user_id} />}
        {pw.confirm && pw.confirm !== pw.next && <span className="small" style={{ color: 'var(--red-text)', fontWeight: 800 }}>Hai mật khẩu chưa khớp.</span>}
        {pwErr && <ErrorBox message={pwErr} />}
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Button type="button" variant="danger-ghost" icon="logout" onClick={logoutAll}>Đăng xuất mọi thiết bị</Button>
          <Button type="submit" loading={pwBusy} disabled={!pwOk}>Đổi mật khẩu</Button>
        </div>
      </form>
    </section>
  );
}
