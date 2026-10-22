import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { Avatar, ImageGrid, ImagePicker, MentionTextarea, timeAgo, useMembers, type Member, type PickedImage } from '../components/Social';
import { Badge, Button, confirmDialog, Empty, ErrorBox, Field, Modal, Spinner, useToast } from '../components/ui';
import { api, errorText } from '../lib/api';
import { isTeacher, useAuth } from '../lib/auth';
import { useAsync } from '../lib/hooks';
import { markForumSeen } from '../lib/notifications';
import { navigate } from '../lib/router';

type Kind = 'question' | 'post' | 'announcement';
type Sort = 'new' | 'top' | 'unanswered';
interface ThreadRow {
  thread_id: string; class_id: string; lesson_code: string | null; title: string; body: string; kind: Kind; tags: string[]; images: string[];
  author_id: string; author_name: string; pinned: boolean; locked: boolean; hidden?: boolean; reply_count: number; has_answer: boolean;
  like_count: number; liked: boolean; created_at: string | null;
}
interface Reply {
  reply_id: string; parent_id: string | null; body: string; images: string[]; author_id: string; author_name: string; author_is_teacher: boolean;
  accepted: boolean; hidden?: boolean; like_count: number; liked: boolean; created_at: string | null;
}
interface ThreadFull extends ThreadRow { replies: Reply[]; can_moderate: boolean }
interface LessonRef { code: string; title: string; course_title: string }
interface Draft { draft: string | null; refused: boolean; message?: string }
interface Report {
  report_id: string; thread_id: string; reply_id: string | null; thread_title: string; kind: 'thread' | 'reply';
  excerpt: string; author_name: string; reporter_name: string; reason: string; hidden: boolean; created_at: string | null;
}
interface DmReport { report_id: string; message_id: string; body: string; sender_name: string; reporter_name: string; reason: string; created_at: string | null }
type ReportTarget = { thread_id?: string; reply_id?: string };

const KIND_LABEL: Record<Kind, string> = { question: 'Câu hỏi', post: 'Chia sẻ', announcement: 'Thông báo' };
const KIND_TONE: Record<Kind, 'blue' | 'purple' | 'orange'> = { question: 'blue', post: 'purple', announcement: 'orange' };
const SORTS: { id: Sort; label: string }[] = [{ id: 'new', label: 'Mới nhất' }, { id: 'top', label: 'Nổi bật' }, { id: 'unanswered', label: 'Chưa có trả lời' }];

/** Làm nổi @tên trong nội dung (Markdown đậm). */
const withMentions = (s: string) => s.replace(/(^|[^\w@])@([a-z0-9][a-z0-9._-]{2,63})/gi, '$1**@$2**');

