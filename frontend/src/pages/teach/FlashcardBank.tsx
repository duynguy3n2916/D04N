import { useState } from 'react';
import { PageHeader } from '../../components/AppShell';
import { Badge, Button, Empty, ErrorBox, Field, Spinner, useToast } from '../../components/ui';
import { api, errorText } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { LessonSelect } from './QuestionBank';

interface AiCard { card_id: string; lesson_code: string; front: string; back: string; status: 'draft' | 'approved' | 'rejected'; sources: { label: string; display?: string }[] }

const STATUS: Record<AiCard['status'], { label: string; tone: 'yellow' | 'green' | 'red' }> = {
  draft: { label: 'Nháp', tone: 'yellow' }, approved: { label: 'Đã duyệt', tone: 'green' }, rejected: { label: 'Từ chối', tone: 'red' },
};

/** Giáo viên: AI soạn thẻ ghi nhớ từ học liệu của bài; sửa và duyệt từng thẻ trước khi học sinh ôn. */
export function FlashcardBank() {
  const toast = useToast();
  const [lesson, setLesson] = useState('');
  const [status, setStatus] = useState('');
  const [count, setCount] = useState(10);
  const [busy, setBusy] = useState(false);
  const list = useAsync((s) => (lesson
    ? api<AiCard[]>(`/ai/lessons/${encodeURIComponent(lesson)}/flashcards${status ? `?status=${status}` : ''}`, { signal: s })
    : Promise.resolve([])), [lesson, status]);

  const generate = async () => {
    setBusy(true);
    try {
      const r = await api<AiCard[]>(`/ai/lessons/${encodeURIComponent(lesson)}/flashcards/generate`, { json: { count } });
      toast(`AI đã soạn ${r.length} thẻ nháp`, 'success'); setStatus('draft'); list.reload();
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader title="Thẻ ghi nhớ" sub="AI soạn thẻ hỏi–đáp từ bài đọc, slide và lời giảng. Học sinh chỉ ôn các thẻ bạn đã duyệt." />
      <div className="row" style={{ marginBottom: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="Bài học"><LessonSelect value={lesson} onChange={setLesson} /></Field>
        <Field label="Trạng thái">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Tất cả</option><option value="draft">Nháp</option><option value="approved">Đã duyệt</option><option value="rejected">Từ chối</option>
          </select>
        </Field>
        <Field label="Số thẻ"><input type="number" min={1} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} /></Field>
        <Button icon="wand" loading={busy} disabled={!lesson} onClick={generate}>AI soạn thẻ</Button>
      </div>
      {!lesson && <Empty title="Chọn một bài học">Thẻ được soạn từ học liệu đã nạp của bài.</Empty>}
      {lesson && list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {lesson && list.data && !list.data.length && <Empty title="Chưa có thẻ nào">Bấm “AI soạn thẻ” để bắt đầu.</Empty>}
      <div className="col" style={{ gap: 10 }}>
        {list.data?.map((c) => <CardRow key={c.card_id} card={c} onChanged={list.reload} />)}
      </div>
    </>
  );
}

function CardRow({ card, onChanged }: { card: AiCard; onChanged: () => void }) {
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
    <section className="card col" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 6 }}>
        <Badge tone={STATUS[card.status].tone}>{STATUS[card.status].label}</Badge>
        {card.sources.map((s) => <Badge key={s.label}>{s.display || s.label}</Badge>)}
      </div>
      <div className="form-grid">
        <Field label="Mặt trước"><textarea value={front} onChange={(e) => setFront(e.target.value)} maxLength={300} rows={2} /></Field>
        <Field label="Mặt sau"><textarea value={back} onChange={(e) => setBack(e.target.value)} maxLength={600} rows={2} /></Field>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        {dirty && <Button size="sm" variant="ghost" disabled={busy} onClick={() => save()}>Lưu</Button>}
        {card.status !== 'rejected' && <Button size="sm" variant="danger-ghost" disabled={busy} onClick={() => save('rejected')}>Từ chối</Button>}
        {card.status !== 'approved' && <Button size="sm" icon="check" disabled={busy || !front.trim() || !back.trim()} onClick={() => save('approved')}>Duyệt</Button>}
      </div>
    </section>
  );
}
