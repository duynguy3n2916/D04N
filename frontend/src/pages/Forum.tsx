import { useEffect, useState } from 'react';
import { PageHeader } from '../components/AppShell';
import { Markdown } from '../components/Markdown';
import { Badge, Button, confirmDialog, Empty, ErrorBox, Field, Modal, Spinner, useToast } from '../components/ui';
import { api, errorText } from '../lib/api';
import { isTeacher, useAuth } from '../lib/auth';
import { useAsync } from '../lib/hooks';
import { markForumSeen } from '../lib/notifications';
import { navigate } from '../lib/router';

interface ThreadRow { thread_id: string; title: string; author_id: string; author_name: string; pinned: boolean; locked: boolean; hidden?: boolean; reply_count: number; has_answer: boolean; created_at: string | null }
interface Reply { reply_id: string; body: string; author_id: string; author_name: string; author_is_teacher: boolean; accepted: boolean; hidden?: boolean; created_at: string | null }
interface ThreadFull extends ThreadRow { body: string; replies: Reply[]; can_moderate: boolean; class_id: string }
interface Draft { draft: string | null; refused: boolean; message?: string }
interface Report {
  report_id: string; thread_id: string; reply_id: string | null; thread_title: string; kind: 'thread' | 'reply';
  excerpt: string; author_name: string; reporter_name: string; reason: string; hidden: boolean; created_at: string | null;
}
type ReportTarget = { thread_id?: string; reply_id?: string };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '');

/** Diễn đàn lớp: đặt câu hỏi, trả lời, giáo viên ghim / khóa / đánh dấu câu đúng / xử lý báo cáo. */
export function Forum({ threadId }: { threadId?: string }) {
  const { user } = useAuth();
  const me = useAsync((s) => api<{ classes?: { class_id: string; name: string }[] }>('/ai/auth/me', { signal: s }), []);
  const classes = me.data?.classes?.length ? me.data.classes : (user?.class_ids || []).map((id) => ({ class_id: id, name: '' }));
  const [classId, setClassId] = useState('');
  const cid = classId || classes[0]?.class_id || '';
  const moderator = isTeacher(user) && (user?.role === 'admin' || (user?.class_ids || []).includes(cid));
  if (threadId) return <ThreadView threadId={threadId} />;
  return (
    <>
      <PageHeader title="Diễn đàn lớp" sub="Đặt câu hỏi cho cả lớp, trả lời bạn bè và nhận phản hồi từ giáo viên." />
      {!classes.length ? <Empty title="Bạn chưa vào lớp nào">Nhập mã lớp ở trang hồ sơ để tham gia diễn đàn.</Empty> : (
        <>
          <div className="row" style={{ marginBottom: 14, alignItems: 'flex-end' }}>
            <Field label="Lớp">
              <select value={cid} onChange={(e) => setClassId(e.target.value)}>
                {classes.map((c) => <option key={c.class_id} value={c.class_id}>{c.name ? `${c.class_id} · ${c.name}` : c.class_id}</option>)}
              </select>
            </Field>
          </div>
          {moderator && <ReportsPanel classId={cid} />}
          <NewThread classId={cid} />
          <ThreadList classId={cid} />
        </>
      )}
    </>
  );
}

/** Giáo viên: các báo cáo đang chờ xử lý của lớp. */
function ReportsPanel({ classId }: { classId: string }) {
  const toast = useToast();
  const list = useAsync((s) => api<Report[]>(`/ai/forum/classes/${encodeURIComponent(classId)}/reports`, { signal: s }), [classId]);
  const resolve = async (r: Report, action: 'hide' | 'dismiss') => {
    try {
      await api(`/ai/forum/reports/${r.report_id}/resolve`, { json: { action } });
      toast(action === 'hide' ? 'Đã ẩn nội dung' : 'Đã bỏ qua báo cáo', 'success');
      list.reload();
    } catch (e) { toast(errorText(e), 'error'); }
  };
  if (!list.data?.length) return null;
  return (
    <section className="card col" style={{ gap: 10, marginBottom: 18, borderColor: 'var(--red-line)' }}>
      <strong>Báo cáo cần xử lý ({list.data.length})</strong>
      {list.data.map((r) => (
        <div key={r.report_id} className="col" style={{ gap: 4, borderTop: '2px solid var(--line)', paddingTop: 8 }}>
          <span className="small"><b>{r.reporter_name}</b> báo cáo {r.kind === 'reply' ? 'một trả lời' : 'bài đăng'} của <b>{r.author_name}</b> · {when(r.created_at)}</span>
          <span className="small">Lý do: {r.reason}</span>
          <span className="muted small">“{r.excerpt.slice(0, 160)}{r.excerpt.length > 160 ? '…' : ''}” — trong “{r.thread_title}”</span>
          <div className="row" style={{ gap: 8 }}>
            <Button size="sm" variant="red" onClick={() => resolve(r, 'hide')}>Ẩn nội dung</Button>
            <Button size="sm" variant="ghost" onClick={() => resolve(r, 'dismiss')}>Bỏ qua</Button>
            <Button size="sm" variant="ghost" onClick={() => navigate(`/forum/${r.thread_id}`)}>Xem bài</Button>
          </div>
        </div>
      ))}
    </section>
  );
}

