import { useEffect, useState } from 'react';
import { PageHeader } from '../components/AppShell';
import { Markdown } from '../components/Markdown';
import { Button, Empty, ErrorBox, Progress, Spinner, useToast } from '../components/ui';
import { api, errorText } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { navigate } from '../lib/router';

interface Card { card_id: string; front: string; back: string; explanation: string; new: boolean }
interface Summary { lesson_code: string; total: number; new: number; due: number; learned: number }
interface Due { lesson_code: string; cards: Card[]; remaining: number }

const RATINGS: { key: string; label: string; hint: string; variant: 'red' | 'soft' | 'green' | 'blue' }[] = [
  { key: 'again', label: 'Lại', hint: 'Hỏi lại sau 10 phút', variant: 'red' },
  { key: 'hard', label: 'Khó', hint: 'Ôn sớm hơn', variant: 'soft' },
  { key: 'good', label: 'Được', hint: 'Ôn theo lịch', variant: 'green' },
  { key: 'easy', label: 'Dễ', hint: 'Giãn khoảng cách', variant: 'blue' },
];

/** Ôn thẻ ngắt quãng: lật thẻ, tự chấm mức nhớ, hệ thống tự lên lịch lần ôn tiếp theo. */
export function Flashcards({ lessonCode }: { lessonCode: string }) {
  const toast = useToast();
  const summary = useAsync((s) => api<Summary>(`/ai/learn/flashcards/${encodeURIComponent(lessonCode)}/summary`, { signal: s }), [lessonCode]);
  const due = useAsync((s) => api<Due>(`/ai/learn/flashcards/${encodeURIComponent(lessonCode)}/due`, { signal: s }), [lessonCode]);
  const [queue, setQueue] = useState<Card[]>([]);
  const [flipped, setFlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);

  useEffect(() => { if (due.data) setQueue(due.data.cards); }, [due.data]);
  const card = queue[0];

  const rate = async (rating: string) => {
    if (!card || busy) return;
    setBusy(true);
    try {
      await api(`/ai/learn/flashcards/${card.card_id}/review`, { json: { rating } });
      // thẻ quên quay lại cuối hàng để hỏi lại trong phiên này
      setQueue((q) => (rating === 'again' ? [...q.slice(1), card] : q.slice(1)));
      if (rating !== 'again') setDone((n) => n + 1);
      setFlipped(false);
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
      if (e.key === ' ' && card && !flipped) { e.preventDefault(); setFlipped(true); return; }
      if (flipped) {
        const i = Number(e.key) - 1;
        if (i >= 0 && i < RATINGS.length) rate(RATINGS[i].key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const loading = (summary.loading && !summary.data) || (due.loading && !due.data);
  const error = summary.error || due.error;
  return (
    <>
      <PageHeader title="Ôn thẻ ghi nhớ" sub="Lật thẻ, tự chấm mức nhớ. Thẻ bạn quên sẽ quay lại sớm; thẻ nhớ tốt sẽ giãn ra."
        actions={<Button variant="ghost" icon="chevronLeft" onClick={() => navigate('/learn')}>Về trang học</Button>} />
      {loading && <Spinner />}
      {error && <ErrorBox message={error} onRetry={() => { summary.reload(); due.reload(); }} />}
      {summary.data && !summary.data.total && <Empty title="Bài này chưa có thẻ">Giáo viên cần duyệt câu hỏi cho bài để tạo thẻ.</Empty>}
      {summary.data && !!summary.data.total && (
        <>
          <div className="stat-tiles">
            <div className="tile"><strong>{summary.data.due + done}</strong><span>Cần ôn hôm nay</span></div>
            <div className="tile"><strong>{summary.data.new}</strong><span>Thẻ mới</span></div>
            <div className="tile"><strong>{summary.data.learned}</strong><span>Đã thuộc</span></div>
          </div>
          {queue.length ? (
            <div className="card col" style={{ gap: 14, maxWidth: 720, margin: '0 auto' }}>
              <Progress value={done / Math.max(1, done + queue.length)} label="Tiến độ phiên ôn" height={14} />
              <span className="muted small">Còn {queue.length} thẻ trong phiên · Phím tắt: Space lật, 1–4 chấm mức nhớ</span>
              <div className="card" style={{ minHeight: 160, display: 'grid', placeItems: 'center', padding: 24 }}>
                <div className="col" style={{ gap: 10, textAlign: 'center' }}>
                  <strong style={{ fontSize: 13, textTransform: 'uppercase' }}>{card.new ? 'Thẻ mới' : 'Ôn lại'}</strong>
                  <h2 style={{ fontSize: 22 }}>{card.front}</h2>
                  {flipped && (
                    <div className="col" style={{ gap: 6 }}>
                      <hr style={{ width: '100%', border: 'none', borderTop: '2px dashed var(--line)' }} />
                      <p style={{ fontWeight: 800, fontSize: 18 }}>{card.back}</p>
                      {card.explanation && <Markdown source={card.explanation} />}
                    </div>
                  )}
                </div>
              </div>
              {!flipped ? (
                <Button size="lg" onClick={() => setFlipped(true)} style={{ alignSelf: 'center', minWidth: 220 }}>Lật thẻ</Button>
              ) : (
                <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
                  {RATINGS.map((r, i) => (
                    <Button key={r.key} variant={r.variant} size="lg" disabled={busy} onClick={() => rate(r.key)} title={r.hint}>
                      {`${i + 1}. ${r.label}`}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <Empty title={done ? `Xong! Bạn đã ôn ${done} thẻ` : 'Hôm nay không còn thẻ nào cần ôn'}>
              Quay lại sau nhé, thẻ sẽ tự xuất hiện khi đến hạn.
            </Empty>
          )}
        </>
      )}
    </>
  );
}
