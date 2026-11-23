import { useEffect, useState } from 'react';
import { PageHeader } from '../../components/AppShell';
import { BulkBar, Check, Drawer, FilterPills, KpiRow, PillSelect, SearchBox, StatusTag, Toolbar, useSelection } from '../../components/Manage';
import { Button, Empty, ErrorBox, Field, Spinner, useToast } from '../../components/ui';
import { api, errorText } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { useLessonCodes } from './QuestionBank';

interface AiCard { card_id: string; lesson_code: string; front: string; back: string; status: 'draft' | 'approved' | 'rejected'; sources: { label: string; display?: string }[] }
type St = '' | AiCard['status'];

const STATUS: Record<AiCard['status'], { label: string; tone: 'wait' | 'ok' | 'bad' }> = {
  draft: { label: 'Chờ duyệt', tone: 'wait' }, approved: { label: 'Đã duyệt', tone: 'ok' }, rejected: { label: 'Từ chối', tone: 'bad' },
};

/** Giáo viên: AI soạn thẻ ghi nhớ từ học liệu của bài; sửa và duyệt từng thẻ trước khi học sinh ôn. */
export function FlashcardBank() {
  const toast = useToast();
  const lessons = useLessonCodes();
  const [lesson, setLesson] = useState('');
  const [status, setStatus] = useState<St>('');
  const [q, setQ] = useState('');
  const [count, setCount] = useState(10);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<AiCard | null>(null);
  // Mặc định mở bài đầu tiên để trang không trống.
  useEffect(() => { if (!lesson && lessons.data?.length) setLesson(lessons.data[0].code); }, [lessons.data, lesson]);
  const list = useAsync((s) => (lesson ? api<AiCard[]>(`/ai/lessons/${encodeURIComponent(lesson)}/flashcards`, { signal: s }) : Promise.resolve([])), [lesson]);
  const all = list.data || [];
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
          <Button icon="wand" loading={busy} disabled={!lesson} onClick={generate}>AI soạn thẻ</Button>
        </div>} />
      {lesson && list.data && <KpiRow items={[
        { label: 'Thẻ của bài', value: all.length },
        { label: 'Chờ duyệt', value: n('draft'), brand: true },
        { label: 'Đã duyệt', value: n('approved'), hint: 'học sinh đang ôn' },
      ]} />}
      <Toolbar>
        <SearchBox value={q} onChange={setQ} placeholder="Tìm thẻ…" />
        <PillSelect label="Bài học" value={lesson} onChange={setLesson}>
          <option value="">— Chọn bài —</option>
          {lessons.data?.map((l) => <option key={l.code} value={l.code}>{l.code} · {l.title}</option>)}
        </PillSelect>
        <FilterPills<St> label="Trạng thái" value={status} onChange={setStatus}
          options={[{ id: '', label: 'Tất cả', count: all.length }, { id: 'draft', label: 'Chờ duyệt', count: n('draft') }, { id: 'approved', label: 'Đã duyệt', count: n('approved') }, { id: 'rejected', label: 'Từ chối', count: n('rejected') }]} />
      </Toolbar>
      {!lesson && !lessons.loading && <Empty title="Chọn một bài học">Thẻ được soạn từ học liệu đã nạp của bài.</Empty>}
      {lesson && list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {lesson && list.data && !all.length && <Empty title="Bài này chưa có thẻ">Bấm “AI soạn thẻ”, AI sẽ soạn nháp từ học liệu của bài để bạn duyệt.</Empty>}
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
                  <td className="td-sub" style={{ maxWidth: 220 }}>{c.sources.map((s) => s.display || s.label).join(', ') || '—'}</td>
                  <td><StatusTag tone={STATUS[c.status].tone}>{STATUS[c.status].label}</StatusTag></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
