import { useEffect, useState } from 'react';
import { FilterPills } from '../components/Manage';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/AppShell';
import { Markdown } from '../components/Markdown';
import { Button, Empty, ErrorBox, Progress, Spinner, useToast } from '../components/ui';
import { api, errorText, storage } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { refreshNotifications } from '../lib/notifications';
import { navigate } from '../lib/router';
import { MyFlashcards } from './MyFlashcards';

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
      summary.reload();
      void refreshNotifications();
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
        actions={<Button variant="ghost" icon="chevronLeft" onClick={() => navigate('/flashcards')}>Các bộ thẻ</Button>} />
      {loading && <Spinner />}
      {error && <ErrorBox message={error} onRetry={() => { summary.reload(); due.reload(); }} />}
      {summary.data && !summary.data.total && <Empty title="Bài này chưa có thẻ">Giáo viên cần duyệt câu hỏi cho bài để tạo thẻ.</Empty>}
      {!loading && !error && summary.data && !!summary.data.total && (
        <>
          <div className="fc-bar">
            <div className="fc-chips">
              <span className="fc-chip fc-chip-brand"><b>{summary.data.due}</b> cần ôn hôm nay</span>
              <span className="fc-chip"><b>{summary.data.new}</b> thẻ mới</span>
              <span className="fc-chip"><b>{summary.data.learned}</b> đã nhớ</span>
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
              {summary.data.due > 0 ? (
                <Button loading={due.loading} onClick={() => { setDone(0); due.reload(); }}>Ôn tiếp</Button>
              ) : 'Quay lại sau nhé, thẻ sẽ tự xuất hiện khi đến hạn.'}
            </Empty>
          )}
        </>
      )}
    </div>
  );
}

interface LessonDeck extends Summary { lesson_id: string; chapter_title: string; locked: boolean }
interface CourseDecks { course_id: string; code: string; title: string; total: number; due: number; lessons: LessonDeck[] }
const FC_COURSE_KEY = 'mam.fc.course';
const FC_TAB_KEY = 'mam.fc.tab';

