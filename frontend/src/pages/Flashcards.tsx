import { useEffect, useState } from 'react';
import { FilterPills } from '../components/Manage';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/AppShell';
import { Markdown } from '../components/Markdown';
import { Button, Empty, ErrorBox, Progress, Spinner, useToast } from '../components/ui';
import { api, errorText, storage } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { navigate } from '../lib/router';

interface Card { card_id: string; front: string; back: string; explanation: string; new: boolean }
interface Summary { lesson_code: string; lesson_title?: string | null; total: number; new: number; due: number; learned: number }
interface Due { lesson_code: string; cards: Card[]; remaining: number }

const RATINGS: { key: string; label: string; hint: string; tone: string }[] = [
  { key: 'again', label: 'Quên', hint: 'hỏi lại sau 10 phút', tone: 'again' },
  { key: 'hard', label: 'Khó', hint: 'ôn sớm hơn', tone: 'hard' },
  { key: 'good', label: 'Nhớ', hint: 'ôn theo lịch', tone: 'good' },
  { key: 'easy', label: 'Dễ', hint: 'giãn khoảng cách', tone: 'easy' },
];

/** Ôn thẻ ngắt quãng: lật thẻ, tự chấm mức nhớ, hệ thống tự lên lịch lần ôn tiếp theo. */
export function Flashcards({ lessonCode }: { lessonCode: string }) {
  const toast = useToast();
  const summary = useAsync((s) => api<Summary>(`/ai/learn/flashcards/${encodeURIComponent(lessonCode)}/summary`, { signal: s }), [lessonCode], `fc-summary/${lessonCode}`);
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
  const total = done + queue.length;
  return (
    <div className="fc-page">
      <PageHeader title="Ôn thẻ ghi nhớ" sub={`${summary.data?.lesson_title || 'Bài học'} · lật thẻ, tự chấm mức nhớ. Thẻ bạn quên sẽ quay lại sớm, thẻ nhớ tốt sẽ giãn ra.`}
        actions={<Button variant="ghost" icon="chevronLeft" onClick={() => navigate('/flashcards')}>Tất cả thẻ</Button>} />
      {loading && <Spinner />}
      {error && <ErrorBox message={error} onRetry={() => { summary.reload(); due.reload(); }} />}
      {summary.data && !summary.data.total && <Empty title="Bài này chưa có thẻ">Giáo viên cần duyệt câu hỏi cho bài để tạo thẻ.</Empty>}
      {summary.data && !!summary.data.total && (
        <>
          <div className="fc-bar">
            <div className="fc-chips">
              <span className="fc-chip fc-chip-brand"><b>{summary.data.due + done}</b> cần ôn hôm nay</span>
              <span className="fc-chip"><b>{summary.data.new}</b> thẻ mới</span>
              <span className="fc-chip"><b>{summary.data.learned}</b> đã thuộc</span>
            </div>
            {queue.length > 0 && (
              <div className="fc-progress">
                <span>{done}/{total}</span>
                <div style={{ width: 180 }}><Progress value={done / Math.max(1, total)} label="Tiến độ phiên ôn" /></div>
              </div>
            )}
          </div>
          {queue.length ? (
            <div className="fc-session">
              <div className={`fc-stack ${queue.length > 1 ? 'fc-stack-more' : ''}`}>
                <button type="button" className={`fc-card ${flipped ? 'fc-flipped' : ''}`} onClick={() => setFlipped(true)} disabled={flipped}
                  aria-label={flipped ? undefined : 'Lật thẻ'}>
                  <span className="fc-kicker">{card.new ? 'Thẻ mới' : 'Ôn lại'}{summary.data?.lesson_title ? ` · ${summary.data.lesson_title}` : ''}</span>
                  <span className="fc-front">{card.front}</span>
                  {flipped ? (
                    <span className="fc-back">
                      <strong>{card.back}</strong>
                      {card.explanation && <Markdown source={card.explanation} />}
                    </span>
                  ) : <span className="fc-tap">Bấm vào thẻ hoặc nhấn Space để lật</span>}
                </button>
              </div>
              {!flipped ? (
                <Button size="lg" onClick={() => setFlipped(true)} className="fc-flip">Lật thẻ</Button>
              ) : (
                <div className="fc-rates" role="group" aria-label="Chấm mức nhớ">
                  {RATINGS.map((r, i) => (
                    <button key={r.key} type="button" className={`fc-rate fc-rate-${r.tone}`} disabled={busy} onClick={() => rate(r.key)}>
                      <strong>{r.label}</strong><span>{r.hint}</span><kbd>{i + 1}</kbd>
                    </button>
                  ))}
                </div>
              )}
              <span className="muted small">Còn {queue.length} thẻ trong phiên · Space lật thẻ, phím 1–4 để chấm</span>
            </div>
          ) : (
            <Empty title={done ? `Xong! Bạn đã ôn ${done} thẻ` : 'Hôm nay không còn thẻ nào cần ôn'}>
              Quay lại sau nhé, thẻ sẽ tự xuất hiện khi đến hạn.
            </Empty>
          )}
        </>
      )}
    </div>
  );
}

