import { useState } from 'react';
import { PageHeader } from '../../components/AppShell';
import { Badge, Button, Empty, ErrorBox, Field, IconButton, Modal, Spinner, useToast } from '../../components/ui';
import { api, errorText } from '../../lib/api';
import { useAsync } from '../../lib/hooks';

interface BankItem {
  item_id: string; generation_id: string | null; status: string; edited: boolean; lesson_id: string | null; created_at: string;
  question: string; type: string; difficulty: string; options?: string[] | null; correct_answer?: string; correct_index?: number | null; explanation?: string; sources?: string[];
}
interface Stats { reviewed: number; approved: number; approved_without_edit: number; approved_with_edit: number; rejected: number; pending: number; acceptance_rate: number | null }
interface TeachingSource { document_id: string; title: string; kind: 'video' | 'reading' | 'slide' | 'document' }
const SOURCE_KIND = { video: 'Video', reading: 'Bài đọc', slide: 'Slide', document: 'Tài liệu' };

/** Danh sách mã bài học từ các khóa học (dùng cho ô chọn). */
export function useLessonCodes() {
  return useAsync(async (s) => {
    const courses = await api<{ course_id: string; title: string }[]>('/ai/courses', { signal: s });
    const trees = await Promise.all(courses.map((c) => api<{ title: string; chapters: { lessons: { code: string; title: string }[] }[] }>(`/ai/courses/${c.course_id}`, { signal: s })));
    return trees.flatMap((t) => t.chapters.flatMap((ch) => ch.lessons.map((l) => ({ code: l.code, title: l.title, course: t.title }))));
  }, []);
}

export function LessonSelect({ value, onChange, allowAll }: { value: string; onChange: (v: string) => void; allowAll?: boolean }) {
  const lessons = useLessonCodes();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {allowAll ? <option value="">Tất cả bài</option> : <option value="">— Chọn bài học —</option>}
      {lessons.data?.map((l) => <option key={l.code} value={l.code}>{l.course} · {l.title}</option>)}
    </select>
  );
}

const DIFF: Record<string, string> = { easy: 'Dễ', medium: 'Vừa', hard: 'Khó' };
const TYPE: Record<string, string> = { multiple_choice: 'Trắc nghiệm', true_false: 'Đúng/Sai', short_answer: 'Tự luận ngắn' };

