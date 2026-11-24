import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PageHeader } from '../../components/AppShell';
import { Icon } from '../../components/Icon';
import { Markdown } from '../../components/Markdown';
import { PillSelect } from '../../components/Manage';
import { Badge, Button, confirmDialog, Empty, ErrorBox, Field, IconButton, Modal, Spinner, useToast } from '../../components/ui';
import { api, errorText, mediaUrl, pollJob, type ClassInfo, type ItemType } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { Link, navigate } from '../../lib/router';
import { TYPE_ICON, TYPE_LABEL } from '../Learn';
import { ManualCreateDialog } from '../../components/ManualCreateDialog';

interface AdminItem { item_id: string; type: ItemType; title: string; position: number; video_id: string | null; document_id: string | null; meta: any; has_content: boolean }
interface AdminLesson { lesson_id: string; code: string; title: string; description?: string; items: AdminItem[] }
interface AdminCourse { course_id: string; code: string; title: string; description?: string; class_id: string | null; class_ids?: string[]; cover_url?: string | null; chapters: { chapter_id: string; title: string; lessons: AdminLesson[] }[] }
interface CourseRow { course_id: string; code: string; title: string; class_id: string | null; cover_url?: string | null; chapters: number; items: number }
interface VideoRow { video_id: string; title: string; has_file: boolean; transcript: { version: number } | null; questions: { approved: number; draft: number } }
interface DocRow { document_id: string; title: string; source_type: string; status: string; lesson_id: string | null }

// Kiểu dữ liệu câu hỏi trong ngân hàng đề thi
interface BankQuestionItem {
  item_id: string;
  question: string;
  options: string[];
  answer?: string;
  explanation?: string;
  difficulty?: string | null;
  status: string;
  lesson_id: string | null;
}

// ---------------------------------------------------------------- Ảnh bìa

const COVER_ACCEPT = 'image/png,image/jpeg,image/webp';
const COVER_MAX_BYTES = 5 * 1024 * 1024;

/** Trả về thông báo lỗi nếu file không hợp lệ làm ảnh bìa, hoặc null nếu hợp lệ. */
function coverError(file: File): string | null {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return 'Ảnh bìa phải là PNG, JPG hoặc WEBP.';
  if (file.size > COVER_MAX_BYTES) return 'Ảnh bìa vượt quá 5 MB.';
  return null;
}

function uploadCover(courseId: string, file: File) {
  const fd = new FormData(); fd.append('file', file);
  return api<AdminCourse>(`/ai/courses/${courseId}/cover`, { form: fd });
}

/** Ảnh bìa khóa học; chưa có ảnh thì hiện nền màu kèm biểu tượng. */
function CourseCover({ url, tone = 'var(--brand)', className = '' }: { url?: string | null; tone?: string; className?: string }) {
  return (
    <span className={`cover ${className}`} style={url ? undefined : { background: tone }}>
      {url ? <img src={mediaUrl(url)} alt="" /> : <Icon name="list" size={40} />}
    </span>
  );
}

/** Chọn ảnh bìa khi tạo khóa học: chỉ giữ file trong form, tải lên sau khi khóa học được tạo. */
function CoverPicker({ file, onChange }: { file: File | null; onChange: (f: File | null) => void }) {
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <div className="col" style={{ gap: 8 }}>
      <span style={{ fontWeight: 800, fontSize: 14 }}>Ảnh bìa <span className="muted">(tùy chọn)</span></span>
      <div className="cover-pick">
        {preview ? <img src={preview} alt="Xem trước ảnh bìa" /> : <span className="muted small">Chưa có ảnh · PNG, JPG hoặc WEBP, tối đa 5 MB</span>}
      </div>
      <div className="row">
        <input ref={ref} type="file" hidden accept={COVER_ACCEPT} onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          const bad = coverError(f);
          if (bad) toast(bad, 'error'); else onChange(f);
        }} />
        <Button type="button" size="sm" variant="soft" icon="upload" onClick={() => ref.current?.click()}>{file ? 'Đổi ảnh' : 'Chọn ảnh'}</Button>
        {file && <Button type="button" size="sm" variant="ghost" icon="trash" onClick={() => onChange(null)}>Bỏ ảnh</Button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Danh sách khóa học

export function Courses() {
  const toast = useToast();
  const list = useAsync((s) => api<CourseRow[]>('/ai/courses', { signal: s }), []);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', class_id: '' });
  const [cover, setCover] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const c = await api<AdminCourse>('/ai/courses', { json: { ...form, class_id: form.class_id || null } });
      if (cover) {
        try { await uploadCover(c.course_id, cover); } catch (e) { toast(`Đã tạo khóa học nhưng chưa lưu được ảnh bìa: ${errorText(e)}`, 'error'); }
      }
      navigate(`/teach/courses/${c.course_id}`);
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader title="Khóa học" sub="Soạn lộ trình: chương → bài → mục học (video, slide, bài đọc, kiểm tra)."
        actions={<Button icon="plus" onClick={() => setOpen(true)}>Tạo khóa học</Button>} />
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.data && !list.data.length && <Empty title="Chưa có khóa học nào">Bấm “Tạo khóa học” để bắt đầu.</Empty>}
      <div className="course-grid">
        {list.data?.map((c) => (
          <Link key={c.course_id} to={`/teach/courses/${c.course_id}`} className="course-card">
            <CourseCover url={c.cover_url} />
            <span className="course-card-body">
              <strong>{c.title}</strong>
              <span className="muted small">{c.code}{c.class_id ? ` · lớp ${c.class_id}` : ' · mọi lớp'}</span>
              <span className="course-card-foot">
                <span className="muted small" style={{ fontWeight: 800 }}>{c.chapters} chương · {c.items} mục học</span>
                <Icon name="chevronRight" />
              </span>
            </span>
          </Link>
        ))}
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="Tạo khóa học">
        <div className="modal-body">
          <CoverPicker file={cover} onChange={setCover} />
          <Field label="Tên khóa học"><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          <Field label="Lớp (tùy chọn)" hint="Để trống = mọi lớp"><input value={form.class_id} onChange={(e) => setForm({ ...form, class_id: e.target.value })} /></Field>
          <Field label="Mô tả"><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          {err && <ErrorBox message={err} />}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setOpen(false)}>Hủy</Button>
            <Button loading={busy} disabled={!form.title.trim()} onClick={create}>Tạo</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- Soạn khóa học