function NewThread({ classId }: { classId: string }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ thread_id: string }>(`/ai/forum/classes/${encodeURIComponent(classId)}/threads`, { json: { title, body } });
      setTitle(''); setBody(''); toast('Đã đăng câu hỏi', 'success');
      navigate(`/forum/${r.thread_id}`);
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <section className="card col" style={{ gap: 10, marginBottom: 18 }}>
      <Field label="Tiêu đề câu hỏi"><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
      <Field label="Nội dung" hint="Hỗ trợ Markdown. Không ghi số điện thoại hay mật khẩu của bạn."><textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} rows={3} /></Field>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button loading={busy} disabled={!title.trim() || !body.trim()} onClick={submit}>Đăng câu hỏi</Button>
      </div>
    </section>
  );
}

function ThreadList({ classId }: { classId: string }) {
  const list = useAsync((s) => api<ThreadRow[]>(`/ai/forum/classes/${encodeURIComponent(classId)}/threads`, { signal: s }), [classId]);
  useEffect(() => { if (list.data) markForumSeen(classId); }, [list.data, classId]);
  if (list.loading && !list.data) return <Spinner />;
  if (list.error) return <ErrorBox message={list.error} onRetry={list.reload} />;
  if (!list.data?.length) return <Empty title="Chưa có câu hỏi nào">Hãy là người đầu tiên đặt câu hỏi cho lớp.</Empty>;
  return (
    <div className="col" style={{ gap: 10 }}>
      {list.data.map((t) => (
        <button key={t.thread_id} className="card" style={{ textAlign: 'left', cursor: 'pointer', opacity: t.hidden ? 0.6 : 1 }} onClick={() => navigate(`/forum/${t.thread_id}`)}>
          <div className="row" style={{ gap: 6, marginBottom: 4 }}>
            {t.hidden && <Badge tone="red">Đã ẩn</Badge>}
            {t.pinned && <Badge tone="yellow">Ghim</Badge>}
            {t.locked && <Badge tone="gray">Đã khóa</Badge>}
            {t.has_answer && <Badge tone="green">Có câu đúng</Badge>}
          </div>
          <strong>{t.title}</strong>
          <div className="muted small">{t.author_name} · {when(t.created_at)} · {t.reply_count} trả lời</div>
        </button>
      ))}
    </div>
  );
}

/** Hộp thoại báo cáo nội dung không phù hợp (gửi cho giáo viên của lớp). */
function ReportDialog({ target, onClose }: { target: ReportTarget; onClose: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api<{ duplicate: boolean }>('/ai/forum/reports', { json: { ...target, reason } });
      toast(r.duplicate ? 'Bạn đã báo cáo nội dung này rồi' : 'Đã gửi báo cáo cho giáo viên', 'success');
      onClose();
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Báo cáo nội dung" dismissable={!busy}>
      <div className="modal-body">
        <Field label="Lý do" hint="Ví dụ: nội dung xúc phạm, spam, lộ thông tin cá nhân."><textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} autoFocus /></Field>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Hủy</Button>
          <Button variant="red" loading={busy} disabled={!reason.trim()} onClick={send}>Gửi báo cáo</Button>
        </div>
      </div>
    </Modal>
  );
}