export function QuestionBank() {
  const toast = useToast();
  const [lesson, setLesson] = useState('');
  const [status, setStatus] = useState('');
  const bank = useAsync((s) => api<BankItem[]>(`/ai/teacher/question-bank?${new URLSearchParams({ ...(lesson && { lesson_id: lesson }), ...(status && { status }) })}`, { signal: s }), [lesson, status]);
  const stats = useAsync((s) => api<Stats>('/ai/teacher/stats', { signal: s }), []);
  const [genOpen, setGenOpen] = useState(false);
  const [edit, setEdit] = useState<BankItem | null>(null);

  const setSt = async (it: BankItem, st: string) => {
    try { await api(`/ai/question-bank/${it.item_id}`, { method: 'PATCH', json: { status: st } }); bank.reload(); stats.reload(); } catch (e) { toast(errorText(e), 'error'); }
  };
  const approveAll = async () => {
    const drafts = bank.data?.filter((x) => x.status === 'draft') || [];
    for (const d of drafts) { try { await api(`/ai/question-bank/${d.item_id}`, { method: 'PATCH', json: { status: 'approved' } }); } catch { /* bỏ qua */ } }
    toast(`Đã duyệt ${drafts.length} câu`, 'success'); bank.reload(); stats.reload();
  };

  const st = stats.data;
  return (
    <>
      <PageHeader title="Ngân hàng câu hỏi" sub="AI soạn câu hỏi từ tài liệu của bài; giáo viên sửa và duyệt. Bài kiểm tra cuối bài lấy từ các câu đã duyệt."
        actions={<Button icon="wand" onClick={() => setGenOpen(true)}>AI soạn câu hỏi</Button>} />
      {st && (
        <div className="stat-tiles">
          <div className="tile"><strong>{st.approved}</strong><span>Đã duyệt</span></div>
          <div className="tile"><strong>{st.pending}</strong><span>Chờ duyệt</span></div>
          <div className="tile"><strong>{st.rejected}</strong><span>Đã từ chối</span></div>
          <div className="tile"><strong>{st.acceptance_rate != null ? `${Math.round(st.acceptance_rate * 100)}%` : '—'}</strong><span>Tỉ lệ chấp nhận ({st.approved_without_edit} không cần sửa)</span></div>
        </div>
      )}
      <div className="row" style={{ marginBottom: 14, alignItems: 'flex-end' }}>
        <Field label="Bài học"><LessonSelect value={lesson} onChange={setLesson} allowAll /></Field>
        <Field label="Trạng thái">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Tất cả</option><option value="draft">Nháp</option><option value="approved">Đã duyệt</option><option value="rejected">Từ chối</option>
          </select>
        </Field>
        <span style={{ flex: 1 }} />
        {!!bank.data?.some((x) => x.status === 'draft') && <Button variant="soft" icon="check" onClick={approveAll}>Duyệt tất cả câu nháp đang hiện</Button>}
      </div>
      {bank.loading && !bank.data && <Spinner />}
      {bank.error && <ErrorBox message={bank.error} onRetry={bank.reload} />}
      {bank.data && !bank.data.length && <Empty title="Chưa có câu hỏi">Bấm “AI soạn câu hỏi” và chọn bài học.</Empty>}
      <div className="col" style={{ gap: 12 }}>
        {bank.data?.map((q) => (
          <div key={q.item_id} className="qcard">
            <div className="row" style={{ gap: 6 }}>
              <Badge tone={q.status === 'approved' ? 'green' : q.status === 'rejected' ? 'red' : 'yellow'}>{q.status === 'approved' ? 'Đã duyệt' : q.status === 'rejected' ? 'Từ chối' : 'Nháp'}</Badge>
              <Badge>{TYPE[q.type] || q.type}</Badge>
              <Badge tone="purple">{DIFF[q.difficulty] || q.difficulty}</Badge>
              {q.lesson_id && <Badge tone="blue">{q.lesson_id}</Badge>}
              {q.edited && <Badge tone="orange">Đã sửa</Badge>}
            </div>
            <h3>{q.question}</h3>
            {q.options?.length ? (
              <div className="qcard-opts">{q.options.map((o, i) => <div key={i} className={`qcard-opt ${(q.correct_index ?? q.options!.indexOf(q.correct_answer || '')) === i ? 'ok' : ''}`}>{o}</div>)}</div>
            ) : q.correct_answer ? <p className="small"><b>Đáp án:</b> {q.correct_answer}</p> : null}
            {q.explanation && <p className="muted small" style={{ fontWeight: 700 }}>{q.explanation}</p>}
            {!!q.sources?.length && <p className="muted small">Nguồn: {q.sources.join(', ')}</p>}
            <div className="row">
              {q.status !== 'approved' && <Button size="sm" icon="check" onClick={() => setSt(q, 'approved')}>Duyệt</Button>}
              {q.status !== 'rejected' && <Button size="sm" variant="danger-ghost" onClick={() => setSt(q, 'rejected')}>Từ chối</Button>}
              <IconButton icon="edit" label="Sửa câu hỏi" onClick={() => setEdit(q)} />
            </div>
          </div>
        ))}
      </div>
      {genOpen && <GenerateDialog defaultLesson={lesson} onClose={() => setGenOpen(false)} onDone={(code) => { setGenOpen(false); setLesson(code); setStatus('draft'); bank.reload(); stats.reload(); }} />}
      {edit && <BankEditor item={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); bank.reload(); stats.reload(); }} />}
    </>
  );
}

