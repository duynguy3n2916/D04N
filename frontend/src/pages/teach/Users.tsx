import { useRef, useState, type FormEvent } from 'react';
import { PageHeader } from '../../components/AppShell';
import { PasswordInput } from '../../components/PasswordInput';
import { Badge, Button, confirmDialog, Empty, ErrorBox, Field, IconButton, Modal, Spinner, useToast } from '../../components/ui';
import { api, errorText, type ClassInfo, type Role } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Avatar } from '../../components/Social';
import { FilterPills, PillSelect, SearchBox, StatusTag, Toolbar } from '../../components/Manage';
import { useAsync } from '../../lib/hooks';

interface UserRow {
  user_id: string; name: string; display_name: string | null; email: string | null; role: Role; class_ids: string[];
  must_change_password: boolean; has_password: boolean; is_active: boolean; last_login_at: string | null; created_at: string | null;
}
interface ImportResult { created: { row: number; user_id: string; name: string | null; class_ids: string[]; password: string | null; temporary: boolean }[]; errors: { row: number; username: string; error: string }[]; total_rows: number }

const ROLE_LABEL: Record<Role, string> = { student: 'Học sinh', teacher: 'Giáo viên', admin: 'Quản trị' };
const ROLE_TONE: Record<Role, 'gray' | 'blue' | 'yellow'> = { student: 'gray', teacher: 'blue', admin: 'yellow' };

function copy(text: string, toast: (t: string, tone?: any) => void) {
  navigator.clipboard?.writeText(text).then(() => toast('Đã sao chép', 'success'), () => toast('Không sao chép được, hãy bôi đen để chép', 'error'));
}

/** Quản lý người dùng & lớp: admin toàn quyền; giáo viên quản lý học sinh và lớp của mình. */
export function Users() {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const [tab, setTab] = useState<'users' | 'classes'>('users');
  const [classFilter, setClassFilter] = useState('');
  const classes = useAsync((s) => api<ClassInfo[]>('/ai/classes', { signal: s }), [], 'classes');

  const toast = useToast();
  const cur = classes.data?.find((c) => c.class_id === classFilter);
  const rotate = async (c: ClassInfo) => {
    if (!await confirmDialog('Tạo mã vào lớp mới? Mã cũ sẽ không dùng được nữa.')) return;
    try { await api(`/ai/classes/${encodeURIComponent(c.class_id)}`, { method: 'PATCH', json: { rotate_code: true } }); classes.reload(); toast('Đã đổi mã vào lớp', 'success'); }
    catch (e) { toast(errorText(e), 'error'); }
  };

  return (
    <>
      <PageHeader title={admin ? 'Người dùng & lớp' : 'Học sinh & lớp'}
        sub={admin ? 'Tạo tài khoản, phân quyền, cấp lại mật khẩu, quản lý lớp học.' : 'Tạo tài khoản cho học sinh lớp bạn dạy, chia sẻ mã vào lớp, cấp lại mật khẩu khi học sinh quên.'} />
      <div className="class-tabs" role="tablist" aria-label="Chọn lớp">
        <button role="tab" aria-selected={tab === 'users' && !classFilter} className={tab === 'users' && !classFilter ? 'on' : ''} onClick={() => { setTab('users'); setClassFilter(''); }}>{admin ? 'Tất cả tài khoản' : 'Mọi lớp'}</button>
        {classes.data?.filter((c) => c.is_active).map((c) => (
          <button key={c.class_id} role="tab" aria-selected={tab === 'users' && classFilter === c.class_id} className={tab === 'users' && classFilter === c.class_id ? 'on' : ''}
            onClick={() => { setTab('users'); setClassFilter(c.class_id); }}>{c.name || c.class_id}<span className="m-pill-n">{c.students ?? 0}</span></button>
        ))}
        <button role="tab" aria-selected={tab === 'classes'} className={`class-tab-manage ${tab === 'classes' ? 'on' : ''}`} onClick={() => setTab('classes')}>Quản lý lớp ({classes.data?.length ?? 0})</button>
      </div>
      {tab === 'users' && cur && (
        <section className="card class-banner">
          <div className="grow" style={{ minWidth: 0 }}>
            <span className="oc-kicker">{cur.class_id}</span>
            <h2>{cur.name}</h2>
            <p className="muted">{cur.students ?? 0} học sinh · {cur.teachers ?? 0} giáo viên{cur.is_active ? '' : ' · lớp đã đóng'}</p>
          </div>
          <div className="join-code">
            <span className="oc-kicker">Mã vào lớp</span>
            <strong>{cur.join_code}</strong>
            <div className="row" style={{ gap: 6 }}>
              <Button size="sm" icon="copy" onClick={() => copy(cur.join_code || '', toast)}>Sao chép</Button>
              <Button size="sm" variant="ghost" icon="refresh" onClick={() => rotate(cur)}>Đổi mã</Button>
            </div>
          </div>
        </section>
      )}
      {tab === 'users'
        ? <UsersTab classes={classes.data || []} classFilter={classFilter} />
        : <ClassesTab classes={classes} onShowStudents={(c) => { setClassFilter(c); setTab('users'); }} />}
    </>
  );
}