function ThreadView({ threadId }: { threadId: string }) {
  const { user } = useAuth();
  const toast = useToast();
  const data = useAsync((s) => api<ThreadFull>(`/ai/forum/threads/${threadId}`, { signal: s }), [threadId]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reporting, setReporting] = useState<ReportTarget | null>(null);
  const t = data.data;
  const refresh = () => data.reload();
  useEffect(() => { if (t?.class_id) markForumSeen(t.class_id); }, [t?.class_id, t?.reply_count]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) toast(ok, 'success'); refresh(); } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  const reply = () => act(async () => { await api(`/ai/forum/threads/${threadId}/replies`, { json: { body: text } }); setText(''); }, 'Đã gửi trả lời');
  const toggle = (k: 'pinned' | 'locked' | 'hidden', v: boolean) => act(() => api(`/ai/forum/threads/${threadId}`, { method: 'PATCH', json: { [k]: v } }));
  const hideReply = (rid: string, hidden: boolean) => act(() => api(`/ai/forum/replies/${rid}`, { method: 'PATCH', json: { hidden } }));
  const accept = (rid: string) => act(() => api(`/ai/forum/replies/${rid}/accept`, { method: 'POST' }), 'Đã đánh dấu câu trả lời đúng');
  const remove = async (path: string, back = false) => {
    if (!await confirmDialog('Xóa nội dung này? Không khôi phục được.', { danger: true, okLabel: 'Xóa' })) return;
    await act(async () => {
      await api(path, { method: 'DELETE' });
      if (back) navigate('/forum');
    }, 'Đã xóa');
  };
  const makeDraft = async () => {
    setBusy(true);
    try { setDraft(await api<Draft>(`/ai/forum/threads/${threadId}/ai-draft`, { method: 'POST' })); } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };

  if (data.loading && !t) return <Spinner />;
  if (data.error) return <ErrorBox message={data.error} onRetry={data.reload} />;
  if (!t) return null;
  const mine = user?.user_id === t.author_id;
  return (
    <>
      <PageHeader title={t.title} sub={<><button className="linkbtn" onClick={() => navigate('/forum')}>← Về diễn đàn</button></>}
        actions={t.can_moderate ? <>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => toggle('pinned', !t.pinned)}>{t.pinned ? 'Bỏ ghim' : 'Ghim'}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => toggle('locked', !t.locked)}>{t.locked ? 'Mở khóa' : 'Khóa bài'}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => toggle('hidden', !t.hidden)}>{t.hidden ? 'Hiện lại' : 'Ẩn bài'}</Button>
        </> : undefined} />
      <section className="card col" style={{ gap: 8, marginBottom: 14, opacity: t.hidden ? 0.7 : 1 }}>
        <div className="row" style={{ gap: 6 }}>
          <span className="muted small">{t.author_name} · {when(t.created_at)}</span>
          {t.hidden && <Badge tone="red">Đã ẩn với học sinh</Badge>}
        </div>
        <Markdown source={t.body} />
        <div className="row">
          {(mine || t.can_moderate) && <Button variant="danger-ghost" size="sm" disabled={busy} onClick={() => remove(`/ai/forum/threads/${threadId}`, true)}>Xóa bài</Button>}
          {!mine && !t.can_moderate && <Button variant="ghost" size="sm" onClick={() => setReporting({ thread_id: threadId })}>Báo cáo</Button>}
        </div>
      </section>

      {t.can_moderate && (
        <section className="card col" style={{ gap: 8, marginBottom: 14 }}>
          <strong>Gợi ý trả lời từ học liệu (AI)</strong>
          <span className="muted small">Bản nháp chỉ để bạn tham khảo. Hãy sửa lại rồi tự đăng; hệ thống không đăng thay bạn.</span>
          <div className="row"><Button variant="soft" size="sm" icon="sparkle" loading={busy} onClick={makeDraft}>Soạn nháp</Button></div>
          {draft && (draft.refused || !draft.draft) && <span className="muted small">{draft.message || 'Học liệu chưa đủ để soạn nháp.'}</span>}
          {draft?.draft && (<>
            <Markdown source={draft.draft} />
            <div className="row"><Button size="sm" variant="ghost" onClick={() => setText(draft.draft || '')}>Dùng làm nội dung trả lời</Button></div>
          </>)}
        </section>
      )}

      <div className="col" style={{ gap: 10, marginBottom: 14 }}>
        {t.replies.length === 0 && <span className="muted">Chưa có trả lời nào.</span>}
        {t.replies.map((r) => (
          <section key={r.reply_id} className="card col" style={{ gap: 6, borderColor: r.accepted ? 'var(--green-line)' : undefined, opacity: r.hidden ? 0.6 : 1 }}>
            <div className="row" style={{ gap: 6 }}>
              <strong>{r.author_name}</strong>
              {r.author_is_teacher && <Badge tone="blue">Giáo viên</Badge>}
              {r.accepted && <Badge tone="green">Câu đúng</Badge>}
              {r.hidden && <Badge tone="red">Đã ẩn</Badge>}
              <span className="muted small">{when(r.created_at)}</span>
            </div>
            <Markdown source={r.body} />
            <div className="row">
              {(mine || t.can_moderate) && !r.accepted && !r.hidden && <Button variant="ghost" size="sm" disabled={busy} onClick={() => accept(r.reply_id)}>Đánh dấu đúng</Button>}
              {t.can_moderate && <Button variant="ghost" size="sm" disabled={busy} onClick={() => hideReply(r.reply_id, !r.hidden)}>{r.hidden ? 'Hiện lại' : 'Ẩn'}</Button>}
              {(r.author_id === user?.user_id || t.can_moderate) && <Button variant="danger-ghost" size="sm" disabled={busy} onClick={() => remove(`/ai/forum/replies/${r.reply_id}`)}>Xóa</Button>}
              {r.author_id !== user?.user_id && !t.can_moderate && <Button variant="ghost" size="sm" onClick={() => setReporting({ reply_id: r.reply_id })}>Báo cáo</Button>}
            </div>
          </section>
        ))}
      </div>

      {t.locked && !t.can_moderate ? <span className="muted small">Bài này đã bị khóa.</span> : (
        <section className="card col" style={{ gap: 8 }}>
          <Field label="Trả lời"><textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} rows={3} /></Field>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button loading={busy} disabled={!text.trim()} onClick={reply}>Gửi trả lời</Button>
          </div>
        </section>
      )}
      {reporting && <ReportDialog target={reporting} onClose={() => setReporting(null)} />}
    </>
  );
}
