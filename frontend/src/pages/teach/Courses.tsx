import { useState, type ReactNode } from 'react';
import { PageHeader } from '../../components/AppShell';
import { Icon } from '../../components/Icon';
import { Markdown } from '../../components/Markdown';
import { Badge, Button, Empty, ErrorBox, Field, IconButton, Modal, Spinner, useToast } from '../../components/ui';
import { api, errorText, pollJob, type ItemType } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { Link, navigate } from '../../lib/router';
import { TYPE_ICON, TYPE_LABEL } from '../Learn';

interface AdminItem { item_id: string; type: ItemType; title: string; position: number; video_id: string | null; document_id: string | null; meta: any; has_content: boolean }
interface AdminLesson { lesson_id: string; code: string; title: string; description?: string; items: AdminItem[] }
interface AdminCourse { course_id: string; code: string; title: string; description?: string; class_id: string | null; chapters: { chapter_id: string; title: string; lessons: AdminLesson[] }[] }
interface CourseRow { course_id: string; code: string; title: string; class_id: string | null; chapters: number; items: number }
interface VideoRow { video_id: string; title: string; has_file: boolean; transcript: { version: number } | null; questions: { approved: number; draft: number } }
interface DocRow { document_id: string; title: string; source_type: string; status: string; lesson_id: string | null }

// ---------------------------------------------------------------- Danh sách khóa học

export function Courses() {
  const list = useAsync((s) => api<CourseRow[]>('/ai/courses', { signal: s }), []);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: '', title: '', description: '', class_id: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const c = await api<AdminCourse>('/ai/courses', { json: { ...form, class_id: form.class_id || null } });
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
      <div className="col" style={{ gap: 12 }}>
        {list.data?.map((c) => (
          <Link key={c.course_id} to={`/teach/courses/${c.course_id}`} className="video-card">
            <span className="video-thumb" style={{ background: 'var(--green)' }}><Icon name="list" size={26} /></span>
            <span className="col" style={{ gap: 2, flex: 1, minWidth: 0 }}>
              <strong style={{ fontSize: 17 }}>{c.title}</strong>
              <span className="muted small">{c.code} · {c.chapters} chương · {c.items} mục học{c.class_id ? ` · lớp ${c.class_id}` : ' · mọi lớp'}</span>
            </span>
            <Icon name="chevronRight" />
          </Link>
        ))}
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="Tạo khóa học">
        <div className="modal-body">
          <div className="form-grid">
            <Field label="Mã khóa học" hint="Chữ, số, dấu gạch. VD: OOP-K66"><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
            <Field label="Lớp (tùy chọn)" hint="Để trống = mọi lớp"><input value={form.class_id} onChange={(e) => setForm({ ...form, class_id: e.target.value })} /></Field>
          </div>
          <Field label="Tên khóa học"><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          <Field label="Mô tả"><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          {err && <ErrorBox message={err} />}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setOpen(false)}>Hủy</Button>
            <Button loading={busy} disabled={!form.code.trim() || !form.title.trim()} onClick={create}>Tạo</Button>
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

