import { useState, type FormEvent } from 'react';
import { PageHeader } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { Avatar } from '../components/Social';
import { Button, confirmDialog, Empty, ErrorBox, Spinner, useToast } from '../components/ui';
import { api, errorText, type ClassInfo, type User } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync } from '../lib/hooks';
import { Link } from '../lib/router';
import { openDirect } from './Forum';

interface Member { user_id: string; name: string; role: string }

/** Học sinh: tham gia lớp bằng mã, xem lớp đang học, thành viên và nhắn tin nhanh. */
export function MyClasses() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const me = useAsync((s) => api<User & { classes: ClassInfo[] }>('/ai/auth/me', { signal: s }), [], 'auth/me');
  const [code, setCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const join = async (e: FormEvent) => {
    e.preventDefault(); setJoining(true); setErr(null);
    try {
      const r = await api<{ class: ClassInfo; user: User }>('/ai/auth/join-class', { json: { code: code.trim().toUpperCase() } });
      setUser({ ...user!, ...r.user }); setCode(''); me.reload(); toast(`Đã vào lớp ${r.class.name}`, 'success');
    } catch (e2) { setErr(errorText(e2)); } finally { setJoining(false); }
  };
  const leave = async (c: ClassInfo) => {
    if (!await confirmDialog(`Rời lớp ${c.name}? Bạn sẽ không thấy khóa học, diễn đàn và tin nhắn của lớp này nữa.`, { title: 'Rời lớp', okLabel: 'Rời lớp', danger: true })) return;
    try { const u = await api<User>(`/ai/auth/leave-class/${encodeURIComponent(c.class_id)}`, { method: 'POST' }); setUser({ ...user!, ...u }); me.reload(); toast(`Đã rời lớp ${c.name}`, 'success'); }
    catch (e2) { toast(errorText(e2), 'error'); }
  };

  const classes = me.data?.classes || [];
  return (
    <div className="myclasses">
      <PageHeader title="Lớp của tôi" sub="Tham gia lớp bằng mã giáo viên đưa để thấy khóa học, diễn đàn và nhắn tin với cả lớp." />
      <form className="card join-card" onSubmit={join}>
        <div className="join-card-text">
          <span className="join-card-ico"><Icon name="school" size={24} /></span>
          <div><h2>Tham gia lớp bằng mã</h2><p className="muted small">Mã lớp gồm 6–8 ký tự, giáo viên sẽ đưa cho bạn.</p></div>
        </div>
        <div className="join-card-row">
          <input className="join-code-input" value={code} onChange={(e) => { setCode(e.target.value.toUpperCase()); setErr(null); }} maxLength={16}
            placeholder="Nhập mã lớp giáo viên đưa, VD: K7P2QM" aria-label="Mã lớp" autoCapitalize="characters" spellCheck={false} />
          <Button type="submit" size="lg" loading={joining} disabled={code.trim().length < 4}>Tham gia</Button>
        </div>
        {err && <ErrorBox message={err} />}
      </form>

      {me.loading && !me.data && <Spinner />}
      {me.error && <ErrorBox message={me.error} onRetry={me.reload} />}
      {me.data && !classes.length && <Empty title="Chưa có lớp">Bạn chưa vào lớp nào. Nhập mã lớp giáo viên đưa để tham gia.</Empty>}
      <div className="myclass-list">
        {classes.map((c) => <ClassCard key={c.class_id} c={c} me={user?.user_id || ''} onLeave={() => leave(c)} />)}
      </div>
    </div>
  );
}

function ClassCard({ c, me, onLeave }: { c: ClassInfo; me: string; onLeave: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const members = useAsync((s) => api<Member[]>(`/ai/forum/classes/${encodeURIComponent(c.class_id)}/members`, { signal: s }), [c.class_id], `class-members/${c.class_id}`);
  const all = members.data || [];
  const teachers = all.filter((m) => m.role === 'teacher');
  const others = all.filter((m) => m.user_id !== me).sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'teacher' ? -1 : 1));
  return (
    <section className="card myclass">
      <div className="myclass-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <span className="oc-kicker">{c.class_id}</span>
          <h2>{c.name}</h2>
          <p className="muted small">
            {teachers.length ? `Giáo viên: ${teachers.map((t) => t.name).join(', ')}` : members.loading ? 'Đang tải…' : 'Chưa có giáo viên'}
            {members.data ? ` · ${all.length} thành viên` : ''}
          </p>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Link to="/learn" className="btn btn-ghost btn-sm"><Icon name="book" size={16} /> Khóa học của lớp</Link>
          <Link to="/forum" className="btn btn-ghost btn-sm"><Icon name="note" size={16} /> Diễn đàn lớp</Link>
          <Button size="sm" variant="ghost" onClick={onLeave}>Rời lớp</Button>
        </div>
      </div>
      <button type="button" className="myclass-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} /> {open ? 'Ẩn thành viên' : `Xem thành viên${members.data ? ` (${all.length})` : ''}`}
      </button>
      {open && (
        <div className="myclass-members">
          {members.error && <ErrorBox message={members.error} onRetry={members.reload} />}
          {others.map((m) => (
            <div key={m.user_id} className="myclass-member">
              <Avatar name={m.name} id={m.user_id} size={32} />
              <span className="grow" style={{ minWidth: 0 }}><strong>{m.name}</strong><span className="td-sub">{m.role === 'teacher' ? 'Giáo viên' : 'Học sinh'} · @{m.user_id}</span></span>
              <Button size="sm" variant="ghost" icon="chat" onClick={() => openDirect(m.user_id, toast)}>Nhắn tin</Button>
            </div>
          ))}
          {members.data && !others.length && <p className="muted small">Lớp chưa có thành viên nào khác.</p>}
        </div>
      )}
    </section>
  );
}