/** Trang Thẻ ghi nhớ (ngoài bài học): chọn khóa học rồi chọn bài để ôn. Lối vào "Ôn thẻ" trong bài vẫn giữ. */
export function FlashcardHub() {
  const data = useAsync((s) => api<CourseDecks[]>('/ai/learn/flashcards', { signal: s }), []);
  const [courseId, setCourseId] = useState<string>(() => storage.get(FC_COURSE_KEY) || '');
  const courses = data.data || [];
  const current = courses.find((c) => c.course_id === courseId) || courses.find((c) => c.due > 0)
    || courses.find((c) => c.total > 0) || courses.find((c) => c.lessons.length > 0) || courses[0];
  useEffect(() => { if (current) storage.set(FC_COURSE_KEY, current.course_id); }, [current?.course_id]);
  const dueAll = courses.reduce((n, c) => n + c.due, 0);
  const firstDue = current?.lessons.find((l) => l.due > 0);
  const [tab, setTabState] = useState<'course' | 'mine'>(() => (storage.get(FC_TAB_KEY) === 'mine' ? 'mine' : 'course'));
  const setTab = (t: 'course' | 'mine') => { setTabState(t); storage.set(FC_TAB_KEY, t); };
  const tabs = (
    <div className="tabs" role="tablist" style={{ marginBottom: 14 }}>
      <button type="button" className={`tab ${tab === 'course' ? 'tab-on' : ''}`} role="tab" aria-selected={tab === 'course'} onClick={() => setTab('course')}>Bộ thẻ khóa học</button>
      <button type="button" className={`tab ${tab === 'mine' ? 'tab-on' : ''}`} role="tab" aria-selected={tab === 'mine'} onClick={() => setTab('mine')}>Thẻ của tôi</button>
    </div>
  );
  if (tab === 'mine') {
    return (
      <div className="fc-hub">
        <PageHeader title="Thẻ ghi nhớ" sub="Thẻ riêng của bạn: tự viết hoặc nhờ AI soạn từ bài học hay ghi chú. Chỉ mình bạn thấy." />
        {tabs}
        <MyFlashcards />
      </div>
    );
  }
  return (
    <div className="fc-hub">
      <PageHeader title="Thẻ ghi nhớ" sub={dueAll ? `Hôm nay bạn có ${dueAll} thẻ cần ôn. Chọn khóa học và bài để bắt đầu.` : 'Chọn khóa học và bài học để ôn thẻ.'}
        actions={<>
          <Button variant="ghost" icon="copy" onClick={() => navigate('/flashcards/library/all')}>Tất cả thẻ đã học</Button>
          {firstDue && <Button icon="refresh" onClick={() => navigate(`/flashcards/${encodeURIComponent(firstDue.lesson_code)}`)}>Ôn ngay {firstDue.due} thẻ</Button>}
        </>} />
      {tabs}
      {data.loading && !data.data && <Spinner />}
      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
      {data.data && !courses.length && <Empty title="Bạn chưa có khóa học nào">Vào lớp và khóa học trước để có thẻ ôn.</Empty>}
      {courses.length > 1 && (
        <FilterPills label="Khóa học" value={current?.course_id || ''} onChange={setCourseId}
          options={courses.map((c) => ({ id: c.course_id, label: c.title, count: c.due || undefined }))} />
      )}
      {current && !current.lessons.length && <Empty title="Khóa này chưa có bộ thẻ" />}
      {current && current.lessons.length > 0 && (
        <div className="fc-deck-list">
          {current.lessons.map((l) => {
            const empty = !l.total;
            return (
              <button key={l.lesson_code} type="button" className={`fc-deck ${l.locked ? 'fc-deck-locked' : l.due ? 'fc-deck-due' : ''}`} disabled={l.locked || empty}
                onClick={() => navigate(`/flashcards/${encodeURIComponent(l.lesson_code)}`)}>
                <span className="fc-deck-ico"><Icon name={l.locked ? 'lock' : 'copy'} size={20} /></span>
                <span className="fc-deck-text">
                  <small>{l.chapter_title}</small>
                  <strong>{l.lesson_title}</strong>
                  <span className="fc-deck-meta">{l.locked ? 'Hoàn thành bài học để mở khóa' : empty ? 'Chưa có thẻ' : `${l.total} thẻ · ${l.new} mới · ${l.learned} đã nhớ`}</span>
                </span>
                {!l.locked && !empty && (l.due ? <span className="fc-deck-due-pill">{l.due} cần ôn</span> : <span className="fc-deck-ok"><Icon name="check" size={14} /> Đã ôn xong</span>)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const MEMORY_FILTERS = [
  { id: 'all', label: 'Tất cả' },
  { id: 'remembered', label: 'Đã nhớ' },
  { id: 'unremembered', label: 'Chưa nhớ' },
] as const;
type MemoryFilter = typeof MEMORY_FILTERS[number]['id'];
interface LibraryCard extends Card { lesson_title: string; remembered: boolean }
interface LibraryPage { cards: LibraryCard[]; next_offset: number | null }

export function FlashcardLibrary() {
  const [filter, setFilter] = useState<MemoryFilter>('all');
  const [offset, setOffset] = useState(0);
  return (
    <div className="fc-hub">
      <PageHeader title="Tất cả thẻ đã học"
        actions={<Button variant="ghost" icon="chevronLeft" onClick={() => navigate('/flashcards')}>Các bộ thẻ</Button>} />
      <FilterPills label="Mức độ ghi nhớ" options={[...MEMORY_FILTERS]} value={filter}
        onChange={(value) => { setFilter(value); setOffset(0); }} />
      <LibraryCards key={`${filter}/${offset}`} filter={filter} offset={offset} setOffset={setOffset} />
    </div>
  );
}

function LibraryCards({ filter, offset, setOffset }: { filter: MemoryFilter; offset: number; setOffset: (value: number) => void }) {
  const page = useAsync((signal) => api<LibraryPage>(`/ai/learn/flashcards/library?status=${filter}&offset=${offset}`, { signal }), []);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const nextOffset = page.data?.next_offset;
  const mark = async (card: LibraryCard) => {
    setBusy(card.card_id);
    try {
      const result = await api<{ remembered: boolean }>(`/ai/learn/flashcards/${card.card_id}/memory`, {
        method: 'PUT', json: { remembered: !card.remembered },
      });
      if (filter === 'all') {
        page.setData((prev) => prev && ({ ...prev, cards: prev.cards.map((c) => c.card_id === card.card_id ? { ...c, remembered: result.remembered } : c) }));
      } else if (offset > 0) {
        setOffset(0);
      } else {
        page.reload();
      }
      void refreshNotifications();
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(null); }
  };
  return (
    <div className="fc-library-list">
      {page.loading && <Spinner />}
      {page.error && <ErrorBox message={page.error} onRetry={page.reload} />}
      {page.data && !page.data.cards.length && <Empty title={filter === 'all' ? 'Bạn chưa mở khóa thẻ nào' : 'Không có thẻ trong bộ lọc này'} />}
      {page.data?.cards.map((card) => (
        <article className="fc-library-card" key={card.card_id}>
          <div className="fc-library-heading">
            <span className="muted small">{card.lesson_title}</span>
            <span className={`fc-chip ${card.remembered ? 'fc-chip-brand' : ''}`}>{card.remembered ? 'Đã nhớ' : 'Chưa nhớ'}</span>
          </div>
          <strong>{card.front}</strong>
          <details>
            <summary>Xem đáp án</summary>
            <Markdown source={card.back} />
            {card.explanation && <Markdown source={card.explanation} />}
          </details>
          <Button variant="ghost" size="sm" disabled={busy !== null || page.loading} onClick={() => mark(card)}>
            {card.remembered ? 'Đánh dấu chưa nhớ' : 'Đánh dấu đã nhớ'}
          </Button>
        </article>
      ))}
      {(offset > 0 || nextOffset != null) && (
        <div className="fc-library-heading">
          <Button variant="ghost" disabled={!offset || busy !== null} onClick={() => setOffset(Math.max(0, offset - 20))}>Trang trước</Button>
          {nextOffset != null && <Button disabled={busy !== null} onClick={() => setOffset(nextOffset)}>Trang sau</Button>}
        </div>
      )}
    </div>
  );
}
