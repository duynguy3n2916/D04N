import { useEffect, useState } from 'react';
import { FilterPills } from '../components/Manage';
import { useCourseTrees } from '../components/CourseScope';
import { Button, Empty, ErrorBox, Field, Modal, Progress, Spinner, confirmDialog, useToast } from '../components/ui';
import { api, errorText } from '../lib/api';
import { useAsync } from '../lib/hooks';

interface MyCard { card_id: string; deck: string; front: string; back: string; origin: 'manual' | 'ai'; new: boolean; due: boolean; remembered: boolean }
interface MyList { cards: MyCard[]; decks: string[]; total: number; due: number; learned: number }

const RATINGS = [
  { key: 'again', label: 'Quên', hint: 'hỏi lại sau 10 phút', tone: 'again' },
  { key: 'hard', label: 'Khó', hint: 'ôn sớm hơn', tone: 'hard' },
  { key: 'good', label: 'Nhớ', hint: 'ôn theo lịch', tone: 'good' },
  { key: 'easy', label: 'Dễ', hint: 'giãn khoảng cách', tone: 'easy' },
];

/** Tab "Thẻ của tôi": học sinh tự viết thẻ hoặc nhờ AI soạn (từ bài học hay ghi chú), rồi ôn như thẻ của khóa. */
export function MyFlashcards() {
  const list = useAsync((s) => api<MyList>('/ai/learn/my-flashcards', { signal: s }), []);
  const [deck, setDeck] = useState('');
  const [editing, setEditing] = useState<MyCard | 'new' | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const data = list.data;
  const decks = data?.decks || [];
  const cards = (data?.cards || []).filter((c) => !deck || c.deck === deck);
  const dueCards = cards.filter((c) => c.due);

  if (reviewing) return <ReviewSession cards={dueCards} onExit={() => { setReviewing(false); list.reload(); }} />;
  return (
    <>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <Button icon="wand" onClick={() => setAiOpen(true)}>Tạo bằng AI</Button>
        <Button variant="ghost" icon="plus" onClick={() => setEditing('new')}>Tự viết thẻ</Button>
        {dueCards.length > 0 && <Button variant="soft" icon="refresh" onClick={() => setReviewing(true)}>Ôn {dueCards.length} thẻ</Button>}
      </div>
      {list.loading && !data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {data && !data.total && <Empty title="Bạn chưa có thẻ riêng nào">Tự viết thẻ, hoặc bấm “Tạo bằng AI” để AI soạn thẻ từ một bài học hay ghi chú của bạn.</Empty>}
      {data && data.total > 0 && (
        <>
          <div className="fc-chips" style={{ marginBottom: 10 }}>
            <span className="fc-chip fc-chip-brand"><b>{data.due}</b> cần ôn hôm nay</span>
            <span className="fc-chip"><b>{data.total}</b> thẻ</span>
            <span className="fc-chip"><b>{data.learned}</b> đã nhớ</span>
          </div>
          {decks.length > 0 && (
            <FilterPills label="Chủ đề" value={deck} onChange={setDeck}
              options={[{ id: '', label: 'Tất cả', count: data.total }, ...decks.map((d) => ({ id: d, label: d, count: data.cards.filter((c) => c.deck === d).length }))]} />
          )}
          <div className="fc-library-list">
            {cards.map((c) => (
              <article className="fc-library-card" key={c.card_id}>
                <div className="fc-library-heading">
                  <span className="muted small">{[c.deck, c.origin === 'ai' ? 'AI soạn' : 'Tự viết'].filter(Boolean).join(' · ')}</span>
                  <span className={`fc-chip ${c.remembered ? 'fc-chip-brand' : ''}`}>{c.new ? 'Mới' : c.remembered ? 'Đã nhớ' : 'Chưa nhớ'}</span>
                </div>
                <strong>{c.front}</strong>
                <details><summary>Xem đáp án</summary><p>{c.back}</p></details>
                <div className="row" style={{ gap: 6 }}>
                  <Button variant="ghost" size="sm" icon="edit" onClick={() => setEditing(c)}>Sửa</Button>
                  <Button variant="danger-ghost" size="sm" onClick={async () => {
                    if (!await confirmDialog('Xóa thẻ này?', { title: 'Xóa thẻ', okLabel: 'Xóa', danger: true })) return;
                    try { await api(`/ai/learn/my-flashcards/${c.card_id}`, { method: 'DELETE' }); list.reload(); } catch { list.reload(); }
                  }}>Xóa</Button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
      {editing && <CardEditor card={editing === 'new' ? null : editing} decks={decks} defaultDeck={deck}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); }} />}
      {aiOpen && <AiGenerate decks={decks} onClose={() => setAiOpen(false)} onDone={(d) => { setAiOpen(false); setDeck(d); list.reload(); }} />}
    </>
  );
}

function CardEditor({ card, decks, defaultDeck, onClose, onSaved }: {
  card: MyCard | null; decks: string[]; defaultDeck: string; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const [front, setFront] = useState(card?.front || '');
  const [back, setBack] = useState(card?.back || '');
  const [deck, setDeck] = useState(card?.deck ?? defaultDeck);
  const [busy, setBusy] = useState(false);
  const [again, setAgain] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (card) await api(`/ai/learn/my-flashcards/${card.card_id}`, { method: 'PATCH', json: { front, back, deck } });
      else await api('/ai/learn/my-flashcards', { json: { front, back, deck } });
      toast(card ? 'Đã lưu thẻ' : 'Đã thêm thẻ', 'success');
      if (!card && again) { setFront(''); setBack(''); } else onSaved();
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open title={card ? 'Sửa thẻ' : 'Tự viết thẻ'} onClose={again ? onSaved : onClose}>
      <form className="modal-body" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Mặt trước (câu hỏi, khái niệm)"><textarea value={front} onChange={(e) => setFront(e.target.value)} maxLength={300} rows={3} autoFocus /></Field>
        <Field label="Mặt sau (đáp án)"><textarea value={back} onChange={(e) => setBack(e.target.value)} maxLength={600} rows={4} /></Field>
        <Field label="Chủ đề (không bắt buộc)" hint="Gom các thẻ cùng chủ đề để lọc và ôn riêng.">
          <input value={deck} onChange={(e) => setDeck(e.target.value)} maxLength={120} list="my-fc-decks" placeholder="Ví dụ: OOP chương 1" />
        </Field>
        <datalist id="my-fc-decks">{decks.map((d) => <option key={d} value={d} />)}</datalist>
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {!card && <label className="row small" style={{ gap: 6, marginRight: 'auto' }}>
            <input type="checkbox" checked={again} onChange={(e) => setAgain(e.target.checked)} /> Thêm tiếp thẻ khác
          </label>}
          <Button type="button" variant="ghost" onClick={again ? onSaved : onClose}>{again ? 'Xong' : 'Hủy'}</Button>
          <Button type="submit" loading={busy} disabled={!front.trim() || !back.trim()}>{card ? 'Lưu' : 'Thêm thẻ'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function AiGenerate({ decks, onClose, onDone }: { decks: string[]; onClose: () => void; onDone: (deck: string) => void }) {
  const toast = useToast();
  const trees = useCourseTrees();
  const lessons = (trees.data || []).flatMap((c) => c.lessons.filter((l) => l.code).map((l) => ({ ...l, course: c.title })));
  const [mode, setMode] = useState<'lesson' | 'text'>('lesson');
  const [lesson, setLesson] = useState('');
  const [text, setText] = useState('');
  const [deck, setDeck] = useState('');
  const [count, setCount] = useState(10);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!lesson && lessons[0]) setLesson(lessons[0].code); }, [lessons.length]);
  const canGo = mode === 'lesson' ? !!lesson : text.trim().length >= 3;
  const go = async () => {
    setBusy(true);
    try {
      const body = mode === 'lesson' ? { count, lesson_code: lesson, deck: deck || undefined } : { count, text, deck: deck || undefined };
      const r = await api<MyCard[]>('/ai/learn/my-flashcards/generate', { json: body });
      toast(`AI đã soạn ${r.length} thẻ vào Thẻ của tôi`, 'success');
      onDone(r[0]?.deck || '');
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open title="Tạo thẻ bằng AI" onClose={busy ? undefined : onClose} dismissable={!busy}>
      <form className="modal-body" onSubmit={(e) => { e.preventDefault(); if (canGo) void go(); }}>
        <div className="seg" role="group" aria-label="Nguồn để AI soạn">
          <button type="button" className={mode === 'lesson' ? 'on' : ''} onClick={() => setMode('lesson')}>Từ bài học</button>
          <button type="button" className={mode === 'text' ? 'on' : ''} onClick={() => setMode('text')}>Từ ghi chú của tôi</button>
        </div>
        {mode === 'lesson' ? (
          trees.loading && !trees.data ? <Spinner /> : lessons.length ? (
            <Field label="Bài học" hint="AI chỉ dùng học liệu của bài này (bài đọc, slide, lời giảng).">
              <select value={lesson} onChange={(e) => setLesson(e.target.value)}>
                {lessons.map((l) => <option key={l.lesson_id} value={l.code}>{l.course} · {l.title}</option>)}
              </select>
            </Field>
          ) : <p className="muted small">Bạn chưa có bài học nào. Chuyển sang “Từ ghi chú của tôi” để dán nội dung.</p>
        ) : (
          <Field label="Chủ đề hoặc ghi chú" hint="Dán ghi chú, đoạn bài giảng, hoặc gõ một chủ đề ngắn.">
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={7} maxLength={12000} placeholder="Ví dụ: 4 tính chất của lập trình hướng đối tượng" />
          </Field>
        )}
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <Field label="Số thẻ">
            <select value={count} onChange={(e) => setCount(Number(e.target.value))}>{[5, 10, 15, 20].map((v) => <option key={v} value={v}>{v} thẻ</option>)}</select>
          </Field>
          <div style={{ flex: 1, minWidth: 180 }}>
            <Field label="Chủ đề lưu vào (không bắt buộc)">
              <input value={deck} onChange={(e) => setDeck(e.target.value)} maxLength={120} list="my-fc-decks-ai" placeholder={mode === 'lesson' ? 'Mặc định: tên bài' : 'Ví dụ: Ghi chú OOP'} />
            </Field>
            <datalist id="my-fc-decks-ai">{decks.map((d) => <option key={d} value={d} />)}</datalist>
          </div>
        </div>
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Hủy</Button>
          <Button type="submit" icon="wand" loading={busy} disabled={!canGo}>AI soạn thẻ</Button>
        </div>
      </form>
    </Modal>
  );
}

function ReviewSession({ cards, onExit }: { cards: MyCard[]; onExit: () => void }) {
  const toast = useToast();
  const [queue, setQueue] = useState(cards);
  const [flipped, setFlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const card = queue[0];
  const total = done + queue.length;
  const rate = async (rating: string) => {
    if (!card || busy) return;
    setBusy(true);
    try {
      await api(`/ai/learn/my-flashcards/${card.card_id}/review`, { json: { rating } });
      setQueue((q) => (rating === 'again' ? [...q.slice(1), card] : q.slice(1)));
      if (rating !== 'again') setDone((n) => n + 1);
      setFlipped(false);
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ' && card && !flipped) { e.preventDefault(); setFlipped(true); return; }
      if (flipped) { const i = Number(e.key) - 1; if (i >= 0 && i < RATINGS.length) void rate(RATINGS[i].key); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="fc-bar">
        <Button variant="ghost" size="sm" icon="chevronLeft" onClick={onExit}>Thẻ của tôi</Button>
        {queue.length > 0 && <div className="fc-progress"><span>{done}/{total}</span><div style={{ width: 180 }}><Progress value={done / Math.max(1, total)} label="Tiến độ phiên ôn" /></div></div>}
      </div>
      {card ? (
        <div className="fc-session">
          <div className={`fc-stack ${queue.length > 1 ? 'fc-stack-more' : ''}`}>
            <button type="button" className={`fc-card ${flipped ? 'fc-flipped' : ''}`} onClick={() => setFlipped(true)} disabled={flipped} aria-label={flipped ? undefined : 'Lật thẻ'}>
              <span className="fc-kicker">{card.new ? 'Thẻ mới' : 'Ôn lại'}{card.deck ? ` · ${card.deck}` : ''}</span>
              <span className="fc-front">{card.front}</span>
              {flipped ? <span className="fc-back"><strong>{card.back}</strong></span> : <span className="fc-tap">Bấm vào thẻ hoặc nhấn Space để lật</span>}
            </button>
          </div>
          {!flipped ? <Button size="lg" onClick={() => setFlipped(true)} className="fc-flip">Lật thẻ</Button> : (
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
        <Empty title={done ? `Xong! Bạn đã ôn ${done} thẻ` : 'Không còn thẻ nào cần ôn'}>
          <Button onClick={onExit}>Về Thẻ của tôi</Button>
        </Empty>
      )}
    </div>
  );
}