export function CourseEditor({ courseId }: { courseId: string }) {
  const toast = useToast();
  const tree = useAsync((s) => api<AdminCourse>(`/ai/courses/${courseId}`, { signal: s }), [courseId]);
  const [dlg, setDlg] = useState<Dialog | null>(null);

  const run = async (p: Promise<AdminCourse>, msg?: string) => {
    try { tree.setData(await p); if (msg) toast(msg, 'success'); } catch (e) { toast(errorText(e), 'error'); }
  };
  const move = (kind: 'chapters' | 'lessons' | 'items', id: string, direction: number) =>
    run(api<AdminCourse>(`/ai/${kind}/${id}/move`, { json: { direction } }));
  const del = (kind: 'chapters' | 'lessons' | 'items', id: string, label: string) => {
    if (!window.confirm(`Xóa ${label}? Tiến độ học sinh của phần này cũng bị xóa.`)) return;
    run(api<AdminCourse>(`/ai/${kind}/${id}`, { method: 'DELETE' }), 'Đã xóa');
  };
  const delCourse = async () => {
    if (!window.confirm('Xóa toàn bộ khóa học này?')) return;
    try { await api(`/ai/courses/${courseId}`, { method: 'DELETE' }); navigate('/teach/courses'); } catch (e) { toast(errorText(e), 'error'); }
  };

  const c = tree.data;
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}><Link to="/teach/courses" className="muted small" style={{ fontWeight: 800 }}>← Tất cả khóa học</Link></div>
      <PageHeader title={c?.title || 'Đang tải…'} sub={c ? `${c.code}${c.class_id ? ` · lớp ${c.class_id}` : ' · mọi lớp'}${c.description ? ` · ${c.description}` : ''}` : undefined}
        actions={c && <>
          <Button variant="ghost" icon="edit" onClick={() => setDlg({ kind: 'course' })}>Sửa thông tin</Button>
          <Button variant="ghost" icon="play" onClick={() => navigate(`/learn/${c.course_id}`)}>Xem như học sinh</Button>
          <Button icon="plus" onClick={() => setDlg({ kind: 'chapter' })}>Thêm chương</Button>
        </>} />
      {tree.loading && !c && <Spinner />}
      {tree.error && <ErrorBox message={tree.error} onRetry={tree.reload} />}
      {c && !c.chapters.length && <Empty title="Khóa học chưa có chương nào">Thêm chương, sau đó thêm bài và các mục học.</Empty>}
      <div className="col" style={{ gap: 16 }}>
        {c?.chapters.map((ch, ci) => (
          <section key={ch.chapter_id} className="tree-chapter" aria-label={`Chương ${ci + 1}`}>
            <div className="row">
              <Badge tone="green">Chương {ci + 1}</Badge>
              <h2 style={{ fontSize: 19, flex: 1 }}>{ch.title}</h2>
              <Reorder onUp={() => move('chapters', ch.chapter_id, -1)} onDown={() => move('chapters', ch.chapter_id, 1)} first={ci === 0} last={ci === c.chapters.length - 1} />
              <IconButton icon="edit" label="Đổi tên chương" onClick={() => setDlg({ kind: 'chapter', chapterId: ch.chapter_id, title: ch.title })} />
              <IconButton icon="trash" label="Xóa chương" onClick={() => del('chapters', ch.chapter_id, `chương “${ch.title}”`)} />
            </div>
            {ch.lessons.map((ls, li) => (
              <div key={ls.lesson_id} className="tree-lesson">
                <div className="row">
                  <strong style={{ flex: 1, fontSize: 16 }}>{ls.title} <span className="muted small">· {ls.code}</span></strong>
                  <Reorder onUp={() => move('lessons', ls.lesson_id, -1)} onDown={() => move('lessons', ls.lesson_id, 1)} first={li === 0} last={li === ch.lessons.length - 1} />
                  <IconButton icon="edit" label="Sửa bài" onClick={() => setDlg({ kind: 'lesson', chapterId: ch.chapter_id, lesson: ls })} />
                  <IconButton icon="trash" label="Xóa bài" onClick={() => del('lessons', ls.lesson_id, `bài “${ls.title}”`)} />
                </div>
                {ls.items.map((it, ii) => (
                  <div key={it.item_id} className="tree-item">
                    <span className={`type-ico type-${it.type}`}><Icon name={TYPE_ICON[it.type]} size={18} /></span>
                    <strong>{it.title}</strong>
                    <span className="muted small">{itemMeta(it)}</span>
                    <Reorder onUp={() => move('items', it.item_id, -1)} onDown={() => move('items', it.item_id, 1)} first={ii === 0} last={ii === ls.items.length - 1} />
                    {it.type === 'video' && it.video_id && <IconButton icon="question" label="Quản lý câu hỏi video" onClick={() => navigate(`/teach/videos/${encodeURIComponent(it.video_id!)}`)} />}
                    <IconButton icon="edit" label="Sửa mục" onClick={() => setDlg({ kind: 'item', lesson: ls, item: it })} />
                    <IconButton icon="trash" label="Xóa mục" onClick={() => del('items', it.item_id, `mục “${it.title}”`)} />
                  </div>
                ))}
                <div><Button size="sm" variant="ghost" icon="plus" onClick={() => setDlg({ kind: 'item', lesson: ls })}>Thêm mục học</Button></div>
              </div>
            ))}
            <div><Button size="sm" variant="soft" icon="plus" onClick={() => setDlg({ kind: 'lesson', chapterId: ch.chapter_id })}>Thêm bài</Button></div>
          </section>
        ))}
      </div>
      {c && <div className="row" style={{ marginTop: 28 }}><Button variant="danger-ghost" icon="trash" onClick={delCourse}>Xóa khóa học</Button></div>}

      {c && dlg?.kind === 'course' && <CourseDialog course={c} onClose={() => setDlg(null)} onSaved={(t) => { tree.setData(t); setDlg(null); }} />}
      {c && dlg?.kind === 'chapter' && (
        <TitleDialog title={dlg.chapterId ? 'Đổi tên chương' : 'Thêm chương'} initial={dlg.title || ''} onClose={() => setDlg(null)}
          onSave={async (title) => {
            const t = dlg.chapterId
              ? await api<AdminCourse>(`/ai/chapters/${dlg.chapterId}`, { method: 'PATCH', json: { title } })
              : await api<AdminCourse>(`/ai/courses/${c.course_id}/chapters`, { json: { title } });
            tree.setData(t); setDlg(null);
          }} />
      )}
      {c && dlg?.kind === 'lesson' && <LessonDialog course={c} chapterId={dlg.chapterId} lesson={dlg.lesson} onClose={() => setDlg(null)} onSaved={(t) => { tree.setData(t); setDlg(null); }} />}
      {c && dlg?.kind === 'item' && <ItemDialog course={c} lesson={dlg.lesson} item={dlg.item} onClose={() => setDlg(null)} onSaved={(t) => { tree.setData(t); setDlg(null); toast('Đã lưu mục học', 'success'); }} />}
    </>
  );
}