interface LessonDeck extends Summary { lesson_id: string; chapter_title: string }
interface CourseDecks { course_id: string; code: string; title: string; total: number; due: number; lessons: LessonDeck[] }
const FC_COURSE_KEY = 'mam.fc.course';

/** Trang Thẻ ghi nhớ (ngoài bài học): chọn khóa học rồi chọn bài để ôn. Lối vào "Ôn thẻ" trong bài vẫn giữ. */
export function FlashcardHub() {
  const data = useAsync((s) => api<CourseDecks[]>('/ai/learn/flashcards', { signal: s }), [], 'fc-overview');
  const [courseId, setCourseId] = useState<string>(() => storage.get(FC_COURSE_KEY) || '');
  const courses = data.data || [];
  const current = courses.find((c) => c.course_id === courseId) || courses.find((c) => c.due > 0) || courses[0];
  useEffect(() => { if (current) storage.set(FC_COURSE_KEY, current.course_id); }, [current?.course_id]);
  const dueAll = courses.reduce((n, c) => n + c.due, 0);
  const firstDue = current?.lessons.find((l) => l.due > 0);
  return (
    <div className="fc-hub">
      <PageHeader title="Thẻ ghi nhớ" sub={dueAll ? `Hôm nay bạn có ${dueAll} thẻ cần ôn. Chọn khóa học và bài để bắt đầu.` : 'Chọn khóa học và bài học để ôn thẻ.'}
        actions={firstDue && <Button icon="refresh" onClick={() => navigate(`/flashcards/${encodeURIComponent(firstDue.lesson_code)}`)}>Ôn ngay {firstDue.due} thẻ</Button>} />
      {data.loading && !data.data && <Spinner />}
      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
      {data.data && !courses.length && <Empty title="Bạn chưa có khóa học nào">Vào lớp và khóa học trước để có thẻ ôn.</Empty>}
      {courses.length > 1 && (
        <FilterPills label="Khóa học" value={current?.course_id || ''} onChange={setCourseId}
          options={courses.map((c) => ({ id: c.course_id, label: c.title, count: c.due || undefined }))} />
      )}
      {current && !current.lessons.length && <Empty title="Khóa này chưa có bài học" />}
      {current && current.lessons.length > 0 && (
        <div className="fc-deck-list">
          {current.lessons.map((l) => {
            const empty = !l.total;
            return (
              <button key={l.lesson_code} type="button" className={`fc-deck ${l.due ? 'fc-deck-due' : ''}`} disabled={empty}
                onClick={() => navigate(`/flashcards/${encodeURIComponent(l.lesson_code)}`)}>
                <span className="fc-deck-ico"><Icon name="copy" size={20} /></span>
                <span className="fc-deck-text">
                  <small>{l.chapter_title}</small>
                  <strong>{l.lesson_title}</strong>
                  <span className="fc-deck-meta">{empty ? 'Chưa có thẻ' : `${l.total} thẻ · ${l.new} mới · ${l.learned} đã thuộc`}</span>
                </span>
                {!empty && (l.due ? <span className="fc-deck-due-pill">{l.due} cần ôn</span> : <span className="fc-deck-ok"><Icon name="check" size={14} /> Đã ôn xong</span>)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