/** Bỏ ký hiệu Markdown để hiện đoạn trích gọn trên bảng tin. */
const stripMarkdown = (s: string) => s
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
  .replace(/(\*\*|__|\*|~~|`)/g, '');

/** Mở (hoặc lấy lại) hội thoại riêng với một thành viên cùng lớp rồi chuyển sang trang tin nhắn. */
export async function openDirect(userId: string, toast: ReturnType<typeof useToast>) {
  try {
    const c = await api<{ conversation_id: string }>('/ai/messages/conversations', { json: { user_id: userId } });
    navigate(`/messages/${c.conversation_id}`);
  } catch (e) { toast(errorText(e), 'error'); }
}

async function toggleLike(type: 'thread' | 'reply', id: string) {
  return api<{ liked: boolean; like_count: number }>('/ai/forum/likes', { json: { target_type: type, target_id: id } });
}

function LikeButton({ liked, count, onClick, disabled }: { liked: boolean; count: number; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className={`sn-act ${liked ? 'sn-liked' : ''}`} aria-pressed={liked} disabled={disabled} onClick={onClick}>
      <Icon name={liked ? 'heartFill' : 'heart'} size={18} /> {count > 0 ? count : ''} <span className="sr-only">{liked ? 'Bỏ thích' : 'Thích'}</span>
      {count === 0 && <span aria-hidden="true">Thích</span>}
    </button>
  );
}

/** Mạng xã hội học tập của lớp: bảng tin câu hỏi / chia sẻ / thông báo, thích, bình luận, @nhắc tên, ảnh, thẻ. */
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
      <PageHeader title="Diễn đàn lớp" sub="Hỏi bài, chia sẻ tài liệu, thả tim và thảo luận cùng cả lớp."
        actions={<Button variant="ghost" size="sm" icon="chat" onClick={() => navigate('/messages')}>Tin nhắn</Button>} />
      {!classes.length ? <Empty title="Bạn chưa vào lớp nào">Nhập mã lớp ở trang hồ sơ để tham gia diễn đàn.</Empty> : (
        <>
          {classes.length > 1 && (
            <div className="row" style={{ marginBottom: 14, alignItems: 'flex-end' }}>
              <Field label="Lớp">
                <select value={cid} onChange={(e) => setClassId(e.target.value)}>
                  {classes.map((c) => <option key={c.class_id} value={c.class_id}>{c.name ? `${c.class_id} · ${c.name}` : c.class_id}</option>)}
                </select>
              </Field>
            </div>
          )}
          {moderator && <ReportsPanel classId={cid} />}
          {moderator && <DmReportsPanel classId={cid} />}
          <Feed key={cid} classId={cid} moderator={moderator} />
        </>
      )}
    </>
  );
}

function Feed({ classId, moderator }: { classId: string; moderator: boolean }) {
  const { user } = useAuth();
  const toast = useToast();
  const [sort, setSort] = useState<Sort>('new');
  const [kind, setKind] = useState<Kind | ''>('');
  const [tag, setTag] = useState('');
  const [lesson, setLesson] = useState('');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => { const t = setTimeout(() => setQ(qInput.trim()), 350); return () => clearTimeout(t); }, [qInput]);
  const members = useMembers(classId);
  const lessons = useAsync((s) => api<LessonRef[]>(`/ai/forum/classes/${encodeURIComponent(classId)}/lessons`, { signal: s }), [classId]);
  const lessonTitle = useMemo(() => Object.fromEntries((lessons.data || []).map((l) => [l.code, l.title])), [lessons.data]);
  const params = new URLSearchParams({ sort });
  if (kind) params.set('kind', kind);
  if (tag) params.set('tag', tag);
  if (lesson) params.set('lesson_code', lesson);
  if (q) params.set('q', q);
  const qs = params.toString();
  const list = useAsync((s) => api<ThreadRow[]>(`/ai/forum/classes/${encodeURIComponent(classId)}/threads?${qs}`, { signal: s }), [classId, qs]);
  useEffect(() => { if (list.data) markForumSeen(classId); }, [list.data, classId]);

  const like = async (t: ThreadRow) => {
    try {
      const r = await toggleLike('thread', t.thread_id);
      list.setData((rows) => rows?.map((x) => (x.thread_id === t.thread_id ? { ...x, liked: r.liked, like_count: r.like_count } : x)) ?? rows);
    } catch (e) { toast(errorText(e), 'error'); }
  };
  const filtered = !!(kind || tag || lesson || q);
  return (
    <>
      <Composer classId={classId} moderator={moderator} members={members.data || []} lessons={lessons.data || []} onPosted={list.reload} />
      <div className="sn-toolbar">
        <div className="sn-tabs" role="tablist" aria-label="Sắp xếp">
          {SORTS.map((s) => <button key={s.id} role="tab" aria-selected={sort === s.id} className={sort === s.id ? 'on' : ''} onClick={() => setSort(s.id)}>{s.label}</button>)}
        </div>
        <label className="sn-search">
          <Icon name="search" size={18} />
          <span className="sr-only">Tìm bài đăng</span>
          <input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Tìm trong diễn đàn…" />
        </label>
      </div>
      <div className="row" style={{ gap: 6, marginBottom: 12 }}>
        {(['', 'question', 'post', 'announcement'] as const).map((k) => (
          <button key={k || 'all'} className={`sn-pill ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>{k ? KIND_LABEL[k] : 'Tất cả'}</button>
        ))}
        {tag && <button className="sn-pill on" onClick={() => setTag('')}>#{tag} <Icon name="x" size={12} /></button>}
        {lesson && <button className="sn-pill on" onClick={() => setLesson('')}><Icon name="book" size={14} /> {lessonTitle[lesson] || lesson} <Icon name="x" size={12} /></button>}
      </div>
      {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorBox message={list.error} onRetry={list.reload} /> : !list.data?.length ? (
        <Empty title={filtered ? 'Không có bài nào khớp bộ lọc' : 'Bảng tin còn trống'}>{filtered ? 'Thử bỏ bớt bộ lọc hoặc từ khóa.' : 'Hãy là người đầu tiên đăng bài cho lớp.'}</Empty>
      ) : (
        <div className="col" style={{ gap: 12 }}>
          {list.data.map((t) => (
            <PostCard key={t.thread_id} t={t} mine={t.author_id === user?.user_id} lessonTitle={t.lesson_code ? lessonTitle[t.lesson_code] : undefined}
              onLike={() => like(t)} onTag={setTag} onLesson={setLesson} onMessage={() => openDirect(t.author_id, toast)} />
          ))}
        </div>
      )}
    </>
  );
}