// ---------------------------------------------------------------- Tài khoản

function UsersTab({ classes, classFilter }: { classes: ClassInfo[]; classFilter: string }) {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const toast = useToast();
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const params = new URLSearchParams({ ...(q.trim() && { q: q.trim() }), ...(role && { role }), ...(classFilter && { class_id: classFilter }), ...(status && { active: status }) });
  const list = useAsync((s) => api<UserRow[]>(`/ai/users?${params}`, { signal: s }), [params.toString()], `teach/users?${params}`);
  const [edit, setEdit] = useState<UserRow | 'new' | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [secret, setSecret] = useState<{ user: string; password: string; title: string } | null>(null);

  const reset = async (u: UserRow) => {
    if (!await confirmDialog(`Cấp mật khẩu tạm mới cho ${u.name}? Mật khẩu cũ và mọi phiên đăng nhập của tài khoản này sẽ mất hiệu lực.`)) return;
    try {
      const r = await api<{ temporary_password: string }>(`/ai/users/${encodeURIComponent(u.user_id)}/reset-password`, { method: 'POST' });
      setSecret({ user: u.user_id, password: r.temporary_password, title: 'Mật khẩu tạm mới' }); list.reload();
    } catch (e) { toast(errorText(e), 'error'); }
  };
  const toggleActive = async (u: UserRow) => {
    if (u.is_active && !await confirmDialog(`Khóa tài khoản ${u.name}? Người này sẽ bị đăng xuất và không đăng nhập được nữa.`, { danger: true, okLabel: 'Khóa' })) return;
    try { await api(`/ai/users/${encodeURIComponent(u.user_id)}`, { method: 'PATCH', json: { is_active: !u.is_active } }); list.reload(); }
    catch (e) { toast(errorText(e), 'error'); }
  };

  const noClass = !admin && classes.length === 0;
  return (
    <>
      <Toolbar>
        <SearchBox value={q} onChange={setQ} placeholder="Tìm tên, tên đăng nhập, email…" />
        {admin && (
          <PillSelect label="Vai trò" value={role} onChange={setRole}>
            <option value="">Mọi vai trò</option><option value="student">Học sinh</option><option value="teacher">Giáo viên</option><option value="admin">Quản trị</option>
          </PillSelect>
        )}
        <FilterPills label="Trạng thái" value={status} onChange={setStatus}
          options={[{ id: '', label: 'Tất cả' }, { id: 'true', label: 'Đang hoạt động' }, { id: 'false', label: 'Đã khóa' }]} />
        <span className="grow" />
        <Button variant="ghost" icon="upload" disabled={noClass} onClick={() => setImportOpen(true)}>Nhập từ CSV</Button>
        <Button icon="plus" disabled={noClass} onClick={() => setEdit('new')}>{admin ? 'Thêm tài khoản' : 'Thêm học sinh'}</Button>
      </Toolbar>
      {noClass && <div className="notice" style={{ marginBottom: 14 }}>Bạn chưa có lớp nào. Tạo lớp ở thẻ “Lớp học” trước, rồi thêm học sinh vào lớp.</div>}
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.data && !list.data.length && <Empty title="Không có tài khoản nào khớp" />}
      {!!list.data?.length && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Người dùng</th><th>Vai trò</th><th>Lớp</th><th>Đăng nhập gần nhất</th><th>Trạng thái</th><th /></tr></thead>
            <tbody>
              {list.data.map((u) => (
                <tr key={u.user_id} className={u.is_active ? '' : 'row-dim'}>
                  <td className="td-main"><span className="doc-cell"><Avatar name={u.name} id={u.user_id} size={34} /><span style={{ minWidth: 0 }}><strong>{u.name}</strong><span className="td-sub">@{u.user_id}{u.email ? ` · ${u.email}` : ''}</span></span></span></td>
                  <td><Badge tone={ROLE_TONE[u.role]}>{ROLE_LABEL[u.role]}</Badge></td>
                  <td className="td-num">{u.class_ids.join(', ') || '—'}</td>
                  <td><span className="td-sub">{u.last_login_at ? new Date(u.last_login_at).toLocaleString('vi-VN') : 'Chưa đăng nhập'}</span></td>
                  <td>
                    {!u.is_active ? <StatusTag tone="bad">Đã khóa</StatusTag> : u.must_change_password ? <StatusTag tone="wait">Chờ đổi mật khẩu</StatusTag> : <StatusTag tone="ok">Hoạt động</StatusTag>}
                  </td>
                  <td className="td-actions">
                    <IconButton icon="edit" label="Sửa" onClick={() => setEdit(u)} />
                    {u.user_id !== user?.user_id && <IconButton icon="key" label="Cấp lại mật khẩu" onClick={() => reset(u)} />}
                    {u.user_id !== user?.user_id && <IconButton icon={u.is_active ? 'lock' : 'check'} label={u.is_active ? 'Khóa tài khoản' : 'Mở khóa tài khoản'} onClick={() => toggleActive(u)} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <UserDialog row={edit === 'new' ? null : edit} classes={classes} defaultClass={classFilter} onClose={() => setEdit(null)}
        onSaved={(pw, uid) => { setEdit(null); list.reload(); if (pw) setSecret({ user: uid, password: pw, title: 'Đã tạo tài khoản' }); else toast('Đã lưu', 'success'); }} />}
      {importOpen && <ImportDialog classes={classes} defaultClass={classFilter} onClose={() => { setImportOpen(false); list.reload(); }} />}
      {secret && (
        <Modal open onClose={() => setSecret(null)} title={secret.title}>
          <div className="modal-body">
            <p style={{ fontWeight: 700 }}>Gửi thông tin này cho người dùng. Mật khẩu chỉ hiện <b>một lần</b>; họ sẽ phải đổi mật khẩu ở lần đăng nhập đầu.</p>
            <div className="col" style={{ gap: 6 }}>
              <span className="muted small" style={{ fontWeight: 800 }}>Tên đăng nhập</span><div className="secret">{secret.user}</div>
              <span className="muted small" style={{ fontWeight: 800 }}>Mật khẩu tạm</span><div className="secret">{secret.password}</div>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <Button variant="ghost" icon="copy" onClick={() => copy(`Tên đăng nhập: ${secret.user}\nMật khẩu tạm: ${secret.password}`, toast)}>Sao chép</Button>
              <Button onClick={() => setSecret(null)}>Xong</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function ClassPicker({ classes, value, onChange }: { classes: ClassInfo[]; value: string[]; onChange: (v: string[]) => void }) {
  if (!classes.length) return <p className="muted small">Chưa có lớp nào.</p>;
  return (
    <div className="row" style={{ gap: '6px 16px' }} role="group" aria-label="Lớp">
      {classes.map((c) => (
        <label key={c.class_id} className="check">
          <input type="checkbox" checked={value.includes(c.class_id)}
            onChange={(e) => onChange(e.target.checked ? [...value, c.class_id] : value.filter((x) => x !== c.class_id))} />
          {c.class_id}<span className="muted small">{c.name !== c.class_id ? ` · ${c.name}` : ''}</span>
        </label>
      ))}
    </div>
  );
}

function UserDialog({ row, classes, defaultClass, onClose, onSaved }: {
  row: UserRow | null; classes: ClassInfo[]; defaultClass: string; onClose: () => void; onSaved: (tempPassword: string | null, userId: string) => void;
}) {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const [f, setF] = useState({
    username: row?.user_id || '', display_name: row?.display_name || '', email: row?.email || '', role: (row?.role || 'student') as Role,
    class_ids: row ? row.class_ids.filter((c) => admin || classes.some((x) => x.class_id === c)) : (defaultClass ? [defaultClass] : classes.length === 1 ? [classes[0].class_id] : []),
    password: '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valid = (row || /^[a-z0-9][a-z0-9._-]{2,63}$/.test(f.username.trim().toLowerCase())) && (admin || f.class_ids.length > 0);

  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      if (row) {
        await api(`/ai/users/${encodeURIComponent(row.user_id)}`, { method: 'PATCH', json: {
          display_name: f.display_name, email: f.email, class_ids: f.class_ids, ...(admin && { role: f.role }) } });
        onSaved(null, row.user_id);
      } else {
        const r = await api<{ temporary_password: string | null; user: UserRow }>('/ai/users', { json: {
          username: f.username.trim().toLowerCase(), display_name: f.display_name, email: f.email || null, role: f.role,
          class_ids: f.class_ids, password: f.password || null } });
        onSaved(r.temporary_password || (f.password ? f.password : null), r.user.user_id);
      }
    } catch (e2) { setErr(errorText(e2)); } finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title={row ? `Sửa ${row.name}` : admin ? 'Thêm tài khoản' : 'Thêm học sinh'} dismissable={!busy}>
      <form className="modal-body" onSubmit={save}>
        <div className="form-grid">
          <Field label="Tên đăng nhập" hint={row ? 'Không đổi được' : 'Chữ thường không dấu, số, . _ -  (vd: mã học sinh)'}>
            <input value={f.username} disabled={!!row} onChange={(e) => setF({ ...f, username: e.target.value })} autoCapitalize="none" spellCheck={false} />
          </Field>
          <Field label="Họ và tên"><input value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></Field>
        </div>
        <div className="form-grid">
          <Field label="Email (tùy chọn)"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          {admin && (
            <Field label="Vai trò">
              <select value={f.role} disabled={row?.user_id === user?.user_id} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>
                <option value="student">Học sinh</option><option value="teacher">Giáo viên</option><option value="admin">Quản trị</option>
              </select>
            </Field>
          )}
        </div>
        <fieldset style={{ border: 'none', padding: 0, margin: 0 }} className="col">
          <legend className="field-label" style={{ fontWeight: 800, fontSize: 14, marginBottom: 6 }}>{f.role === 'teacher' ? 'Lớp dạy' : 'Lớp'}</legend>
          <ClassPicker classes={classes} value={f.class_ids} onChange={(v) => setF({ ...f, class_ids: v })} />
        </fieldset>
        {!row && (
          <Field label="Mật khẩu (tùy chọn)" hint="Để trống: hệ thống tạo mật khẩu tạm. Dù đặt hay không, người dùng sẽ phải đổi ở lần đăng nhập đầu.">
            <PasswordInput value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
          </Field>
        )}
        {err && <ErrorBox message={err} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Hủy</Button>
          <Button type="submit" loading={busy} disabled={!valid}>{row ? 'Lưu' : 'Tạo tài khoản'}</Button>
        </div>
      </form>
    </Modal>
  );
}

const SAMPLE_CSV = 'username,display_name,class_ids,email\nhs001,Nguyễn Văn An,CS101,an@example.com\nhs002,Trần Thị Bình,CS101,\n';

function ImportDialog({ classes, defaultClass, onClose }: { classes: ClassInfo[]; defaultClass: string; onClose: () => void }) {
  const { user } = useAuth();
  const [text, setText] = useState('');
  const [cls, setCls] = useState(defaultClass || (classes.length === 1 ? classes[0].class_id : ''));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async () => {
    setBusy(true); setErr(null);
    try { setRes(await api<ImportResult>('/ai/users/import', { json: { csv: text, default_class_id: cls || null } })); }
    catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  const download = () => {
    if (!res) return;
    const lines = ['username,display_name,class_ids,password', ...res.created.map((c) => [c.user_id, c.name || '', c.class_ids.join(';'), c.temporary ? c.password || '' : '(đã đặt)'].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(','))];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = `tai-khoan-${cls || 'moi'}.csv`; a.click();
  };

  return (
    <Modal open onClose={onClose} title="Nhập danh sách từ CSV" wide dismissable={!busy}>
      <div className="modal-body">
        {!res ? (
          <>
            <p className="small" style={{ fontWeight: 700 }}>
              Dòng đầu là tên cột: <code>username</code> (bắt buộc — có thể đặt là <code>mssv</code> / <code>ten_dang_nhap</code>), <code>display_name</code> (<code>ho_ten</code>),
              <code> class_ids</code> (<code>lop</code>, nhiều lớp cách nhau bằng dấu ;), <code>email</code>{user?.role === 'admin' ? <>, <code>role</code></> : null}, <code>password</code>.
              Thiếu mật khẩu thì hệ thống tạo mật khẩu tạm. Xuất từ Excel bằng “CSV UTF-8”.
            </p>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} />
              <Button variant="ghost" icon="upload" onClick={() => fileRef.current?.click()}>Chọn file CSV</Button>
              <Button variant="ghost" onClick={() => setText(SAMPLE_CSV)}>Dùng mẫu</Button>
              <span style={{ flex: 1 }} />
              <Field label="Lớp mặc định (dòng không ghi lớp)">
                <select value={cls} onChange={(e) => setCls(e.target.value)}>
                  <option value="">— Không —</option>
                  {classes.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_id} · {c.name}</option>)}
                </select>
              </Field>
            </div>
            <textarea className="input" style={{ minHeight: 220, fontFamily: 'var(--mono)', fontSize: 13 }} value={text} onChange={(e) => setText(e.target.value)}
              placeholder={SAMPLE_CSV} aria-label="Nội dung CSV" />
            {err && <ErrorBox message={err} />}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={onClose} disabled={busy}>Hủy</Button>
              <Button icon="upload" loading={busy} disabled={!text.trim()} onClick={run}>Nhập</Button>
            </div>
          </>
        ) : (
          <>
            <div className="stat-tiles">
              <div className="tile"><strong style={{ color: 'var(--green)' }}>{res.created.length}</strong><span>Tài khoản đã tạo</span></div>
              <div className="tile"><strong style={{ color: res.errors.length ? 'var(--red)' : undefined }}>{res.errors.length}</strong><span>Dòng lỗi</span></div>
            </div>
            {!!res.created.length && (
              <div className="notice">Mật khẩu tạm chỉ hiện lần này. Hãy <b>tải danh sách</b> và gửi cho học sinh trước khi đóng.</div>
            )}
            {!!res.created.length && (
              <div className="table-wrap" style={{ maxHeight: 280, overflow: 'auto' }}>
                <table className="table">
                  <thead><tr><th>Dòng</th><th>Tên đăng nhập</th><th>Họ tên</th><th>Lớp</th><th>Mật khẩu tạm</th></tr></thead>
                  <tbody>{res.created.map((c) => (
                    <tr key={c.user_id}><td>{c.row}</td><td className="mono">{c.user_id}</td><td>{c.name}</td><td>{c.class_ids.join(', ')}</td>
                      <td className="mono">{c.temporary ? c.password : <span className="muted">(đặt trong file)</span>}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
            {!!res.errors.length && (
              <div className="col" style={{ gap: 4 }}>
                <strong>Dòng bị bỏ qua</strong>
                {res.errors.map((e) => <span key={e.row} className="small" style={{ color: 'var(--red-text)', fontWeight: 700 }}>Dòng {e.row}{e.username ? ` (${e.username})` : ''}: {e.error}</span>)}
              </div>
            )}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              {!!res.created.length && <Button variant="blue" icon="arrowDown" onClick={download}>Tải danh sách (CSV)</Button>}
              <Button variant="ghost" onClick={() => { setRes(null); setText(''); }}>Nhập tiếp</Button>
              <Button onClick={async () => { if (!res.created.length || await confirmDialog('Đã lưu danh sách mật khẩu chưa? Đóng lại sẽ không xem được nữa.')) onClose(); }}>Xong</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Lớp học

function ClassesTab({ classes, onShowStudents }: { classes: ReturnType<typeof useAsync<ClassInfo[]>>; onShowStudents: (classId: string) => void }) {
  const toast = useToast();
  const [create, setCreate] = useState(false);
  const [rename, setRename] = useState<ClassInfo | null>(null);

  const patch = async (c: ClassInfo, body: object, msg: string) => {
    try { await api(`/ai/classes/${encodeURIComponent(c.class_id)}`, { method: 'PATCH', json: body }); classes.reload(); toast(msg, 'success'); }
    catch (e) { toast(errorText(e), 'error'); }
  };

  return (
    <>
      <div className="card row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
        <p className="muted" style={{ fontWeight: 700, maxWidth: 640 }}>Học sinh tự vào lớp bằng <b>mã vào lớp</b> (khi đăng ký hoặc trong Hồ sơ). Đổi mã nếu mã cũ bị lộ.</p>
        <Button icon="plus" onClick={() => setCreate(true)}>Tạo lớp</Button>
      </div>
      {classes.loading && !classes.data && <Spinner />}
      {classes.error && <ErrorBox message={classes.error} onRetry={classes.reload} />}
      {classes.data && !classes.data.length && <Empty title="Chưa có lớp nào">Tạo lớp để thêm học sinh và gán khóa học theo lớp.</Empty>}
      {!!classes.data?.length && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Lớp</th><th>Mã vào lớp</th><th>Học sinh</th><th>Giáo viên</th><th>Trạng thái</th><th /></tr></thead>
            <tbody>
              {classes.data.map((c) => (
                <tr key={c.class_id} className={c.is_active ? '' : 'row-dim'}>
                  <td><strong>{c.name}</strong><div className="muted small">{c.class_id}</div></td>
                  <td>
                    <span className="code-chip">{c.join_code}</span>
                    <IconButton icon="copy" label="Sao chép mã" onClick={() => copy(c.join_code || '', toast)} />
                    <IconButton icon="refresh" label="Đổi mã mới" onClick={async () => { if (await confirmDialog('Tạo mã vào lớp mới? Mã cũ sẽ không dùng được nữa.')) patch(c, { rotate_code: true }, 'Đã đổi mã vào lớp'); }} />
                  </td>
                  <td><button className="linkbtn" onClick={() => onShowStudents(c.class_id)}>{c.students ?? 0} học sinh</button></td>
                  <td>{c.teachers ?? 0}</td>
                  <td>{c.is_active ? <StatusTag tone="ok">Đang mở</StatusTag> : <StatusTag tone="muted">Đã đóng</StatusTag>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <IconButton icon="edit" label="Đổi tên lớp" onClick={() => setRename(c)} />
                    <IconButton icon={c.is_active ? 'lock' : 'check'} label={c.is_active ? 'Đóng lớp (không nhận học sinh mới)' : 'Mở lại lớp'}
                      onClick={() => patch(c, { is_active: !c.is_active }, c.is_active ? 'Đã đóng lớp' : 'Đã mở lại lớp')} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {create && <ClassDialog onClose={() => setCreate(false)} onSaved={() => { setCreate(false); classes.reload(); }} />}
      {rename && <ClassDialog cls={rename} onClose={() => setRename(null)} onSaved={() => { setRename(null); classes.reload(); }} />}
    </>
  );
}

function ClassDialog({ cls, onClose, onSaved }: { cls?: ClassInfo; onClose: () => void; onSaved: () => void }) {
  const { refresh } = useAuth();
  const [id, setId] = useState(cls?.class_id || '');
  const [name, setName] = useState(cls?.name || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      if (cls) await api(`/ai/classes/${encodeURIComponent(cls.class_id)}`, { method: 'PATCH', json: { name } });
      else { await api('/ai/classes', { json: { class_id: id.trim(), name } }); await refresh(); }
      onSaved();
    } catch (e2) { setErr(errorText(e2)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={cls ? 'Đổi tên lớp' : 'Tạo lớp'} dismissable={!busy}>
      <form className="modal-body" onSubmit={save}>
        <Field label="Mã lớp" hint={cls ? 'Không đổi được' : 'Ngắn gọn, không dấu. Ví dụ: CS101, 12A1-2026'}>
          <input value={id} disabled={!!cls} onChange={(e) => setId(e.target.value)} autoFocus={!cls} />
        </Field>
        <Field label="Tên lớp"><input value={name} onChange={(e) => setName(e.target.value)} autoFocus={!!cls} placeholder="Ví dụ: Lập trình hướng đối tượng - K66" /></Field>
        {err && <ErrorBox message={err} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Hủy</Button>
          <Button type="submit" loading={busy} disabled={!id.trim()}>{cls ? 'Lưu' : 'Tạo lớp'}</Button>
        </div>
      </form>
    </Modal>
  );
}

