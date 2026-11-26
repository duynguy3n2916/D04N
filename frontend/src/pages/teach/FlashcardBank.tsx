import { useState } from 'react';
import { PageHeader } from '../../components/AppShell';
import { BulkBar, Check, Drawer, FilterPills, KpiRow, SearchBox, StatusTag, Toolbar, useSelection } from '../../components/Manage';
import { Button, Empty, ErrorBox, Field, Spinner, useToast } from '../../components/ui';
import { api, errorText } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { CourseScope, useCourseTrees, useScope } from '../../components/CourseScope';

interface AiCard { card_id: string; lesson_code: string; front: string; back: string; status: 'draft' | 'approved' | 'rejected'; sources: { label: string; display?: string }[] }
type St = '' | AiCard['status'];

const STATUS: Record<AiCard['status'], { label: string; tone: 'wait' | 'ok' | 'bad' }> = {
  draft: { label: 'Chờ duyệt', tone: 'wait' }, approved: { label: 'Đã duyệt', tone: 'ok' }, rejected: { label: 'Từ chối', tone: 'bad' },
};

/** Giáo viên: AI soạn thẻ ghi nhớ từ học liệu của bài; sửa và duyệt từng thẻ trước khi học sinh ôn. */
export function FlashcardBank() {
  const toast = useToast();
  const trees = useCourseTrees();
  const [scope, setScope] = useScope('flashcards');
  const lesson = scope.lesson;
  const [status, setStatus] = useState<St>('');
  const [q, setQ] = useState('');
  const [count, setCount] = useState(10);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<AiCard | null>(null);
  // Thẻ gắn theo mã bài (lesson_code). API lấy theo từng bài, nên "Tất cả bài trong khóa" = gộp thẻ của mọi bài trong khóa.
  const course = trees.data?.find((c) => c.course_id === scope.course);
  const codes = course ? course.lessons.map((l) => l.code).filter(Boolean) : [];
  const list = useAsync(async (s) => {
    if (!codes.length) return [] as AiCard[];
    const res = await Promise.allSettled(codes.map((code) => api<AiCard[]>(`/ai/lessons/${encodeURIComponent(code)}/flashcards`, { signal: s })));
    return res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  }, [codes.join('|')]);
  const inCourse = list.data || [];
  const all = lesson ? inCourse.filter((c) => c.lesson_code === lesson) : inCourse;
  const rows = all.filter((c) => (!status || c.status === status) && (!q || `${c.front} ${c.back}`.toLowerCase().includes(q.toLowerCase())));
  const sel = useSelection(rows.map((c) => c.card_id));
  const n = (s: AiCard['status']) => all.filter((c) => c.status === s).length;

  const generate = async () => {
    setBusy(true);
    try {
      const r = await api<AiCard[]>(`/ai/lessons/${encodeURIComponent(lesson)}/flashcards/generate`, { json: { count } });
      toast(`AI đã soạn ${r.length} thẻ nháp`, 'success'); setStatus('draft'); list.reload();
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  const bulk = async (to: AiCard['status']) => {
    let ok = 0;
    for (const id of sel.selected) { try { await api(`/ai/flashcard-cards/${id}`, { method: 'PATCH', json: { status: to } }); ok++; } catch { /* bỏ qua */ } }
    toast(`${to === 'approved' ? 'Đã duyệt' : 'Đã từ chối'} ${ok} thẻ`, 'success'); sel.clear(); list.reload();
  };

  return (
    <>
      <PageHeader title="Thẻ ghi nhớ" sub="AI soạn thẻ hỏi–đáp từ bài đọc, slide và lời giảng. Học sinh chỉ ôn các thẻ bạn đã duyệt."
        actions={<div className="row" style={{ gap: 8 }}>
          <label className="m-select"><span className="sr-only">Số thẻ</span>
            <select value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="Số thẻ AI soạn">{[5, 10, 15, 20].map((v) => <option key={v} value={v}>{v} thẻ</option>)}</select>
          </label>
          <Button icon="wand" loading={busy} disabled={!lesson} onClick={generate} title={lesson ? undefined : 'Chọn một bài ở bên trái trước'}>AI soạn thẻ</Button>
        </div>} />
      <CourseScope courses={trees.data} loading={trees.loading} error={trees.error} onRetry={trees.reload}
        scope={scope} onChange={setScope} unit="thẻ"
        countLesson={(l) => (course?.lessons.includes(l) && list.data ? inCourse.filter((c) => c.lesson_code === l.code).length : null)}
        countCourse={(c) => (c.course_id === course?.course_id && list.data ? inCourse.length : null)}>
      {list.data && <KpiRow items={[
        { label: lesson ? 'Thẻ của bài' : 'Thẻ trong khóa', value: all.length },
        { label: 'Chờ duyệt', value: n('draft'), brand: true },
        { label: 'Đã duyệt', value: n('approved'), hint: 'học sinh đang ôn' },
      ]} />}
      <Toolbar>
        <SearchBox value={q} onChange={setQ} placeholder="Tìm thẻ…" />
        <FilterPills<St> label="Trạng thái" value={status} onChange={setStatus}
          options={[{ id: '', label: 'Tất cả', count: all.length }, { id: 'draft', label: 'Chờ duyệt', count: n('draft') }, { id: 'approved', label: 'Đã duyệt', count: n('approved') }, { id: 'rejected', label: 'Từ chối', count: n('rejected') }]} />
      </Toolbar>
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.data && !all.length && <Empty title={lesson ? 'Bài này chưa có thẻ' : 'Khóa này chưa có thẻ'}>
        {lesson ? 'Bấm “AI soạn thẻ”, AI sẽ soạn nháp từ học liệu của bài để bạn duyệt.' : 'Chọn một bài bên trái rồi bấm “AI soạn thẻ”.'}</Empty>}
      {!!all.length && !rows.length && <Empty title="Không có thẻ nào khớp">Thử bỏ bớt bộ lọc hoặc từ khóa.</Empty>}
      {!!rows.length && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr>
              <th className="td-check"><Check checked={sel.allOn} onChange={sel.toggleAll} label="Chọn tất cả" /></th>
              <th>Mặt trước / mặt sau</th><th>Nguồn</th><th>Trạng thái</th>
            </tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.card_id} className={`row-click ${sel.has(c.card_id) ? 'row-on' : ''}`} onClick={() => setEditing(c)}>
                  <td className="td-check"><Check checked={sel.has(c.card_id)} onChange={() => sel.toggle(c.card_id)} label={`Chọn thẻ: ${c.front}`} /></td>
                  <td className="td-main"><strong>{c.front}</strong><span className="td-sub">{c.back}</span></td>
                  <td style={{ maxWidth: 220 }}><span className="td-sub">{c.sources.map((s) => s.display || s.label).join(', ') || '—'}</span></td>
                  <td><StatusTag tone={STATUS[c.status].tone}>{STATUS[c.status].label}</StatusTag></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </CourseScope>
      <BulkBar count={sel.selected.length} noun="thẻ" onClear={sel.clear}>
        <Button size="sm" icon="check" onClick={() => bulk('approved')}>Duyệt</Button>
        <Button size="sm" variant="ghost" onClick={() => bulk('rejected')}>Từ chối</Button>
      </BulkBar>
      {editing && <CardDrawer key={editing.card_id} card={editing} onClose={() => setEditing(null)} onChanged={() => { setEditing(null); list.reload(); }} />}
    </>
  );
}

function CardDrawer({ card, onClose, onChanged }: { card: AiCard; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [front, setFront] = useState(card.front);
  const [back, setBack] = useState(card.back);
  const [busy, setBusy] = useState(false);
  const dirty = front !== card.front || back !== card.back;
  const save = async (status?: AiCard['status']) => {
    setBusy(true);
    try {
      await api(`/ai/flashcard-cards/${card.card_id}`, { method: 'PATCH', json: { ...(dirty && { front, back }), ...(status && { status }) } });
      toast(status === 'approved' ? 'Đã duyệt thẻ' : status === 'rejected' ? 'Đã từ chối thẻ' : 'Đã lưu', 'success');
      onChanged();
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Drawer title="Sửa thẻ ghi nhớ" onClose={onClose} footer={<>
      {dirty && <Button size="sm" variant="ghost" disabled={busy} onClick={() => save()}>Lưu</Button>}
      {card.status !== 'rejected' && <Button size="sm" variant="danger-ghost" disabled={busy} onClick={() => save('rejected')}>Từ chối</Button>}
      {card.status !== 'approved' && <Button size="sm" icon="check" disabled={busy || !front.trim() || !back.trim()} onClick={() => save('approved')}>{dirty ? 'Lưu và duyệt' : 'Duyệt'}</Button>}
    </>}>
      <div className="row" style={{ gap: 6 }}><StatusTag tone={STATUS[card.status].tone}>{STATUS[card.status].label}</StatusTag><span className="muted small">Bài {card.lesson_code}</span></div>
      <div className="fc-preview" aria-label="Xem trước thẻ">
        <div><span>Mặt trước</span><p>{front || '…'}</p></div>
        <div><span>Mặt sau</span><p>{back || '…'}</p></div>
      </div>
      <Field label="Mặt trước"><textarea value={front} onChange={(e) => setFront(e.target.value)} maxLength={300} rows={3} /></Field>
      <Field label="Mặt sau"><textarea value={back} onChange={(e) => setBack(e.target.value)} maxLength={600} rows={4} /></Field>
      {!!card.sources.length && <p className="muted small">Nguồn: {card.sources.map((s) => s.display || s.label).join(', ')}</p>}
    </Drawer>
  );
}