function PostHead({ t, onMessage, mine }: { t: ThreadRow; onMessage?: () => void; mine: boolean }) {
  return (
    <div className="sn-head">
      <Avatar name={t.author_name} id={t.author_id} size={40} />
      <div className="grow">
        <div className="row" style={{ gap: 6 }}>
          <strong>{t.author_name}</strong>
          <Badge tone={KIND_TONE[t.kind]}>{KIND_LABEL[t.kind]}</Badge>
          {t.pinned && <Badge tone="yellow">Ghim</Badge>}
          {t.locked && <Badge tone="gray">Đã khóa</Badge>}
          {t.hidden && <Badge tone="red">Đã ẩn</Badge>}
          {t.has_answer && <Badge tone="green">Đã có câu đúng</Badge>}
        </div>
        <span className="muted small">@{t.author_id} · {timeAgo(t.created_at)}</span>
      </div>
      {!mine && onMessage && <button type="button" className="sn-act" onClick={(e) => { e.stopPropagation(); onMessage(); }} title="Nhắn tin riêng"><Icon name="chat" size={18} /><span className="sr-only">Nhắn tin cho {t.author_name}</span></button>}
    </div>
  );
}

function TagRow({ t, lessonTitle, onTag, onLesson }: { t: ThreadRow; lessonTitle?: string; onTag?: (v: string) => void; onLesson?: (v: string) => void }) {
  if (!t.tags.length && !t.lesson_code) return null;
  return (
    <div className="row" style={{ gap: 6 }}>
      {t.lesson_code && <button type="button" className="sn-tag sn-tag-lesson" onClick={(e) => { e.stopPropagation(); onLesson ? onLesson(t.lesson_code!) : undefined; }}><Icon name="book" size={13} /> {lessonTitle || t.lesson_code}</button>}
      {t.tags.map((g) => <button key={g} type="button" className="sn-tag" onClick={(e) => { e.stopPropagation(); onTag?.(g); }}>#{g}</button>)}
    </div>
  );
}

function PostCard({ t, mine, lessonTitle, onLike, onTag, onLesson, onMessage }: {
  t: ThreadRow; mine: boolean; lessonTitle?: string; onLike: () => void; onTag: (v: string) => void; onLesson: (v: string) => void; onMessage: () => void;
}) {
  const open = () => navigate(`/forum/${t.thread_id}`);
  const plain = stripMarkdown(t.body);
  const excerpt = plain.length > 320 ? `${plain.slice(0, 320)}…` : plain;
  return (
    <article className={`card sn-post ${t.kind === 'announcement' ? 'sn-ann' : ''}`} style={{ opacity: t.hidden ? 0.6 : 1 }}>
      <PostHead t={t} mine={mine} onMessage={onMessage} />
      <button type="button" className="sn-body" onClick={open} aria-label={`Mở bài: ${t.title}`}>
        <h3>{t.title}</h3>
        <p className="sn-excerpt">{excerpt}</p>
      </button>
      <ImageGrid urls={t.images} />
      <TagRow t={t} lessonTitle={lessonTitle} onTag={onTag} onLesson={onLesson} />
      <div className="sn-actions">
        <LikeButton liked={t.liked} count={t.like_count} onClick={onLike} />
        <button type="button" className="sn-act" onClick={open}><Icon name="chat" size={18} /> {t.reply_count ? `${t.reply_count} bình luận` : 'Bình luận'}</button>
      </div>
    </article>
  );
}

function Composer({ classId, moderator, members, lessons, onPosted }: {
  classId: string; moderator: boolean; members: Member[]; lessons: LessonRef[]; onPosted: () => void;
}) {
  const { user } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('question');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const [lesson, setLesson] = useState('');
  const [images, setImages] = useState<PickedImage[]>([]);
  const [busy, setBusy] = useState(false);
  const reset = () => { setTitle(''); setBody(''); setTags(''); setLesson(''); setImages([]); setKind('question'); setOpen(false); };
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/ai/forum/classes/${encodeURIComponent(classId)}/threads`, {
        json: { kind, title, body, lesson_code: lesson || null, images: images.map((i) => i.image_id),
          tags: tags.split(/[,\s]+/).map((x) => x.replace(/^#/, '').trim()).filter(Boolean).slice(0, 5) },
      });
      toast(kind === 'question' ? 'Đã đăng câu hỏi' : 'Đã đăng bài', 'success');
      reset();
      onPosted();
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  if (!open) {
    return (
      <button type="button" className="card sn-compose-closed" onClick={() => setOpen(true)}>
        <Avatar name={user?.name || user?.user_id || ''} id={user?.user_id || ''} />
        <span className="muted">Bạn muốn hỏi hay chia sẻ gì với lớp?</span>
      </button>
    );
  }
  const kinds: Kind[] = moderator ? ['question', 'post', 'announcement'] : ['question', 'post'];
  return (
    <section className="card col sn-compose">
      <div className="sn-tabs" role="radiogroup" aria-label="Loại bài">
        {kinds.map((k) => <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>)}
      </div>
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus aria-label="Tiêu đề"
        placeholder={kind === 'question' ? 'Bạn đang thắc mắc điều gì?' : kind === 'post' ? 'Tiêu đề bài chia sẻ' : 'Tiêu đề thông báo'} />
      <MentionTextarea value={body} onChange={setBody} members={members} rows={4}
        placeholder="Nội dung (hỗ trợ Markdown). Gõ @ để nhắc tên bạn cùng lớp. Đừng ghi số điện thoại hay mật khẩu." />
      <div className="sn-compose-meta">
        <label className="sn-inline"><Icon name="tag" size={16} /><span className="sr-only">Thẻ chủ đề</span>
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="#thẻ, cách nhau bằng dấu phẩy" maxLength={160} />
        </label>
        {lessons.length > 0 && (
          <label className="sn-inline"><Icon name="book" size={16} /><span className="sr-only">Gắn bài học</span>
            <select className="input" value={lesson} onChange={(e) => setLesson(e.target.value)}>
              <option value="">Không gắn bài học</option>
              {lessons.map((l) => <option key={l.code} value={l.code}>{l.course_title} · {l.title}</option>)}
            </select>
          </label>
        )}
      </div>
      <ImagePicker classId={classId} images={images} onChange={setImages} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={reset} disabled={busy}>Hủy</Button>
        <Button loading={busy} disabled={!title.trim() || !body.trim()} onClick={submit}>Đăng</Button>
      </div>
    </section>
  );
}

/** Giáo viên: báo cáo bài đăng / bình luận đang chờ xử lý của lớp. */
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
      <strong>Báo cáo trên diễn đàn ({list.data.length})</strong>
      {list.data.map((r) => (
        <div key={r.report_id} className="col" style={{ gap: 4, borderTop: '2px solid var(--line)', paddingTop: 8 }}>
          <span className="small"><b>{r.reporter_name}</b> báo cáo {r.kind === 'reply' ? 'một bình luận' : 'bài đăng'} của <b>{r.author_name}</b> · {timeAgo(r.created_at)}</span>
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

/** Giáo viên: tin nhắn riêng bị báo cáo (chỉ thấy đúng tin bị báo cáo, không đọc được cả hội thoại). */
function DmReportsPanel({ classId }: { classId: string }) {
  const toast = useToast();
  const list = useAsync((s) => api<DmReport[]>(`/ai/messages/reports/${encodeURIComponent(classId)}`, { signal: s }), [classId]);
  const resolve = async (r: DmReport, action: 'hide' | 'dismiss') => {
    try {
      await api(`/ai/messages/reports/${r.report_id}/resolve`, { json: { action } });
      toast(action === 'hide' ? 'Đã ẩn tin nhắn' : 'Đã bỏ qua báo cáo', 'success');
      list.reload();
    } catch (e) { toast(errorText(e), 'error'); }
  };
  if (!list.data?.length) return null;
  return (
    <section className="card col" style={{ gap: 10, marginBottom: 18, borderColor: 'var(--red-line)' }}>
      <strong>Tin nhắn riêng bị báo cáo ({list.data.length})</strong>
      <span className="muted small">Bạn chỉ thấy tin nhắn bị báo cáo, không xem được phần còn lại của cuộc trò chuyện.</span>
      {list.data.map((r) => (
        <div key={r.report_id} className="col" style={{ gap: 4, borderTop: '2px solid var(--line)', paddingTop: 8 }}>
          <span className="small"><b>{r.reporter_name}</b> báo cáo tin nhắn của <b>{r.sender_name}</b> · {timeAgo(r.created_at)}</span>
          <span className="small">Lý do: {r.reason}</span>
          <span className="muted small">“{r.body.slice(0, 200)}{r.body.length > 200 ? '…' : ''}”</span>
          <div className="row" style={{ gap: 8 }}>
            <Button size="sm" variant="red" onClick={() => resolve(r, 'hide')}>Ẩn tin nhắn</Button>
            <Button size="sm" variant="ghost" onClick={() => resolve(r, 'dismiss')}>Bỏ qua</Button>
          </div>
        </div>
      ))}
    </section>
  );
}

/** Hộp thoại báo cáo nội dung không phù hợp (gửi cho giáo viên của lớp). */
export function ReportDialog({ title = 'Báo cáo nội dung', onSend, onClose }: { title?: string; onSend: (reason: string) => Promise<string>; onClose: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try { toast(await onSend(reason), 'success'); onClose(); } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={title} dismissable={!busy}>
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

const reportForum = (target: ReportTarget) => async (reason: string) => {
  const r = await api<{ duplicate: boolean }>('/ai/forum/reports', { json: { ...target, reason } });
  return r.duplicate ? 'Bạn đã báo cáo nội dung này rồi' : 'Đã gửi báo cáo cho giáo viên';
};

function ThreadView({ threadId }: { threadId: string }) {
  const { user } = useAuth();
  const toast = useToast();
  const data = useAsync((s) => api<ThreadFull>(`/ai/forum/threads/${threadId}`, { signal: s }), [threadId]);
  const t = data.data;
  const members = useMembers(t?.class_id || '');
  const lessons = useAsync((s) => (t?.lesson_code ? api<LessonRef[]>(`/ai/forum/classes/${encodeURIComponent(t.class_id)}/lessons`, { signal: s }) : Promise.resolve([])), [t?.class_id, t?.lesson_code]);
  const [text, setText] = useState('');
  const [images, setImages] = useState<PickedImage[]>([]);
  const [replyTo, setReplyTo] = useState<Reply | null>(null);
  const [subText, setSubText] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reporting, setReporting] = useState<ReportTarget | null>(null);
  const refresh = () => data.reload();
  useEffect(() => { if (t?.class_id) markForumSeen(t.class_id); }, [t?.class_id, t?.reply_count]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) toast(ok, 'success'); refresh(); } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  const send = () => act(async () => {
    await api(`/ai/forum/threads/${threadId}/replies`, { json: { body: text, images: images.map((i) => i.image_id) } });
    setText(''); setImages([]);
  }, 'Đã gửi bình luận');
  const sendSub = () => act(async () => {
    await api(`/ai/forum/threads/${threadId}/replies`, { json: { body: subText, parent_id: replyTo?.reply_id } });
    setSubText(''); setReplyTo(null);
  });
  const like = async (type: 'thread' | 'reply', id: string) => {
    try {
      const r = await toggleLike(type, id);
      data.setData((d) => (!d ? d : type === 'thread' ? { ...d, liked: r.liked, like_count: r.like_count }
        : { ...d, replies: d.replies.map((x) => (x.reply_id === id ? { ...x, liked: r.liked, like_count: r.like_count } : x)) }));
    } catch (e) { toast(errorText(e), 'error'); }
  };
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
  const canWrite = !t.locked || t.can_moderate;
  const roots = t.replies.filter((r) => !r.parent_id);
  const children = (id: string) => t.replies.filter((r) => r.parent_id === id);
  const lessonTitle = lessons.data?.find((l) => l.code === t.lesson_code)?.title;

  const comment = (r: Reply, nested: boolean) => (
    <div key={r.reply_id} className={`sn-comment ${nested ? 'sn-nested' : ''} ${r.accepted ? 'sn-accepted' : ''}`} style={{ opacity: r.hidden ? 0.6 : 1 }}>
      <Avatar name={r.author_name} id={r.author_id} size={nested ? 28 : 34} />
      <div className="grow col" style={{ gap: 4 }}>
        <div className="sn-bubble">
          <div className="row" style={{ gap: 6 }}>
            <strong>{r.author_name}</strong>
            {r.author_is_teacher && <Badge tone="blue">Giáo viên</Badge>}
            {r.accepted && <Badge tone="green">Câu đúng</Badge>}
            {r.hidden && <Badge tone="red">Đã ẩn</Badge>}
          </div>
          <Markdown source={withMentions(r.body)} />
          <ImageGrid urls={r.images} />
        </div>
        <div className="sn-comment-actions">
          <span className="muted small">{timeAgo(r.created_at)}</span>
          <LikeButton liked={r.liked} count={r.like_count} onClick={() => like('reply', r.reply_id)} />
          {canWrite && <button type="button" className="sn-act" onClick={() => { setReplyTo(r); setSubText(r.author_id !== user?.user_id ? `@${r.author_id} ` : ''); }}><Icon name="reply" size={16} /> Trả lời</button>}
          {(mine || t.can_moderate) && !nested && !r.accepted && !r.hidden && t.kind === 'question' && <button type="button" className="sn-act" disabled={busy} onClick={() => accept(r.reply_id)}><Icon name="check" size={16} /> Đánh dấu đúng</button>}
          {t.can_moderate && <button type="button" className="sn-act" disabled={busy} onClick={() => hideReply(r.reply_id, !r.hidden)}><Icon name={r.hidden ? 'eye' : 'eyeOff'} size={16} /> {r.hidden ? 'Hiện lại' : 'Ẩn'}</button>}
          {(r.author_id === user?.user_id || t.can_moderate) && <button type="button" className="sn-act sn-danger" disabled={busy} onClick={() => remove(`/ai/forum/replies/${r.reply_id}`)}><Icon name="trash" size={16} /> Xóa</button>}
          {r.author_id !== user?.user_id && !t.can_moderate && <button type="button" className="sn-act" onClick={() => setReporting({ reply_id: r.reply_id })}><Icon name="flag" size={16} /> Báo cáo</button>}
        </div>
      </div>
    </div>
  );

  return (
    <>
      <PageHeader title={t.title} sub={<button className="linkbtn" onClick={() => navigate('/forum')}>← Về bảng tin</button>}
        actions={t.can_moderate ? <>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => toggle('pinned', !t.pinned)}>{t.pinned ? 'Bỏ ghim' : 'Ghim'}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => toggle('locked', !t.locked)}>{t.locked ? 'Mở khóa' : 'Khóa bài'}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => toggle('hidden', !t.hidden)}>{t.hidden ? 'Hiện lại' : 'Ẩn bài'}</Button>
        </> : undefined} />
      <article className={`card col sn-post ${t.kind === 'announcement' ? 'sn-ann' : ''}`} style={{ marginBottom: 14, opacity: t.hidden ? 0.7 : 1 }}>
        <PostHead t={t} mine={mine} onMessage={() => openDirect(t.author_id, toast)} />
        <Markdown source={withMentions(t.body)} />
        <ImageGrid urls={t.images} />
        <TagRow t={t} lessonTitle={lessonTitle} />
        <div className="sn-actions">
          <LikeButton liked={t.liked} count={t.like_count} onClick={() => like('thread', t.thread_id)} />
          <span className="muted small">{t.reply_count} bình luận</span>
          <span className="grow" />
          {(mine || t.can_moderate) && <button type="button" className="sn-act sn-danger" disabled={busy} onClick={() => remove(`/ai/forum/threads/${threadId}`, true)}><Icon name="trash" size={16} /> Xóa bài</button>}
          {!mine && !t.can_moderate && <button type="button" className="sn-act" onClick={() => setReporting({ thread_id: threadId })}><Icon name="flag" size={16} /> Báo cáo</button>}
        </div>
      </article>

      {t.can_moderate && (
        <section className="card col" style={{ gap: 8, marginBottom: 14 }}>
          <strong>Gợi ý trả lời từ học liệu (AI)</strong>
          <span className="muted small">Bản nháp chỉ để bạn tham khảo. Hãy sửa lại rồi tự đăng; hệ thống không đăng thay bạn.</span>
          <div className="row"><Button variant="soft" size="sm" icon="sparkle" loading={busy} onClick={makeDraft}>Soạn nháp</Button></div>
          {draft && (draft.refused || !draft.draft) && <span className="muted small">{draft.message || 'Học liệu chưa đủ để soạn nháp.'}</span>}
          {draft?.draft && (<>
            <Markdown source={draft.draft} />
            <div className="row"><Button size="sm" variant="ghost" onClick={() => setText(draft.draft || '')}>Dùng làm nội dung bình luận</Button></div>
          </>)}
        </section>
      )}

      {canWrite ? (
        <section className="card col sn-reply-box" style={{ marginBottom: 14 }}>
          <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
            <Avatar name={user?.name || user?.user_id || ''} id={user?.user_id || ''} />
            <div className="grow col" style={{ gap: 8 }}>
              <MentionTextarea value={text} onChange={setText} members={members.data || []} rows={2} onSubmit={() => text.trim() && send()}
                placeholder={t.kind === 'question' ? 'Viết câu trả lời… (gõ @ để nhắc tên, Ctrl+Enter để gửi)' : 'Viết bình luận… (gõ @ để nhắc tên)'} />
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <ImagePicker classId={t.class_id} images={images} onChange={setImages} />
                <Button loading={busy} disabled={!text.trim()} onClick={send} icon="send">Gửi</Button>
              </div>
            </div>
          </div>
        </section>
      ) : <p className="muted small" style={{ marginBottom: 14 }}>Bài này đã bị khóa, không bình luận thêm được.</p>}

      <div className="col" style={{ gap: 14 }}>
        {roots.length === 0 && <span className="muted">Chưa có bình luận nào.</span>}
        {roots.map((r) => (
          <div key={r.reply_id} className="col" style={{ gap: 8 }}>
            {comment(r, false)}
            {children(r.reply_id).map((c) => comment(c, true))}
            {replyTo && (replyTo.reply_id === r.reply_id || replyTo.parent_id === r.reply_id) && (
              <div className="sn-nested sn-subreply">
                <MentionTextarea value={subText} onChange={setSubText} members={members.data || []} rows={2} autoFocus onSubmit={() => subText.trim() && sendSub()}
                  placeholder={`Trả lời ${replyTo.author_name}…`} />
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <Button size="sm" variant="ghost" onClick={() => setReplyTo(null)}>Hủy</Button>
                  <Button size="sm" loading={busy} disabled={!subText.trim()} onClick={sendSub}>Trả lời</Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {reporting && <ReportDialog onSend={reportForum(reporting)} onClose={() => setReporting(null)} />}
    </>
  );
}