function GenerateDialog({ defaultLesson, onClose, onDone }: { defaultLesson: string; onClose: () => void; onDone: (lesson: string) => void }) {
  const toast = useToast();
  const [lesson, setLesson] = useState(defaultLesson);
  const [selected, setSelected] = useState<string[]>([]);
  const sources = useAsync(async (s) => ({ lesson, items: lesson
    ? await api<TeachingSource[]>(`/ai/teacher/sources?lesson_id=${encodeURIComponent(lesson)}`, { signal: s }) : [] }), [lesson]);
  const available = sources.data?.lesson === lesson ? sources.data.items : [];
  const selectedIds = selected.filter((id) => available.some((source) => source.document_id === id));
  const [count, setCount] = useState(5);
  const [focus, setFocus] = useState('');
  const [types, setTypes] = useState<string[]>(['multiple_choice']);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ generated: number; requested: number }>('/ai/teacher/generate-quiz', { json: { lesson_id: lesson,
        document_ids: selectedIds, count, question_types: types, context_query: focus || null } });
      toast(`AI đã soạn ${r.generated}/${r.requested} câu — hãy xem lại và duyệt`, 'success');
      onDone(lesson);
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  const toggle = (t: string) => setTypes((xs) => (xs.includes(t) ? xs.filter((x) => x !== t) : [...xs, t]));
  return (
    <Modal open onClose={onClose} title="AI soạn câu hỏi" dismissable={!busy}>
      <form className="modal-body" onSubmit={(e) => { e.preventDefault(); if (lesson && types.length && selectedIds.length && !sources.loading && !busy) run(); }}>
        <Field label="Bài học"><LessonSelect value={lesson} onChange={(code) => { setLesson(code); setSelected([]); }} /></Field>
        {lesson && <fieldset className="card col" style={{ gap: 10 }} disabled={busy}>
          <legend className="field-label">Nguồn để AI soạn câu hỏi</legend>
          <p className="small muted" style={{ margin: 0 }}>Chọn một hoặc nhiều nguồn. AI chỉ đọc nội dung đã chọn.</p>
          {sources.loading && <Spinner />}
          {sources.error && <ErrorBox message={sources.error} onRetry={sources.reload} />}
          {!sources.loading && !sources.error && !available.length && <p className="small muted">
            Chưa có nguồn sẵn sàng. Thêm slide, bài đọc hoặc video có phụ đề vào bài học trước.
          </p>}
          {available.length > 0 && <>
            <div className="row">
              <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(available.map((s) => s.document_id))}>Chọn tất cả</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setSelected([])}>Bỏ chọn</Button>
              <span className="small muted">Đã chọn {selectedIds.length}/{available.length} nguồn</span>
            </div>
            <div className="col" style={{ gap: 10, maxHeight: 220, overflowY: 'auto' }}>
              {available.map((source) => <label key={source.document_id} className="check">
                <input type="checkbox" checked={selectedIds.includes(source.document_id)} onChange={(e) => setSelected((ids) =>
                  e.target.checked ? [...ids, source.document_id] : ids.filter((id) => id !== source.document_id))} />
                <span><b>{SOURCE_KIND[source.kind]}</b> · {source.title}</span>
              </label>)}
            </div>
          </>}
        </fieldset>}
        <div className="form-grid">
          <Field label="Số câu"><input type="number" min={1} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} /></Field>
          <Field label="Tập trung vào (tùy chọn)"><input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="VD: tính đóng gói" /></Field>
        </div>
        <div className="row">
          {Object.entries(TYPE).map(([k, v]) => <label key={k} className="check"><input type="checkbox" checked={types.includes(k)} onChange={() => toggle(k)} />{v}</label>)}
        </div>
        {busy && <p className="small" style={{ fontWeight: 700 }}>AI đang đọc tài liệu và soạn câu hỏi, có thể mất 10–40 giây…</p>}
        {err && <ErrorBox message={err} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Hủy</Button>
          <Button type="submit" icon="wand" loading={busy} disabled={!lesson || !types.length || !selectedIds.length || sources.loading || !!sources.error}>Soạn câu hỏi</Button>
        </div>
      </form>
    </Modal>
  );
}

function BankEditor({ item, onClose, onSaved }: { item: BankItem; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ question: item.question, options: item.options || [], correct_answer: item.correct_answer || '', explanation: item.explanation || '', difficulty: item.difficulty });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async (approve: boolean) => {
    setBusy(true); setErr(null);
    try {
      await api(`/ai/question-bank/${item.item_id}`, { method: 'PATCH', json: { question: f.question, options: f.options.length ? f.options : null, correct_answer: f.correct_answer, explanation: f.explanation, difficulty: f.difficulty, ...(approve && { status: 'approved' }) } });
      onSaved();
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Sửa câu hỏi" wide dismissable={!busy}>
      <div className="modal-body">
        <Field label="Câu hỏi"><textarea value={f.question} onChange={(e) => setF({ ...f, question: e.target.value })} /></Field>
        {f.options.length > 0 && (
          <fieldset className="col" style={{ gap: 8, border: 'none', padding: 0 }}>
            <legend className="field-label" style={{ fontWeight: 800, fontSize: 14, marginBottom: 6 }}>Lựa chọn (chọn đáp án đúng)</legend>
            {f.options.map((o, i) => (
              <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
                <input type="radio" name="bank-correct" aria-label={`Đáp án đúng là lựa chọn ${i + 1}`} checked={f.correct_answer === o} onChange={() => setF({ ...f, correct_answer: o })} style={{ width: 20, height: 20, accentColor: 'var(--green)' }} />
                <input className="input" value={o} aria-label={`Lựa chọn ${i + 1}`} onChange={(e) => {
                  const n = [...f.options]; const wasCorrect = f.correct_answer === n[i]; n[i] = e.target.value;
                  setF({ ...f, options: n, correct_answer: wasCorrect ? e.target.value : f.correct_answer });
                }} />
              </div>
            ))}
          </fieldset>
        )}
        {f.options.length === 0 && <Field label="Đáp án"><textarea value={f.correct_answer} onChange={(e) => setF({ ...f, correct_answer: e.target.value })} /></Field>}
        <div className="form-grid">
          <Field label="Độ khó">
            <select value={f.difficulty} onChange={(e) => setF({ ...f, difficulty: e.target.value })}>
              <option value="easy">Dễ</option><option value="medium">Vừa</option><option value="hard">Khó</option>
            </select>
          </Field>
        </div>
        <Field label="Giải thích"><textarea value={f.explanation} onChange={(e) => setF({ ...f, explanation: e.target.value })} /></Field>
        {err && <ErrorBox message={err} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Hủy</Button>
          <Button variant="soft" loading={busy} onClick={() => save(false)}>Lưu</Button>
          {item.status !== 'approved' && <Button icon="check" loading={busy} onClick={() => save(true)}>Lưu & duyệt</Button>}
        </div>
      </div>
    </Modal>
  );
}