function itemMeta(it: AdminItem) {
  if (it.type === 'video') return it.video_id || 'chưa gắn video';
  if (it.type === 'slide') return it.document_id ? `${it.meta?.pages ? `${it.meta.pages} trang` : 'tài liệu'}` : 'chưa gắn file';
  if (it.type === 'reading') return it.has_content ? 'đã có nội dung' : 'chưa có nội dung';
  return `${it.meta?.count ?? 5} câu · qua ${Math.round((it.meta?.pass_ratio ?? 0.8) * 100)}%`;
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

function CourseDialog({ course, onClose, onSaved }: { course: AdminCourse; onClose: () => void; onSaved: (c: AdminCourse) => void }) {
  const [f, setF] = useState({ title: course.title, description: course.description || '', class_id: course.class_id || '' });
  return (
    <FormModal title="Thông tin khóa học" onClose={onClose} canSave={!!f.title.trim()}
      onSave={async () => onSaved(await api<AdminCourse>(`/ai/courses/${course.course_id}`, { method: 'PATCH', json: f }))}>
      <Field label="Tên khóa học"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="Lớp" hint="Chỉ học sinh thuộc lớp này thấy khóa học"><input value={f.class_id} onChange={(e) => setF({ ...f, class_id: e.target.value })} /></Field>
      <Field label="Mô tả"><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
    </FormModal>
  );
}

function LessonDialog({ course, chapterId, lesson, onClose, onSaved }: { course: AdminCourse; chapterId: string; lesson?: AdminLesson; onClose: () => void; onSaved: (c: AdminCourse) => void }) {
  const [f, setF] = useState({ code: lesson?.code || '', title: lesson?.title || '', description: lesson?.description || '' });
  return (
    <FormModal title={lesson ? 'Sửa bài học' : 'Thêm bài học'} onClose={onClose} canSave={!!f.title.trim() && !!f.code.trim()}
      onSave={async () => onSaved(lesson
        ? await api<AdminCourse>(`/ai/lessons/${lesson.lesson_id}`, { method: 'PATCH', json: { title: f.title, description: f.description } })
        : await api<AdminCourse>(`/ai/chapters/${chapterId}/lessons`, { json: f }))}>
      <Field label="Mã bài học" hint={lesson ? 'Không đổi được — tài liệu và transcript gắn theo mã này.' : `Dùng làm lesson_id trong Knowledge Base. VD: ${course.code}-B01`}>
        <input value={f.code} disabled={!!lesson} onChange={(e) => setF({ ...f, code: e.target.value })} />
      </Field>
      <Field label="Tên bài"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="Mô tả ngắn"><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
    </FormModal>
  );
}

function ItemDialog({ course, lesson, item, onClose, onSaved }: { course: AdminCourse; lesson: AdminLesson; item?: AdminItem; onClose: () => void; onSaved: (c: AdminCourse) => void }) {
  const [type, setType] = useState<ItemType>(item?.type || 'video');
  const [title, setTitle] = useState(item?.title || '');
  const [videoId, setVideoId] = useState(item?.video_id || '');
  const [docId, setDocId] = useState(item?.document_id || '');
  const [notes, setNotes] = useState(item?.meta?.notes || '');
  const [count, setCount] = useState<number>(item?.meta?.count ?? 5);
  const [passPct, setPassPct] = useState<number>(Math.round((item?.meta?.pass_ratio ?? 0.8) * 100));
  const [preview, setPreview] = useState(false);
  const full = useAsync((s) => (item ? api<{ content_md: string | null }>(`/ai/items/${item.item_id}`, { signal: s }) : Promise.resolve({ content_md: '' })), [item?.item_id]);
  const [md, setMd] = useState<string | null>(null);
  const content = md ?? full.data?.content_md ?? '';
  const videos = useAsync((s) => (type === 'video' ? api<VideoRow[]>('/ai/media/videos', { signal: s }) : Promise.resolve([] as VideoRow[])), [type]);
  const docs = useAsync((s) => (type === 'slide' ? api<DocRow[]>(`/ai/documents?lesson_id=${encodeURIComponent(lesson.code)}`, { signal: s }) : Promise.resolve([] as DocRow[])), [type]);
  const [upload, setUpload] = useState<string | null>(null);

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
    if (type === 'quiz') { body.count = count; body.pass_ratio = passPct / 100; }
    onSaved(item
      ? await api<AdminCourse>(`/ai/items/${item.item_id}`, { method: 'PATCH', json: body })
      : await api<AdminCourse>(`/ai/lessons/${lesson.lesson_id}/items`, { json: body }));
  };

  return (
    <FormModal title={item ? `Sửa mục · ${TYPE_LABEL[type]}` : `Thêm mục vào “${lesson.title}”`} onClose={onClose} onSave={save} canSave={valid} wide={type === 'reading'}>
      {!item && (
        <div className="seg" role="group" aria-label="Loại mục" style={{ alignSelf: 'flex-start' }}>
          {(['video', 'slide', 'reading', 'quiz'] as ItemType[]).map((t) => (
            <button type="button" key={t} className={type === t ? 'on' : ''} aria-pressed={type === t} onClick={() => setType(t)}>
              <Icon name={TYPE_ICON[t]} size={16} /> {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
      )}
      <Field label="Tiêu đề"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="VD: Video bài giảng — Lớp và đối tượng" /></Field>

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

      {type === 'quiz' && (
        <>
          <div className="form-grid">
            <Field label="Số câu mỗi lượt"><input type="number" min={1} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} /></Field>
            <Field label="Ngưỡng qua bài (%)"><input type="number" min={10} max={100} step={5} value={passPct} onChange={(e) => setPassPct(Number(e.target.value))} /></Field>
          </div>
          <p className="muted small" style={{ fontWeight: 700 }}>
            Câu hỏi lấy ngẫu nhiên từ ngân hàng câu hỏi <b>đã duyệt</b> của bài {lesson.code}. Sinh và duyệt câu hỏi ở mục <Link to="/teach/questions">Câu hỏi</Link>.
          </p>
        </>
      )}
    </FormModal>
  );
}
