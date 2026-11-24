import { Fragment, useState, useEffect } from 'react';
import { PageHeader } from '../../components/AppShell';
import { Button, Empty, ErrorBox, Field, IconButton, Modal, Spinner, useToast } from '../../components/ui';
import { api, apiBlob, errorText } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { ManualCreateDialog } from '../../components/ManualCreateDialog';
import { Icon } from '../../components/Icon';
import { BulkBar, Check, FilterPills, KpiRow, PillSelect, SearchBox, StatusTag, Toolbar, useSelection } from '../../components/Manage';

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

  const getUrlParams = () => {
    const hash = window.location.hash;
    const query = hash.includes('?') ? hash.substring(hash.indexOf('?')) : '';
    return new URLSearchParams(query);
  };

  const [lesson, setLesson] = useState(() => getUrlParams().get('lesson') || '');
  const [status, setStatus] = useState('');
  const [q_, setQ] = useState('');
  const [typeF, setTypeF] = useState('');
  const [srcF, setSrcF] = useState('');
  const lessons = useLessonCodes();

  const bank = useAsync((s) => api<BankItem[]>(`/ai/teacher/question-bank?${new URLSearchParams({ ...(lesson && { lesson_id: lesson }), ...(status && { status }) })}`, { signal: s }), [lesson, status]);
  const stats = useAsync((s) => api<Stats>('/ai/teacher/stats', { signal: s }), [], 'teach/qstats');

  useEffect(() => {
    const focusId = getUrlParams().get('focus');
    if (focusId && bank.data && bank.data.length > 0) {
      setTimeout(() => {
        const element = document.getElementById(`question-${focusId}`);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          element.style.transition = 'background-color 0.8s ease';
          element.style.backgroundColor = 'var(--yellow-light, #fffbe6)'; 
          setTimeout(() => { element.style.backgroundColor = ''; }, 2500);
        }
      }, 100);
    }
  }, [bank.data]);

  const [genOpen, setGenOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [edit, setEdit] = useState<BankItem | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  const setSt = async (it: BankItem, st: string) => {
    try { await api(`/ai/question-bank/${it.item_id}`, { method: 'PATCH', json: { status: st } }); bank.reload(); stats.reload(); } catch (e) { toast(errorText(e), 'error'); }
  };


  const st = stats.data;
  const rows = (bank.data || []).filter((q) => (!q_ || q.question.toLowerCase().includes(q_.toLowerCase()))
    && (!typeF || q.type === typeF) && (!srcF || (srcF === 'ai' ? !!q.generation_id : !q.generation_id)));
  const sel = useSelection(rows.map((q) => q.item_id));
  const [open, setOpen] = useState<string | null>(null);
  const bulk = async (to: 'approved' | 'rejected') => {
    const ids = sel.selected;
    let ok = 0;
    for (const id of ids) { try { await api(`/ai/question-bank/${id}`, { method: 'PATCH', json: { status: to } }); ok++; } catch { /* bỏ qua */ } }
    toast(`${to === 'approved' ? 'Đã duyệt' : 'Đã từ chối'} ${ok}/${ids.length} câu`, ok === ids.length ? 'success' : 'error');
    sel.clear(); bank.reload(); stats.reload();
  };
  return (
    <>
      <PageHeader title="Ngân hàng câu hỏi" sub="AI soạn câu hỏi từ tài liệu của bài, giáo viên sửa và duyệt. Bài kiểm tra cuối bài lấy từ các câu đã duyệt."
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Button variant="ghost" icon="doc" onClick={() => setExportOpen(true)}>Xuất đề</Button>
            <Button variant="ghost" icon="plus" onClick={() => setCreateOpen(true)}>Tạo thủ công</Button>
            <Button icon="wand" onClick={() => setGenOpen(true)}>AI soạn câu hỏi</Button>
          </div>
        } />
      {st && <KpiRow items={[
        { label: 'Tổng câu hỏi', value: st.approved + st.pending + st.rejected },
        { label: 'Chờ duyệt', value: st.pending, brand: true },
        { label: 'Đã duyệt', value: st.approved },
        { label: 'Tỉ lệ chấp nhận', value: st.acceptance_rate != null ? `${Math.round(st.acceptance_rate * 100)}%` : '—', hint: `${st.approved_without_edit} câu không cần sửa` },
      ]} />}
      <Toolbar>
        <SearchBox value={q_} onChange={setQ} placeholder="Tìm câu hỏi…" />
        <FilterPills label="Trạng thái" value={status} onChange={setStatus}
          options={[{ id: '', label: 'Tất cả' }, { id: 'draft', label: 'Chờ duyệt' }, { id: 'approved', label: 'Đã duyệt' }, { id: 'rejected', label: 'Từ chối' }]} />
        <PillSelect label="Bài học" value={lesson} onChange={setLesson}>
          <option value="">Tất cả bài</option>
          {lessons.data?.map((l) => <option key={l.code} value={l.code}>{l.code} · {l.title}</option>)}
        </PillSelect>
        <PillSelect label="Loại câu hỏi" value={typeF} onChange={setTypeF}>
          <option value="">Mọi loại</option>
          {Object.entries(TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </PillSelect>
        <PillSelect label="Nguồn" value={srcF} onChange={setSrcF}>
          <option value="">Mọi nguồn</option><option value="ai">AI soạn</option><option value="manual">Thủ công</option>
        </PillSelect>
      </Toolbar>
      {bank.loading && !bank.data && <Spinner />}
      {bank.error && <ErrorBox message={bank.error} onRetry={bank.reload} />}
      {bank.data && !bank.data.length && <Empty title="Chưa có câu hỏi">Bấm “AI soạn câu hỏi”, chọn bài học và nguồn, AI sẽ soạn nháp để bạn duyệt.</Empty>}
      {bank.data && !!bank.data.length && !rows.length && <Empty title="Không có câu nào khớp">Thử bỏ bớt bộ lọc hoặc từ khóa.</Empty>}
      {!!rows.length && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr>
              <th className="td-check"><Check checked={sel.allOn} onChange={sel.toggleAll} label="Chọn tất cả" /></th>
              <th>Câu hỏi</th><th>Bài</th><th>Loại</th><th>Nguồn</th><th>Trạng thái</th><th className="td-actions"><span className="sr-only">Thao tác</span></th>
            </tr></thead>
            <tbody>
              {rows.map((q) => {
                const isOpen = open === q.item_id;
                return (
                  <Fragment key={q.item_id}>
                    <tr id={`question-${q.item_id}`} className={`row-click ${sel.has(q.item_id) ? 'row-on' : ''}`} onClick={() => setOpen(isOpen ? null : q.item_id)} aria-expanded={isOpen}>
                      <td className="td-check"><Check checked={sel.has(q.item_id)} onChange={() => sel.toggle(q.item_id)} label={`Chọn câu: ${q.question}`} /></td>
                      <td className="td-main"><strong>{q.question}</strong>
                        <span className="td-sub">{[DIFF[q.difficulty] || q.difficulty, q.sources?.[0], q.edited ? 'đã sửa' : ''].filter(Boolean).join(' · ')}</span></td>
                      <td className="td-num">{q.lesson_id || '—'}</td>
                      <td>{TYPE[q.type] || q.type}</td>
                      <td>{q.generation_id ? <StatusTag tone="ai"><Icon name="sparkle" size={13} />AI</StatusTag> : <StatusTag tone="muted">Thủ công</StatusTag>}</td>
                      <td>{q.status === 'approved' ? <StatusTag tone="ok">Đã duyệt</StatusTag> : q.status === 'rejected' ? <StatusTag tone="bad">Từ chối</StatusTag> : <StatusTag tone="wait">Chờ duyệt</StatusTag>}</td>
                      <td className="td-actions" onClick={(e) => e.stopPropagation()}><IconButton icon="edit" label="Sửa câu hỏi" onClick={() => setEdit(q)} /></td>
                    </tr>
                    {isOpen && (
                      <tr className="row-detail"><td colSpan={7}>
                        <div className="m-detail">
                          {q.options?.length ? (
                            <div className="qcard-opts">{q.options.map((o, i) => <div key={i} className={`qcard-opt ${(q.correct_index ?? q.options!.indexOf(q.correct_answer || '')) === i ? 'ok' : ''}`}>{o}</div>)}</div>
                          ) : q.correct_answer ? <p className="small"><b>Đáp án:</b> {q.correct_answer}</p> : null}
                          {q.explanation && <p className="muted small">{q.explanation}</p>}
                          {!!q.sources?.length && <p className="muted small">Nguồn: {q.sources.join(', ')}</p>}
                          <div className="row">
                            {q.status !== 'approved' && <Button size="sm" icon="check" onClick={() => setSt(q, 'approved')}>Duyệt</Button>}
                            {q.status !== 'rejected' && <Button size="sm" variant="danger-ghost" onClick={() => setSt(q, 'rejected')}>Từ chối</Button>}
                            <Button size="sm" variant="ghost" icon="edit" onClick={() => setEdit(q)}>Sửa</Button>
                          </div>
                        </div>
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <BulkBar count={sel.selected.length} noun="câu" onClear={sel.clear}>
        <Button size="sm" icon="check" onClick={() => bulk('approved')}>Duyệt</Button>
        <Button size="sm" variant="ghost" onClick={() => bulk('rejected')}>Từ chối</Button>
      </BulkBar>
      {genOpen && <GenerateDialog defaultLesson={lesson} onClose={() => setGenOpen(false)} onDone={(code) => { setGenOpen(false); setLesson(code); setStatus('draft'); bank.reload(); stats.reload(); }} />}
      {exportOpen && <ExportDialog defaultLesson={lesson} onClose={() => setExportOpen(false)} />}
      {edit && <BankEditor item={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); bank.reload(); stats.reload(); }} />}
      {createOpen && <ManualCreateDialog defaultLesson={lesson} onClose={() => setCreateOpen(false)} onSaved={() => { setCreateOpen(false); bank.reload(); stats.reload(); toast('Đã tạo và duyệt câu hỏi mới', 'success'); }} />}
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
                  const n = [...f.options]; 
                  const wasCorrect = f.correct_answer === n[i]; 
                  n[i] = e.target.value;
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

/** Xuất đề kiểm tra từ các câu đã duyệt của bài: DOCX hoặc bản in (lưu PDF từ hộp thoại in của trình duyệt). */
function ExportDialog({ defaultLesson, onClose }: { defaultLesson: string; onClose: () => void }) {
  const toast = useToast();
  const [lesson, setLesson] = useState(defaultLesson);
  const [variants, setVariants] = useState(1);
  const [shuffle, setShuffle] = useState(false);
  const [answers, setAnswers] = useState(true);
  const [duration, setDuration] = useState(15);
  const [busy, setBusy] = useState<'docx' | 'html' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (format: 'docx' | 'html') => {
    setBusy(format); setErr(null);
    const qs = new URLSearchParams({ lesson_id: lesson, format, answers: String(answers), variants: String(variants),
      shuffle: String(shuffle), ...(duration > 0 && { duration: String(duration) }) });
    try {
      const { blob, filename } = await apiBlob(`/ai/teacher/question-bank/export?${qs}`);
      const url = URL.createObjectURL(blob);
      if (format === 'html') {
        const w = window.open(url, '_blank');
        if (!w) toast('Trình duyệt chặn cửa sổ mới — hãy cho phép pop-up để in đề.', 'error');
      } else {
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast(format === 'html' ? 'Đã mở bản in — chọn “Lưu thành PDF” để có file PDF' : `Đã tải ${filename}`, 'success');
    } catch (e) { setErr(errorText(e)); } finally { setBusy(null); }
  };
  return (
    <Modal open onClose={onClose} title="Xuất đề kiểm tra" dismissable={!busy}>
      <div className="modal-body">
        <Field label="Bài học" hint="Chỉ lấy các câu đã duyệt của bài."><LessonSelect value={lesson} onChange={setLesson} /></Field>
        <div className="form-grid">
          <Field label="Số mã đề" hint="Nhiều mã đề: xáo thứ tự câu và lựa chọn.">
            <select value={variants} onChange={(e) => setVariants(Number(e.target.value))}>
              {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </Field>
          <Field label="Thời gian (phút)"><input type="number" min={0} max={300} value={duration} onChange={(e) => setDuration(Number(e.target.value))} /></Field>
        </div>
        <div className="row">
          <label className="check"><input type="checkbox" checked={answers} onChange={(e) => setAnswers(e.target.checked)} />Kèm đáp án và giải thích (trang cuối)</label>
          {variants === 1 && <label className="check"><input type="checkbox" checked={shuffle} onChange={(e) => setShuffle(e.target.checked)} />Xáo câu hỏi</label>}
        </div>
        {err && <ErrorBox message={err} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} disabled={!!busy}>Đóng</Button>
          <Button variant="soft" icon="page" loading={busy === 'html'} disabled={!lesson || !!busy} onClick={() => run('html')}>In / PDF</Button>
          <Button icon="doc" loading={busy === 'docx'} disabled={!lesson || !!busy} onClick={() => run('docx')}>Tải DOCX</Button>
        </div>
      </div>
    </Modal>
  );
}