type Dialog =
  | { kind: 'chapter'; chapterId?: string; title?: string }
  | { kind: 'lesson'; chapterId: string; lesson?: AdminLesson }
  | { kind: 'item'; lesson: AdminLesson; item?: AdminItem }
  | { kind: 'course' };
type Sel = { kind: 'course' } | { kind: 'chapter' | 'lesson' | 'item'; id: string };

export function CourseEditor({ courseId }: { courseId: string }) {
  const toast = useToast();
  const tree = useAsync((s) => api<AdminCourse>(`/ai/courses/${courseId}`, { signal: s }), [courseId]);
  const [dlg, setDlg] = useState<Dialog | null>(null);
  const [addQuizLesson, setAddQuizLesson] = useState<string | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);

  const run = async (p: Promise<AdminCourse>, msg?: string) => {
    try { tree.setData(await p); if (msg) toast(msg, 'success'); } catch (e) { toast(errorText(e), 'error'); }
  };
  const move = (kind: 'chapters' | 'lessons' | 'items', id: string, direction: number) =>
    run(api<AdminCourse>(`/ai/${kind}/${id}/move`, { json: { direction } }));
  const del = async (kind: 'chapters' | 'lessons' | 'items', id: string, label: string) => {
    if (!await confirmDialog(`Xóa ${label}? Tiến độ học sinh của phần này cũng bị xóa.`, { danger: true, okLabel: 'Xóa' })) return;
    run(api<AdminCourse>(`/ai/${kind}/${id}`, { method: 'DELETE' }), 'Đã xóa');
  };
  const delCourse = async () => {
    if (!await confirmDialog('Xóa toàn bộ khóa học này?', { danger: true, okLabel: 'Xóa' })) return;
    try { await api(`/ai/courses/${courseId}`, { method: 'DELETE' }); navigate('/teach/courses'); } catch (e) { toast(errorText(e), 'error'); }
  };

  const c = tree.data;
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}><Link to="/teach/courses" className="muted small" style={{ fontWeight: 800 }}>← Tất cả khóa học</Link></div>
      <PageHeader title={c?.title || 'Đang tải…'} sub={c ? `${c.code}${c.class_id ? ` · lớp ${c.class_id}` : ' · mọi lớp'}${c.description ? ` · ${c.description}` : ''}` : undefined}
        actions={c && <>
          <Button variant="ghost" icon="play" onClick={() => navigate(`/learn/${c.course_id}`)}>Xem như học sinh</Button>
        </>} />
      {tree.loading && !c && <Spinner />}
      {tree.error && <ErrorBox message={tree.error} onRetry={tree.reload} />}
      {c && (() => {
        // Tìm nút đang chọn trong cây; mặc định là bài đầu tiên.
        const chapters = c.chapters;
        const findLesson = (id: string) => { for (const ch of chapters) { const i = ch.lessons.findIndex((l) => l.lesson_id === id); if (i >= 0) return { ch, ls: ch.lessons[i], li: i }; } return null; };
        const findItem = (id: string) => { for (const ch of chapters) for (const ls of ch.lessons) { const i = ls.items.findIndex((x) => x.item_id === id); if (i >= 0) return { ch, ls, it: ls.items[i], ii: i }; } return null; };
        const first = chapters.find((ch) => ch.lessons.length)?.lessons[0];
        let s: Sel = sel || (first ? { kind: 'lesson', id: first.lesson_id } : { kind: 'course' });
        if ((s.kind === 'lesson' && !findLesson(s.id)) || (s.kind === 'item' && !findItem(s.id)) || (s.kind === 'chapter' && !chapters.some((x) => x.chapter_id === (s as { id: string }).id))) s = { kind: 'course' };
        const on = (k: Sel['kind'], id?: string) => s.kind === k && (k === 'course' || (s as { id: string }).id === id);

        const itemRow = (ls: AdminLesson, it: AdminItem, ii: number) => {
          const isQuiz = it.type === 'quiz';
          const requiredCount = it.meta?.count ?? 5;
          const currentCount = it.meta?.bank_count ?? 0;
          const isQuizFull = currentCount >= requiredCount;
          return (
            <div key={it.item_id} className="tree-item">
              <span className={`type-ico type-${it.type}`}><Icon name={TYPE_ICON[it.type]} size={18} /></span>
              <button type="button" className="ce-link" onClick={() => setSel({ kind: 'item', id: it.item_id })}><strong>{it.title}</strong><span className="td-sub">{TYPE_LABEL[it.type]} · {itemMeta(it)}</span></button>
              <Reorder onUp={() => move('items', it.item_id, -1)} onDown={() => move('items', it.item_id, 1)} first={ii === 0} last={ii === ls.items.length - 1} />
              {isQuiz && (
                <span title={isQuizFull ? 'Số lượng câu hỏi của bài kiểm tra đã đủ' : `Thêm câu hỏi (${currentCount}/${requiredCount})`}>
                  <IconButton icon="plus" label="Thêm câu hỏi" disabled={isQuizFull} onClick={() => setAddQuizLesson(ls.code)} />
                </span>
              )}
              {it.type === 'video' && it.video_id && <IconButton icon="question" label="Quản lý câu hỏi video" onClick={() => navigate(`/teach/videos/${encodeURIComponent(it.video_id!)}`)} />}
              <IconButton icon="edit" label="Sửa mục" onClick={() => setDlg({ kind: 'item', lesson: ls, item: it })} />
              <IconButton icon="trash" label="Xóa mục" onClick={() => del('items', it.item_id, `mục “${it.title}”`)} />
            </div>
          );
        };

        let detail: ReactNode = null;
        if (s.kind === 'course') {
          detail = (<>
            <div className="ce-head"><span className="oc-kicker">Khóa học</span><h2>{c.title}</h2>{c.description && <p className="muted">{c.description}</p>}</div>
            <CoverEditor course={c} onChanged={tree.setData} />
            <CourseClasses course={c} onChanged={tree.setData} />
            <div className="row"><Button variant="ghost" icon="edit" onClick={() => setDlg({ kind: 'course' })}>Sửa thông tin</Button><span className="grow" /><Button variant="danger-ghost" icon="trash" onClick={delCourse}>Xóa khóa học</Button></div>
          </>);
        } else if (s.kind === 'chapter') {
          const ci = chapters.findIndex((x) => x.chapter_id === s.id); const ch = chapters[ci];
          detail = (<>
            <div className="ce-head"><span className="oc-kicker">Chương {ci + 1}</span><h2>{ch.title}</h2><p className="muted">{ch.lessons.length} bài · {ch.lessons.reduce((n, l) => n + l.items.length, 0)} mục học</p></div>
            <div className="row">
              <Button variant="ghost" icon="edit" onClick={() => setDlg({ kind: 'chapter', chapterId: ch.chapter_id, title: ch.title })}>Đổi tên</Button>
              <Reorder onUp={() => move('chapters', ch.chapter_id, -1)} onDown={() => move('chapters', ch.chapter_id, 1)} first={ci === 0} last={ci === chapters.length - 1} />
              <span className="grow" />
              <Button variant="danger-ghost" icon="trash" onClick={() => del('chapters', ch.chapter_id, `chương “${ch.title}”`)}>Xóa chương</Button>
            </div>
            <div className="card ce-list">
              {ch.lessons.map((ls, li) => (
                <div key={ls.lesson_id} className="tree-item">
                  <span className="ol-code">{ls.code}</span>
                  <button type="button" className="ce-link" onClick={() => setSel({ kind: 'lesson', id: ls.lesson_id })}><strong>{ls.title}</strong><span className="td-sub">{ls.items.length} mục học</span></button>
                  <Reorder onUp={() => move('lessons', ls.lesson_id, -1)} onDown={() => move('lessons', ls.lesson_id, 1)} first={li === 0} last={li === ch.lessons.length - 1} />
                </div>
              ))}
              {!ch.lessons.length && <p className="muted" style={{ padding: '8px 12px' }}>Chương chưa có bài.</p>}
            </div>
            <div><Button variant="soft" icon="plus" onClick={() => setDlg({ kind: 'lesson', chapterId: ch.chapter_id })}>Thêm bài</Button></div>
          </>);
        } else if (s.kind === 'lesson') {
          const { ch, ls, li } = findLesson(s.id)!;
          detail = (<>
            <div className="ce-head"><span className="oc-kicker">{ch.title} · {ls.code}</span><h2>{ls.title}</h2>{ls.description && <p className="muted">{ls.description}</p>}</div>
            <div className="row">
              <Button variant="ghost" icon="edit" onClick={() => setDlg({ kind: 'lesson', chapterId: ch.chapter_id, lesson: ls })}>Sửa bài</Button>
              <Button variant="ghost" icon="question" onClick={() => navigate(`/teach/questions?lesson=${encodeURIComponent(ls.code)}`)}>Câu hỏi của bài</Button>
              <Reorder onUp={() => move('lessons', ls.lesson_id, -1)} onDown={() => move('lessons', ls.lesson_id, 1)} first={li === 0} last={li === ch.lessons.length - 1} />
              <span className="grow" />
              <Button variant="danger-ghost" icon="trash" onClick={() => del('lessons', ls.lesson_id, `bài “${ls.title}”`)}>Xóa bài</Button>
            </div>
            <div className="card ce-list">
              {ls.items.map((it, ii) => itemRow(ls, it, ii))}
              {!ls.items.length && <p className="muted" style={{ padding: '8px 12px' }}>Bài chưa có mục học. Thêm video, slide, bài đọc hoặc bài kiểm tra.</p>}
            </div>
            <div><Button icon="plus" onClick={() => setDlg({ kind: 'item', lesson: ls })}>Thêm mục học</Button></div>
          </>);
        } else {
          const { ls, it, ii } = findItem(s.id)!;
          detail = (<>
            <div className="ce-head"><span className="oc-kicker">{ls.code} · {TYPE_LABEL[it.type]}</span><h2>{it.title}</h2><p className="muted">{itemMeta(it)}{it.has_content ? '' : ' · chưa có nội dung'}</p></div>
            <div className="card ce-list">{itemRow(ls, it, ii)}</div>
            <div className="row">
              <Button icon="edit" onClick={() => setDlg({ kind: 'item', lesson: ls, item: it })}>Sửa nội dung</Button>
              <Button variant="ghost" icon="chevronLeft" onClick={() => setSel({ kind: 'lesson', id: ls.lesson_id })}>Về bài {ls.code}</Button>
            </div>
          </>);
        }

        return (
          <div className="ce-layout">
            <nav className="card ce-tree" aria-label="Cấu trúc khóa học">
              <button type="button" className={`ce-node ce-course ${on('course') ? 'on' : ''}`} onClick={() => setSel({ kind: 'course' })}><Icon name="settings" size={16} />Thông tin khóa học</button>
              {chapters.map((ch, ci) => (
                <div key={ch.chapter_id} className="ce-group">
                  <button type="button" className={`ce-node ce-chapter ${on('chapter', ch.chapter_id) ? 'on' : ''}`} onClick={() => setSel({ kind: 'chapter', id: ch.chapter_id })}>
                    <span className="ol-code">C{ci + 1}</span>{ch.title}</button>
                  {ch.lessons.map((ls) => (
                    <div key={ls.lesson_id}>
                      <button type="button" className={`ce-node ce-lesson ${on('lesson', ls.lesson_id) ? 'on' : ''}`} onClick={() => setSel({ kind: 'lesson', id: ls.lesson_id })}>
                        <span className="ol-code">{ls.code}</span>{ls.title}<span className="ce-n">{ls.items.length}</span></button>
                      {(on('lesson', ls.lesson_id) || ls.items.some((x) => on('item', x.item_id))) && ls.items.map((it) => (
                        <button key={it.item_id} type="button" className={`ce-node ce-item ${on('item', it.item_id) ? 'on' : ''}`} onClick={() => setSel({ kind: 'item', id: it.item_id })}>
                          <Icon name={TYPE_ICON[it.type]} size={15} />{it.title}</button>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
              <Button size="sm" variant="soft" icon="plus" onClick={() => setDlg({ kind: 'chapter' })}>Thêm chương</Button>
            </nav>
            <div className="ce-detail">
              {!chapters.length && s.kind === 'course' && <Empty title="Khóa học chưa có chương nào">Bấm “Thêm chương” ở cột trái, sau đó thêm bài và các mục học.</Empty>}
              {detail}
            </div>
          </div>
        );
      })()}

      {c && dlg?.kind === 'course' && <CourseDialog course={c} onClose={() => setDlg(null)} onSaved={(t) => { tree.setData(t); setDlg(null); }} onCoverChanged={tree.setData} />}
      {c && dlg?.kind === 'chapter' && (
        <TitleDialog title={dlg.chapterId ? 'Đổi tên chương' : 'Thêm chương'} initial={dlg.title || ''} onClose={() => setDlg(null)}
          onSave={async (title) => {
            const t = dlg.chapterId
              ? await api<AdminCourse>(`/ai/chapters/${dlg.chapterId}`, { method: 'PATCH', json: { title } })
              : await api<AdminCourse>(`/ai/courses/${c.course_id}/chapters`, { json: { title } });
            tree.setData(t); setDlg(null);
          }} />
      )}
      {c && dlg?.kind === 'lesson' && <LessonDialog chapterId={dlg.chapterId} lesson={dlg.lesson} onClose={() => setDlg(null)} onSaved={(t) => { tree.setData(t); setDlg(null); }} />}
      {c && dlg?.kind === 'item' && <ItemDialog course={c} lesson={dlg.lesson} item={dlg.item} onClose={() => setDlg(null)} onSaved={(t) => { tree.setData(t); setDlg(null); toast('Đã lưu mục học', 'success'); }} />}
    
      {addQuizLesson && (
          <ManualCreateDialog 
            defaultLesson={addQuizLesson} 
            onClose={() => setAddQuizLesson(null)} 
            onSaved={() => { 
              setAddQuizLesson(null); 
              tree.reload(); 
              toast('Đã thêm câu hỏi vào ngân hàng đề thi!', 'success'); 
            }} 
          />
        )}
    </>
  );
}

function CoverEditor({ course, onChanged }: { course: AdminCourse; onChanged: (c: AdminCourse) => void }) {
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const run = async (p: Promise<AdminCourse>, msg: string) => {
    setBusy(true);
    try { onChanged(await p); toast(msg, 'success'); } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <section className="card cover-edit" aria-label="Ảnh bìa khóa học">
      <CourseCover url={course.cover_url} />
      <div className="col" style={{ gap: 8 }}>
        <strong style={{ fontSize: 16 }}>Ảnh bìa</strong>
        <span className="muted small">Hiện ở danh sách khóa học để dễ nhận biết. PNG, JPG hoặc WEBP, tối đa 5 MB.</span>
        <div className="row">
          <input ref={ref} type="file" hidden accept={COVER_ACCEPT} onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            const bad = coverError(f);
            if (bad) toast(bad, 'error'); else run(uploadCover(course.course_id, f), 'Đã cập nhật ảnh bìa');
          }} />
          <Button type="button" size="sm" variant="soft" icon="upload" loading={busy} onClick={() => ref.current?.click()}>{course.cover_url ? 'Đổi ảnh' : 'Tải ảnh lên'}</Button>
          {course.cover_url && (
            <Button type="button" size="sm" variant="danger-ghost" icon="trash" disabled={busy}
              onClick={() => run(api<AdminCourse>(`/ai/courses/${course.course_id}/cover`, { method: 'DELETE' }), 'Đã gỡ ảnh bìa')}>Gỡ ảnh</Button>
          )}
        </div>
      </div>
    </section>
  );
}

/** ISO (UTC) -> giá trị cho ô datetime-local theo giờ máy người dùng. */
function toLocalInput(iso?: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function itemMeta(it: AdminItem) {
  if (it.type === 'video') return it.video_id || 'chưa gắn video';
  if (it.type === 'slide') return it.document_id ? `${it.meta?.pages ? `${it.meta.pages} trang` : 'tài liệu'}` : 'chưa gắn file';
  if (it.type === 'reading') return it.has_content ? 'đã có nội dung' : 'chưa có nội dung';
  return `${it.meta?.count ?? 5} câu · qua ${Math.round((it.meta?.pass_ratio ?? 0.8) * 100)}%${it.meta?.time_limit_minutes ? ` · ${it.meta.time_limit_minutes} phút` : ''}`;
}

function Reorder({ onUp, onDown, first, last }: { onUp: () => void; onDown: () => void; first: boolean; last: boolean }) {
  return (
    <>
      <IconButton icon="arrowUp" label="Lên trên" onClick={onUp} disabled={first} />
      <IconButton icon="arrowDown" label="Xuống dưới" onClick={onDown} disabled={last} />
    </>
  );
}

function FormModal({ title, onClose, children, onSave, canSave = true, wide, saveLabel = 'Lưu' }: {
  title: string; onClose: () => void; children: ReactNode; onSave: () => Promise<void>; canSave?: boolean; wide?: boolean; saveLabel?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try { await onSave(); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={title} wide={wide} dismissable={!busy}>
      <form className="modal-body" onSubmit={(e) => { e.preventDefault(); if (canSave) save(); }}>
        {children}
        {err && <ErrorBox message={err} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Hủy</Button>
          <Button type="submit" loading={busy} disabled={!canSave}>{saveLabel}</Button>
        </div>
      </form>
    </Modal>
  );
}

function TitleDialog({ title, initial, onClose, onSave }: { title: string; initial: string; onClose: () => void; onSave: (t: string) => Promise<void> }) {
  const [v, setV] = useState(initial);
  return (
    <FormModal title={title} onClose={onClose} onSave={() => onSave(v.trim())} canSave={!!v.trim()}>
      <Field label="Tên"><input autoFocus value={v} onChange={(e) => setV(e.target.value)} /></Field>
    </FormModal>
  );
}

/** Gắn một khóa học cho nhiều lớp: giáo viên chỉ thêm được lớp mình phụ trách. */
function CourseClasses({ course, onChanged }: { course: AdminCourse; onChanged: (c: AdminCourse) => void }) {
  const toast = useToast();
  const mine = useAsync((s) => api<ClassInfo[]>('/ai/classes', { signal: s }), []);
  const [pick, setPick] = useState('');
  const linked = course.class_ids?.length ? course.class_ids : (course.class_id ? [course.class_id] : []);
  const addable = (mine.data || []).filter((c) => !linked.includes(c.class_id));
  const add = async () => {
    if (!pick) return;
    try { onChanged(await api<AdminCourse>(`/ai/courses/${course.course_id}/classes`, { json: { class_id: pick } })); setPick(''); toast('Đã thêm lớp', 'success'); }
    catch (e) { toast(errorText(e), 'error'); }
  };
  const remove = async (cid: string) => {
    try { onChanged(await api<AdminCourse>(`/ai/courses/${course.course_id}/classes/${encodeURIComponent(cid)}`, { method: 'DELETE' })); toast('Đã gỡ lớp', 'success'); }
    catch (e) { toast(errorText(e), 'error'); }
  };
  return (
    <section className="card col" style={{ gap: 10, marginBottom: 14 }}>
      <strong>Lớp được học khóa này</strong>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        {linked.length === 0 && <span className="muted small">Khóa học dùng chung cho mọi lớp.</span>}
        {linked.map((cid) => (
          <span key={cid} className="chip">
            {cid}{cid === course.class_id ? ' (lớp chính)' : ''}
            {cid !== course.class_id && <button className="chip-x" aria-label={`Gỡ lớp ${cid}`} onClick={() => remove(cid)}>×</button>}
          </span>
        ))}
      </div>
      {!!addable.length && (
        <div className="row" style={{ gap: 8 }}>
          <PillSelect label="Chọn lớp để thêm" value={pick} onChange={setPick}>
            <option value="">Chọn lớp của bạn…</option>
            {addable.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_id} · {c.name}</option>)}
          </PillSelect>
          <Button size="sm" variant="soft" disabled={!pick} onClick={add}>Thêm lớp</Button>
        </div>
      )}
    </section>
  );
}

function CourseDialog({ course, onClose, onSaved, onCoverChanged }: { course: AdminCourse; onClose: () => void; onSaved: (c: AdminCourse) => void; onCoverChanged: (c: AdminCourse) => void }) {
  const [f, setF] = useState({ title: course.title, description: course.description || '', class_id: course.class_id || '' });
  return (
    <FormModal title="Thông tin khóa học" onClose={onClose} canSave={!!f.title.trim()}
      onSave={async () => onSaved(await api<AdminCourse>(`/ai/courses/${course.course_id}`, { method: 'PATCH', json: f }))}>
      <CoverEditor course={course} onChanged={onCoverChanged} />
      <Field label="Tên khóa học"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="Lớp chính" hint="Để trống = mọi lớp. Gắn thêm lớp khác ở phần 'Lớp được học khóa này'."><input value={f.class_id} onChange={(e) => setF({ ...f, class_id: e.target.value })} /></Field>
      <Field label="Mô tả"><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
    </FormModal>
  );
}

function LessonDialog({ chapterId, lesson, onClose, onSaved }: { chapterId: string; lesson?: AdminLesson; onClose: () => void; onSaved: (c: AdminCourse) => void }) {
  const [f, setF] = useState({ title: lesson?.title || '', description: lesson?.description || '' });
  return (
    <FormModal title={lesson ? 'Sửa bài học' : 'Thêm bài học'} onClose={onClose} canSave={!!f.title.trim()}
      onSave={async () => onSaved(lesson
        ? await api<AdminCourse>(`/ai/lessons/${lesson.lesson_id}`, { method: 'PATCH', json: { title: f.title, description: f.description } })
        : await api<AdminCourse>(`/ai/chapters/${chapterId}/lessons`, { json: f }))}>
      <Field label="Tên bài"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="Mô tả ngắn"><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
    </FormModal>
  );
}

function ItemDialog({ course, lesson, item, onClose, onSaved }: { course: AdminCourse; lesson: AdminLesson; item?: AdminItem; onClose: () => void; onSaved: (c: AdminCourse) => void }) {
  const toast = useToast();
  const [type, setType] = useState<ItemType>(item?.type || 'video');
  const [title, setTitle] = useState(item?.title || '');
  const [videoId, setVideoId] = useState(item?.video_id || '');
  const [docId, setDocId] = useState(item?.document_id || '');
  const [notes, setNotes] = useState(item?.meta?.notes || '');
  const [count, setCount] = useState<number>(item?.meta?.count ?? 5);
  const [passPct, setPassPct] = useState<number>(Math.round((item?.meta?.pass_ratio ?? 0.8) * 100));
  const [timeLimit, setTimeLimit] = useState<number>(item?.meta?.time_limit_minutes ?? 0);
  const [openAt, setOpenAt] = useState<string>(toLocalInput(item?.meta?.open_at));
  const [closeAt, setCloseAt] = useState<string>(toLocalInput(item?.meta?.close_at));
  const [preview, setPreview] = useState(false);
  const full = useAsync((s) => (item ? api<{ content_md: string | null }>(`/ai/items/${item.item_id}`, { signal: s }) : Promise.resolve({ content_md: '' })), [item?.item_id]);
  const [md, setMd] = useState<string | null>(null);
  const content = md ?? full.data?.content_md ?? '';
  const videos = useAsync((s) => (type === 'video' ? api<VideoRow[]>('/ai/media/videos', { signal: s }) : Promise.resolve([] as VideoRow[])), [type]);
  const docs = useAsync((s) => (type === 'slide' ? api<DocRow[]>(`/ai/documents?lesson_id=${encodeURIComponent(lesson.code)}`, { signal: s }) : Promise.resolve([] as DocRow[])), [type]);
  const [upload, setUpload] = useState<string | null>(null);

  const [quizTab, setQuizTab] = useState<'general' | 'questions'>('general');
  const bank = useAsync((s) => (type === 'quiz' ? api<BankQuestionItem[]>('/ai/teacher/question-bank', { signal: s }) : Promise.resolve([] as BankQuestionItem[])), [type]);

  // Lọc ra danh sách câu hỏi đã duyệt thuộc bài học hiện tại (khớp theo mã code hoặc lesson_id)
  const approvedQuestions = bank.data?.filter(
    (q) => (q.lesson_id === lesson.code || q.lesson_id === lesson.lesson_id) && q.status === 'approved'
  ) || [];

  const [uploadingVideo, setUploadingVideo] = useState(false); 
  const videoFileRef = useRef<HTMLInputElement>(null); 

  const mdFileRef = useRef<HTMLInputElement>(null);
  const [uploadingMd, setUploadingMd] = useState(false);

  const uploadVideoInline = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    if (course.class_id) fd.append('class_id', course.class_id);
    if (title) fd.append('title', title);
    
    setUploadingVideo(true);
    setUpload('Đang tải video lên Cloudflare R2…');
    try {
      const res = await api<VideoRow>('/ai/media/videos/inline-upload', { method: 'POST', form: fd });
      toast('Tải video lên thành công!', 'success');
      await videos.reload();
      setVideoId(res.video_id);
      if (!title) setTitle(file.name.replace(/\.[^.]+$/, ''));
      setUpload(null);
    } catch (e) {
      toast('Lỗi tải video: ' + errorText(e), 'error');
      setUpload('Lỗi tải lên.');
    } finally {
      setUploadingVideo(false);
      if (videoFileRef.current) videoFileRef.current.value = '';
    }
  };

  const uploadMarkdownInline = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    setUploadingMd(true);
    try {
      const res = await api<{ content_md: string }>('/ai/media/parse-markdown', { method: 'POST', form: fd });
      setMd(res.content_md);
      setPreview(false);
      toast('Đã nạp nội dung từ file Markdown', 'success');
      if (!title) setTitle(file.name.replace(/\.[^.]+$/, ''));
    } catch (e) {
      toast('Lỗi đọc file: ' + errorText(e), 'error');
    } finally {
      setUploadingMd(false);
      if (mdFileRef.current) mdFileRef.current.value = '';
    }
  };

  const uploadSlide = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file); fd.append('lesson_id', lesson.code); fd.append('course_id', course.code);
    if (course.class_id) fd.append('class_id', course.class_id);
    setUpload('Đang tải lên…');
    try {
      const r = await api<{ document_id: string; job_id?: string; duplicate?: boolean }>('/ai/documents/index', { form: fd });
      if (r.job_id) {
        const j = await pollJob(r.job_id, (j) => setUpload(`Đang xử lý… ${j.progress != null ? Math.round(j.progress * 100) + '%' : ''} ${j.message || ''}`));
        if (j.status === 'failed') throw new Error(j.error || 'Xử lý tài liệu thất bại');
      }
      setDocId(r.document_id); setUpload(r.duplicate ? 'File này đã có sẵn — đã chọn bản cũ.' : 'Đã tải lên và nạp vào Knowledge Base.');
      if (!title) setTitle(file.name.replace(/\.[^.]+$/, ''));
      docs.reload();
    } catch (e) { setUpload('Lỗi: ' + errorText(e)); }
  };

  const valid = !!title.trim() && (type !== 'video' || !!videoId) && (type !== 'slide' || !!docId) && (type !== 'reading' || content.trim().length >= 20);
  const save = async () => {
    const body: any = { type, title: title.trim() };
    if (type === 'video') body.video_id = videoId;
    if (type === 'slide') { body.document_id = docId; body.notes = notes; }
    if (type === 'reading') body.content_md = content;
    if (type === 'quiz') { body.count = count; body.pass_ratio = passPct / 100; body.time_limit_minutes = timeLimit; body.open_at = openAt ? new Date(openAt).toISOString() : ''; body.close_at = closeAt ? new Date(closeAt).toISOString() : ''; }
    onSaved(item
      ? await api<AdminCourse>(`/ai/items/${item.item_id}`, { method: 'PATCH', json: body })
      : await api<AdminCourse>(`/ai/lessons/${lesson.lesson_id}/items`, { json: body }));
  };

  return (
    <FormModal title={item ? `Sửa mục · ${TYPE_LABEL[type]}` : `Thêm mục vào “${lesson.title}”`} onClose={onClose} onSave={save} canSave={valid} wide={type === 'reading' || (type === 'quiz' && quizTab === 'questions')}>
      {!item && (
        <div className="seg" role="group" aria-label="Loại mục" style={{ alignSelf: 'flex-start' }}>
          {(['video', 'slide', 'reading', 'quiz'] as ItemType[]).map((t) => (
            <button type="button" key={t} className={type === t ? 'on' : ''} aria-pressed={type === t} onClick={() => setType(t)}>
              <Icon name={TYPE_ICON[t]} size={16} /> {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
      )}

      {/* Nút Toggle giữa Tổng quát và Danh sách câu hỏi cho Quiz */}
      {type === 'quiz' && (
        <div 
          className="seg" 
          role="group" 
          style={{ 
            alignSelf: 'flex-start', 
            width: 'fit-content', 
            display: 'inline-flex',
            marginBottom: 8 
          }}
        >
          <button 
            type="button" 
            className={quizTab === 'general' ? 'on' : ''} 
            onClick={() => setQuizTab('general')}
          >
            Tổng quát
          </button>
          <button 
            type="button" 
            className={quizTab === 'questions' ? 'on' : ''} 
            onClick={() => setQuizTab('questions')}
          >
            Danh sách câu hỏi ({approvedQuestions.length})
          </button>
        </div>
      )}

      {/* Hiển thị tiêu đề khi không ở tab danh sách câu hỏi */}
      {(type !== 'quiz' || quizTab === 'general') && (
        <Field label="Tiêu đề"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="VD: Video bài giảng — Lớp và đối tượng" /></Field>
      )}

      {type === 'video' && (
        <Field label="Video" hint="Tải video mới ở mục Video, rồi chọn ở đây. Câu hỏi giữa video quản lý theo video.">
          {videos.loading ? <Spinner /> : (
            <select value={videoId} onChange={(e) => setVideoId(e.target.value)}>
              <option value="">— Chọn video —</option>
              {videos.data?.map((v) => (
                <option key={v.video_id} value={v.video_id}>
                  {v.title} ({v.video_id}){!v.has_file ? ' · chưa có file' : ''}{v.transcript ? '' : ' · chưa có transcript'} · {v.questions.approved} câu hỏi
                </option>
              ))}
            </select>
          )}
        </Field>
      )}

      {type === 'slide' && (
        <>
          <Field label="Tài liệu slide của bài" hint="PDF hiển thị đúng như bản gốc; PPTX hiển thị dạng chữ theo từng slide.">
            <select value={docId} onChange={(e) => setDocId(e.target.value)}>
              <option value="">— Chọn tài liệu —</option>
              {docs.data?.filter((d) => ['pdf', 'pptx'].includes(d.source_type)).map((d) => (
                <option key={d.document_id} value={d.document_id}>{d.title} · {d.source_type.toUpperCase()} · {d.status}</option>
              ))}
            </select>
          </Field>
          <Field label="…hoặc tải file mới (PDF/PPTX)">
            <input type="file" accept=".pdf,.pptx" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadSlide(f); }} />
          </Field>
          {upload && <p className="small" style={{ fontWeight: 700 }} aria-live="polite">{upload}</p>}
          <Field label="Ghi chú của giảng viên (hiện dưới slide)"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </>
      )}

      {type === 'reading' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="field-label" style={{ fontWeight: 800, fontSize: 14 }}>Nội dung (Markdown)</span>
            <div className="seg" role="group" aria-label="Chế độ soạn">
              <button type="button" className={!preview ? 'on' : ''} onClick={() => setPreview(false)}>Soạn</button>
              <button type="button" className={preview ? 'on' : ''} onClick={() => setPreview(true)}>Xem trước</button>
            </div>
          </div>
          {full.loading ? <Spinner /> : preview
            ? <div className="card" style={{ maxHeight: 420, overflow: 'auto' }}><Markdown source={content} /></div>
            : <textarea className="input" style={{ minHeight: 360, fontFamily: 'var(--mono)', fontSize: 14 }} value={content} onChange={(e) => setMd(e.target.value)}
                placeholder={'# Tiêu đề\n\n## Mục 1\nNội dung…\n\n```java\nclass A {}\n```'} aria-label="Nội dung Markdown" />}
          <span className="field-hint">Khi lưu, bài đọc được nạp vào Knowledge Base để Tutor trả lời và trích nguồn.</span>
        </>
      )}

      {/* QUIZ - TAB TỔNG QUÁT */}
      {type === 'quiz' && quizTab === 'general' && (
        <>
          <div className="form-grid">
            <Field label="Số câu mỗi lượt"><input type="number" min={1} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} /></Field>
            <Field label="Ngưỡng qua bài (%)"><input type="number" min={10} max={100} step={5} value={passPct} onChange={(e) => setPassPct(Number(e.target.value))} /></Field>
            <Field label="Giới hạn thời gian (phút)" hint="0 = không giới hạn. Hết giờ bài tự nộp."><input type="number" min={0} max={240} value={timeLimit} onChange={(e) => setTimeLimit(Number(e.target.value))} /></Field>
          </div>
          <p className="muted small" style={{ fontWeight: 700 }}>
            Câu hỏi lấy ngẫu nhiên từ ngân hàng câu hỏi <b>đã duyệt</b> của bài {lesson.code}. Sinh và duyệt câu hỏi ở mục <Link to="/teach/questions">Câu hỏi</Link>.
          </p>
        </>
      )}

      {/* QUIZ - TAB DANH SÁCH CÂU HỎI */}
      {type === 'quiz' && quizTab === 'questions' && (
        <div className="col" style={{ gap: 12, minHeight: 250, maxHeight: 420, overflowY: 'auto', padding: '4px' }}>
          {bank.loading && <Spinner />}
          {bank.error && <ErrorBox message={bank.error} onRetry={bank.reload} />}
          {!bank.loading && approvedQuestions.length === 0 && (
            <Empty title="Chưa có câu hỏi nào">
              Bài học này chưa có câu hỏi nào được duyệt vào bài kiểm tra. Hãy bấm biểu tượng dấu cộng (+) ở mục học này ngoài giao diện để thêm câu hỏi.
            </Empty>
          )}
          {approvedQuestions.map((q, idx) => (
            <div 
              key={q.item_id} 
              className="col" // Gỡ bỏ class "card" ở đây để sửa lỗi cắt chữ
              style={{ 
                padding: 16, 
                gap: 8, 
                background: 'var(--bg-soft)',
                border: '1px solid var(--border)', // Thêm viền thay cho card
                borderRadius: 8,
                cursor: 'pointer', // Đổi con trỏ chuột thành hình bàn tay
                transition: 'border-color 0.2s, background 0.2s'
              }}
              title="Nhấn để xem và sửa chi tiết trong Ngân hàng câu hỏi"
              // Hiệu ứng hover đơn giản
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--green)'; e.currentTarget.style.background = 'var(--bg)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'var(--bg-soft)'; }}
              // Sự kiện click điều hướng và truyền dữ liệu qua URL
              onClick={() => {
                const targetLesson = lesson.code || lesson.lesson_id;
                navigate(`/teach/questions?lesson=${targetLesson}&focus=${q.item_id}`);
                onClose(); // Đóng modal hiện tại
              }}
            >
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <strong style={{ fontSize: 14, lineHeight: 1.5 }}>
                  Câu {idx + 1}: {q.question}
                </strong>
                {q.difficulty && (
                  <Badge tone={q.difficulty === 'easy' ? 'green' : q.difficulty === 'hard' ? 'red' : 'blue'}>
                    {q.difficulty === 'easy' ? 'Dễ' : q.difficulty === 'hard' ? 'Khó' : 'Vừa'}
                  </Badge>
                )}
              </div>

              {Array.isArray(q.options) && q.options.length > 0 && (
                <div className="col" style={{ gap: 6, paddingLeft: 8, marginTop: 4 }}>
                  {q.options.map((opt, oIdx) => {
                    const isCorrect = opt === q.answer;
                    return (
                      <div 
                        key={oIdx} 
                        className="row" 
                        style={{ 
                          fontSize: 13, 
                          color: isCorrect ? 'var(--green)' : undefined, 
                          fontWeight: isCorrect ? 700 : 400 
                        }}
                      >
                        <span style={{ minWidth: 24 }}>{String.fromCharCode(65 + oIdx)}.</span>
                        <span>{opt} {isCorrect && '✓ (Đáp án đúng)'}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {q.explanation && (
                <div className="small muted" style={{ fontStyle: 'italic', borderTop: '1px dashed var(--border)', paddingTop: 8, marginTop: 4 }}>
                  Giải thích: {q.explanation}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </FormModal>
  );
}
