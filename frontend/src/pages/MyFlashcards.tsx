import { useEffect, useMemo, useState } from 'react';
import { FilterPills, SearchBox } from '../components/Manage';
import { useCourseTrees } from '../components/CourseScope';
import { Icon } from '../components/Icon';
import { Button, Empty, ErrorBox, Field, IconButton, Modal, Progress, Spinner, confirmDialog, useToast } from '../components/ui';
import { api, errorText } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Select } from '../components/Select';

interface MyCard {
  card_id: string; course_id: string | null; deck: string; front: string; back: string; origin: 'manual' | 'ai';
  new: boolean; due: boolean; remembered: boolean;
}
interface Deck { course_id: string | null; deck: string; total: number; due: number; learned: number }
interface CourseLite { course_id: string; title: string }
interface MyList { cards: MyCard[]; decks: Deck[]; courses: CourseLite[]; total: number; due: number; learned: number }
/** Một bộ thẻ = (khóa học, tên bộ). Một khóa có nhiều bộ; course_id null = thẻ ngoài khóa. */
interface DeckRef { course_id: string | null; deck: string }

const sameDeck = (a: DeckRef, b: DeckRef) => (a.course_id || null) === (b.course_id || null) && a.deck === b.deck;
const deckName = (d: string) => d || 'Chưa đặt tên bộ';
const NO_COURSE = 'Thẻ ngoài khóa học';

const RATINGS = [
  { key: 'again', label: 'Quên', hint: 'hỏi lại sau 10 phút', tone: 'again' },
  { key: 'hard', label: 'Khó', hint: 'ôn sớm hơn', tone: 'hard' },
  { key: 'good', label: 'Nhớ', hint: 'ôn theo lịch', tone: 'good' },
  { key: 'easy', label: 'Dễ', hint: 'giãn khoảng cách', tone: 'easy' },
];

type Draft = { card?: MyCard; deck?: DeckRef };

/** Tab "Thẻ của tôi": thẻ riêng xếp theo khóa học → các bộ thẻ trong khóa → thẻ trong bộ. */
export function MyFlashcards() {
  const list = useAsync((s) => api<MyList>('/ai/learn/my-flashcards', { signal: s }), []);
  const [open, setOpen] = useState<DeckRef | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [ai, setAi] = useState<{ course_id: string | null; deck?: string } | null>(null);
  const [review, setReview] = useState<MyCard[] | null>(null);
  const data = list.data;
  // Nhóm bộ thẻ theo khóa (theo thứ tự khóa học), "ngoài khóa" xếp cuối.
  const groups = useGroups(data);
  const courses = data?.courses || [];
  const titleOf = (id: string | null) => (id ? courses.find((c) => c.course_id === id)?.title || 'Khóa học' : NO_COURSE);

  const startReview = (cards: MyCard[]) => { if (cards.length) setReview(cards); };
  if (review) return <ReviewSession cards={review} onExit={() => { setReview(null); list.reload(); }} />;

  const modals = (
    <>
      {editing && data && <CardEditor draft={editing} courses={courses} decks={data.decks}
        onClose={() => setEditing(null)} onSaved={(ref) => { setEditing(null); list.reload(); if (open && ref && !sameDeck(open, ref) && !editing.card) setOpen(ref); }} />}
      {ai && data && <AiGenerate preset={ai} courses={courses} decks={data.decks}
        onClose={() => setAi(null)} onDone={(ref) => { setAi(null); list.reload(); if (ref) setOpen(ref); }} />}
    </>
  );

  if (open && data) {
    return (
      <>
        <DeckView deck={open} courseTitle={titleOf(open.course_id)} courses={courses} cards={data.cards.filter((c) => sameDeck(c, open))}
          onBack={() => setOpen(null)} onChanged={(ref) => { list.reload(); if (ref === null) setOpen(null); else if (ref) setOpen(ref); }}
          onAdd={() => setEditing({ deck: open })} onAi={() => setAi({ course_id: open.course_id, deck: open.deck })}
          onEdit={(card) => setEditing({ card })} onReview={startReview} reload={list.reload} />
        {modals}
      </>
    );
  }

  return (
    <>
      {list.loading && !data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {data && !data.total && (
        <div className="mf-empty">
          <span className="mf-empty-ico"><Icon name="copy" size={28} /></span>
          <strong>Tạo bộ thẻ đầu tiên của bạn</strong>
          <p className="muted">Mỗi khóa học có thể có nhiều bộ thẻ, ví dụ “Chương 1” hay “Ôn giữa kỳ”. Thẻ chỉ mình bạn thấy.</p>
          <div className="row" style={{ gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Button icon="wand" onClick={() => setAi({ course_id: courses[0]?.course_id || null })}>Nhờ AI soạn bộ thẻ</Button>
            <Button variant="ghost" icon="plus" onClick={() => setEditing({})}>Tự viết thẻ</Button>
          </div>
        </div>
      )}
      {data && data.total > 0 && (
        <>
          <div className="mf-top">
            <div className="fc-chips">
              <span className="fc-chip fc-chip-brand"><b>{data.due}</b> cần ôn hôm nay</span>
              <span className="fc-chip"><b>{data.total}</b> thẻ</span>
              <span className="fc-chip"><b>{data.learned}</b> đã nhớ</span>
            </div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {data.due > 0 && <Button icon="refresh" onClick={() => startReview(dueOrder(data.cards))}>Ôn tất cả {data.due} thẻ</Button>}
              <Button variant={data.due > 0 ? 'ghost' : 'green'} icon="wand" onClick={() => setAi({ course_id: courses[0]?.course_id || null })}>Tạo bằng AI</Button>
              <Button variant="ghost" icon="plus" onClick={() => setEditing({})}>Tự viết thẻ</Button>
            </div>
          </div>
          {groups.map((g) => (
            <section key={g.course_id || 'none'} className="mf-course">
              <header className="mf-course-head">
                <span className="mf-course-ico"><Icon name={g.course_id ? 'book' : 'tag'} size={18} /></span>
                <div className="mf-course-text">
                  <h3>{titleOf(g.course_id)}</h3>
                  <span className="muted small">{g.decks.length} bộ thẻ · {g.total} thẻ{g.due ? ` · ${g.due} cần ôn` : ''}</span>
                </div>
                {g.due > 0 && <Button size="sm" variant="soft" icon="refresh"
                  onClick={() => startReview(dueOrder(data.cards.filter((c) => (c.course_id || null) === g.course_id)))}>Ôn khóa này</Button>}
              </header>
              <div className="mf-deck-grid">
                {g.decks.map((d) => (
                  <button key={d.deck || '_'} type="button" className={`mf-deck ${d.due ? 'mf-deck-due' : ''}`} onClick={() => setOpen({ course_id: d.course_id, deck: d.deck })}>
                    <span className="mf-deck-name">{deckName(d.deck)}</span>
                    <span className="mf-deck-meta">{d.total} thẻ · {d.learned} đã nhớ</span>
                    <Progress value={d.learned / Math.max(1, d.total)} height={6} label={`Đã nhớ ${d.learned}/${d.total}`} />
                    {d.due > 0 ? <span className="fc-deck-due-pill">{d.due} cần ôn</span> : <span className="fc-deck-ok"><Icon name="check" size={14} /> Đã ôn xong</span>}
                  </button>
                ))}
                {g.course_id && (
                  <button type="button" className="mf-deck mf-deck-new" onClick={() => setAi({ course_id: g.course_id })}>
                    <Icon name="plus" size={22} />
                    <span>Bộ thẻ mới</span>
                  </button>
                )}
              </div>
            </section>
          ))}
        </>
      )}
      {modals}
    </>
  );
}

function useGroups(data: MyList | null | undefined) {
  return useMemo(() => {
    if (!data) return [];
    const by = new Map<string | null, { course_id: string | null; decks: Deck[]; total: number; due: number }>();
    for (const d of data.decks) {
      const key = d.course_id || null;
      const g = by.get(key) || { course_id: key, decks: [], total: 0, due: 0 };
      g.decks.push(d); g.total += d.total; g.due += d.due;
      by.set(key, g);
    }
    const order = data.courses.map((c) => c.course_id);
    return [...by.values()].sort((a, b) => (a.course_id === null ? 1 : b.course_id === null ? -1 : order.indexOf(a.course_id) - order.indexOf(b.course_id)));
  }, [data]);
}

/** Thẻ đến hạn: thẻ đã học quá hạn trước, thẻ mới sau. */
const dueOrder = (cards: MyCard[]) => cards.filter((c) => c.due).sort((a, b) => Number(a.new) - Number(b.new));

type CardFilter = 'all' | 'due' | 'unremembered' | 'remembered';

function DeckView({ deck, courseTitle, courses, cards, onBack, onChanged, onAdd, onAi, onEdit, onReview, reload }: {
  deck: DeckRef; courseTitle: string; courses: CourseLite[]; cards: MyCard[]; onBack: () => void;
  onChanged: (ref?: DeckRef | null) => void; onAdd: () => void; onAi: () => void; onEdit: (c: MyCard) => void;
  onReview: (cards: MyCard[]) => void; reload: () => void;
}) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<CardFilter>('all');
  const [renaming, setRenaming] = useState(false);
  const due = dueOrder(cards);
  const learned = cards.filter((c) => c.remembered).length;
  const shown = cards.filter((c) => (filter === 'all' || (filter === 'due' ? c.due : filter === 'remembered' ? c.remembered : !c.remembered))
    && (!q || `${c.front} ${c.back}`.toLowerCase().includes(q.toLowerCase())));

  const removeCard = async (c: MyCard) => {
    if (!await confirmDialog('Xóa thẻ này?', { title: 'Xóa thẻ', okLabel: 'Xóa', danger: true })) return;
    try { await api(`/ai/learn/my-flashcards/${c.card_id}`, { method: 'DELETE' }); toast('Đã xóa thẻ', 'success'); }
    catch (e) { toast(errorText(e), 'error'); }
    if (cards.length <= 1) onChanged(null); else reload();
  };
  const removeDeck = async () => {
    if (!await confirmDialog(`Xóa bộ “${deckName(deck.deck)}” cùng ${cards.length} thẻ? Không hoàn tác được.`, { title: 'Xóa bộ thẻ', okLabel: 'Xóa bộ thẻ', danger: true })) return;
    try { await api('/ai/learn/my-flashcards/decks/delete', { json: deck }); toast('Đã xóa bộ thẻ', 'success'); onChanged(null); }
    catch (e) { toast(errorText(e), 'error'); }
  };

  return (
    <div className="col" style={{ gap: 14 }}>
      <button type="button" className="mf-back" onClick={onBack}><Icon name="chevronLeft" size={16} /> Thẻ của tôi</button>
      <div className="mf-deck-head">
        <div className="mf-deck-title">
          <span className="muted small">{courseTitle}</span>
          <h2>{deckName(deck.deck)}</h2>
          <div className="fc-chips">
            <span className="fc-chip fc-chip-brand"><b>{due.length}</b> cần ôn</span>
            <span className="fc-chip"><b>{cards.length}</b> thẻ</span>
            <span className="fc-chip"><b>{learned}</b> đã nhớ</span>
          </div>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <Button icon="refresh" disabled={!cards.length} onClick={() => onReview(due.length ? due : cards)}>{due.length ? `Ôn ${due.length} thẻ` : 'Ôn lại cả bộ'}</Button>
          <Button variant="ghost" icon="plus" onClick={onAdd}>Thêm thẻ</Button>
          <Button variant="ghost" icon="wand" onClick={onAi}>AI soạn thêm</Button>
          <IconButton icon="edit" label="Đổi tên hoặc chuyển khóa" onClick={() => setRenaming(true)} />
          <IconButton icon="trash" label="Xóa bộ thẻ" onClick={removeDeck} />
        </div>
      </div>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <SearchBox value={q} onChange={setQ} placeholder="Tìm trong bộ thẻ…" />
        <FilterPills<CardFilter> label="Lọc thẻ" value={filter} onChange={setFilter} options={[
          { id: 'all', label: 'Tất cả', count: cards.length }, { id: 'due', label: 'Cần ôn', count: due.length },
          { id: 'unremembered', label: 'Chưa nhớ', count: cards.length - learned }, { id: 'remembered', label: 'Đã nhớ', count: learned },
        ]} />
      </div>
      {!cards.length && <Empty title="Bộ này chưa có thẻ">Bấm “Thêm thẻ” hoặc “AI soạn thêm”.</Empty>}
      {!!cards.length && !shown.length && <Empty title="Không có thẻ nào khớp">Thử bỏ bớt bộ lọc hoặc từ khóa.</Empty>}
      <div className="mf-card-grid">
        {shown.map((c) => (
          <article key={c.card_id} className="mf-card" onClick={() => onEdit(c)}>
            <div className="mf-card-front">{c.front}</div>
            <div className="mf-card-back">{c.back}</div>
            <footer>
              <span className={`mf-dot ${c.due ? 'mf-dot-due' : c.remembered ? 'mf-dot-ok' : ''}`} />
              <span className="muted small">{c.due ? (c.new ? 'Mới' : 'Cần ôn') : c.remembered ? 'Đã nhớ' : 'Chưa nhớ'}{c.origin === 'ai' ? ' · AI soạn' : ''}</span>
              <span style={{ flex: 1 }} />
              <span onClick={(e) => e.stopPropagation()} className="row" style={{ gap: 0 }}>
                <IconButton icon="edit" label="Sửa thẻ" onClick={() => onEdit(c)} />
                <IconButton icon="trash" label="Xóa thẻ" onClick={() => removeCard(c)} />
              </span>
            </footer>
          </article>
        ))}
      </div>
      {renaming && <RenameDeck deck={deck} courses={courses} onClose={() => setRenaming(false)}
        onDone={(ref) => { setRenaming(false); onChanged(ref); }} />}
    </div>
  );
}

function CourseSelect({ value, onChange, courses, label = 'Khóa học' }: { value: string; onChange: (v: string) => void; courses: CourseLite[]; label?: string }) {
  return (
    <Field label={label}>
      <Select value={value} onChange={(v) => onChange(v)}>
        {courses.map((c) => <option key={c.course_id} value={c.course_id}>{c.title}</option>)}
        <option value="">{NO_COURSE}</option>
      </Select>
    </Field>
  );
}

function DeckInput({ value, onChange, decks, course, placeholder }: { value: string; onChange: (v: string) => void; decks: Deck[]; course: string; placeholder?: string }) {
  const names = [...new Set(decks.filter((d) => (d.course_id || '') === course && d.deck).map((d) => d.deck))];
  const id = `mf-decks-${course || 'none'}`;
  return (
    <Field label="Bộ thẻ" hint={names.length ? 'Chọn bộ có sẵn hoặc gõ tên mới để tạo bộ mới.' : 'Gõ tên để tạo bộ thẻ mới, ví dụ “Chương 1”.'}>
      <input value={value} onChange={(e) => onChange(e.target.value)} maxLength={120} list={id} placeholder={placeholder || 'Ví dụ: Chương 1'} />
      <datalist id={id}>{names.map((d) => <option key={d} value={d} />)}</datalist>
    </Field>
  );
}

function CardEditor({ draft, courses, decks, onClose, onSaved }: {
  draft: Draft; courses: CourseLite[]; decks: Deck[]; onClose: () => void; onSaved: (ref?: DeckRef) => void;
}) {
  const toast = useToast();
  const card = draft.card;
  const [front, setFront] = useState(card?.front || '');
  const [back, setBack] = useState(card?.back || '');
  const [course, setCourse] = useState(card ? card.course_id || '' : draft.deck ? draft.deck.course_id || '' : courses[0]?.course_id || '');
  const [deck, setDeck] = useState(card?.deck ?? draft.deck?.deck ?? '');
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState(0);
  const save = async (another: boolean) => {
    setBusy(true);
    try {
      const body = { front, back, deck, course_id: course };
      if (card) await api(`/ai/learn/my-flashcards/${card.card_id}`, { method: 'PATCH', json: body });
      else await api('/ai/learn/my-flashcards', { json: body });
      if (another) { setFront(''); setBack(''); setAdded((n) => n + 1); toast('Đã thêm, viết tiếp thẻ sau nhé', 'success'); }
      else { toast(card ? 'Đã lưu thẻ' : 'Đã thêm thẻ', 'success'); onSaved({ course_id: course || null, deck: deck.trim() }); }
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  const close = added ? () => onSaved({ course_id: course || null, deck: deck.trim() }) : onClose;
  const ok = front.trim() && back.trim();
  return (
    <Modal open title={card ? 'Sửa thẻ' : 'Thêm thẻ'} onClose={close}>
      <form className="modal-body" onSubmit={(e) => { e.preventDefault(); if (ok) void save(false); }}>
        <div className="fc-preview" aria-label="Xem trước thẻ">
          <div><span>Mặt trước</span><p>{front || '…'}</p></div>
          <div><span>Mặt sau</span><p>{back || '…'}</p></div>
        </div>
        <Field label="Mặt trước (câu hỏi, khái niệm)"><textarea value={front} onChange={(e) => setFront(e.target.value)} maxLength={300} rows={2} autoFocus /></Field>
        <Field label="Mặt sau (đáp án)"><textarea value={back} onChange={(e) => setBack(e.target.value)} maxLength={600} rows={3} /></Field>
        <div className="mf-two">
          <CourseSelect value={course} onChange={setCourse} courses={courses} />
          <DeckInput value={deck} onChange={setDeck} decks={decks} course={course} />
        </div>
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {added > 0 && <span className="muted small" style={{ marginRight: 'auto' }}>Đã thêm {added} thẻ</span>}
          <Button type="button" variant="ghost" onClick={close}>{added ? 'Xong' : 'Hủy'}</Button>
          {!card && <Button type="button" variant="soft" disabled={!ok || busy} onClick={() => save(true)}>Lưu và viết tiếp</Button>}
          <Button type="submit" loading={busy} disabled={!ok}>{card ? 'Lưu' : 'Thêm thẻ'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function AiGenerate({ preset, courses, decks, onClose, onDone }: {
  preset: { course_id: string | null; deck?: string }; courses: CourseLite[]; decks: Deck[];
  onClose: () => void; onDone: (ref?: DeckRef) => void;
}) {
  const toast = useToast();
  const trees = useCourseTrees();
  const [course, setCourse] = useState(preset.course_id || '');
  const lessons = (trees.data || []).filter((c) => c.course_id === course).flatMap((c) => c.lessons.filter((l) => l.code));
  const [mode, setMode] = useState<'lesson' | 'text'>(preset.course_id ? 'lesson' : 'text');
  const [lesson, setLesson] = useState('');
  const [text, setText] = useState('');
  const [deck, setDeck] = useState(preset.deck || '');
  const [count, setCount] = useState(10);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!lessons.some((l) => l.code === lesson)) setLesson(lessons[0]?.code || ''); }, [course, lessons.length]);
  useEffect(() => { if (!course && mode === 'lesson') setMode('text'); }, [course]);
  const canGo = mode === 'lesson' ? !!lesson : text.trim().length >= 3;
  const go = async () => {
    setBusy(true);
    try {
      const body = mode === 'lesson' ? { count, lesson_code: lesson, deck: deck || undefined } : { count, text, deck: deck || undefined, course_id: course || undefined };
      const r = await api<MyCard[]>('/ai/learn/my-flashcards/generate', { json: body });
      toast(`AI đã soạn ${r.length} thẻ`, 'success');
      onDone(r[0] ? { course_id: r[0].course_id, deck: r[0].deck } : undefined);
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open title="Tạo thẻ bằng AI" onClose={busy ? undefined : onClose} dismissable={!busy}>
      <form className="modal-body" onSubmit={(e) => { e.preventDefault(); if (canGo) void go(); }}>
        <CourseSelect value={course} onChange={setCourse} courses={courses} label="Thẻ thuộc khóa học" />
        <div className="seg" role="group" aria-label="Nguồn để AI soạn">
          <button type="button" className={mode === 'lesson' ? 'on' : ''} disabled={!course} onClick={() => setMode('lesson')}>Từ bài học</button>
          <button type="button" className={mode === 'text' ? 'on' : ''} onClick={() => setMode('text')}>Từ ghi chú của tôi</button>
        </div>
        {mode === 'lesson' ? (
          trees.loading && !trees.data ? <Spinner /> : lessons.length ? (
            <Field label="Bài học" hint="AI chỉ dùng học liệu của bài này (bài đọc, slide, lời giảng).">
              <Select value={lesson} onChange={(v) => setLesson(v)}>
                {lessons.map((l) => <option key={l.lesson_id} value={l.code}>{l.title}</option>)}
              </Select>
            </Field>
          ) : <p className="muted small">Khóa này chưa có bài học. Chuyển sang “Từ ghi chú của tôi” để dán nội dung.</p>
        ) : (
          <Field label="Chủ đề hoặc ghi chú" hint="Dán ghi chú, đoạn bài giảng, hoặc gõ một chủ đề ngắn.">
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} maxLength={12000} placeholder="Ví dụ: 4 tính chất của lập trình hướng đối tượng" />
          </Field>
        )}
        <div className="mf-two">
          <DeckInput value={deck} onChange={setDeck} decks={decks} course={course} placeholder={mode === 'lesson' ? 'Mặc định: tên bài' : 'Ví dụ: Ôn giữa kỳ'} />
          <Field label="Số thẻ">
            <Select value={count} onChange={(v) => setCount(Number(v))}>{[5, 10, 15, 20].map((v) => <option key={v} value={v}>{v} thẻ</option>)}</Select>
          </Field>
        </div>
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Hủy</Button>
          <Button type="submit" icon="wand" loading={busy} disabled={!canGo}>{busy ? 'AI đang soạn…' : 'AI soạn thẻ'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function RenameDeck({ deck, courses, onClose, onDone }: { deck: DeckRef; courses: CourseLite[]; onClose: () => void; onDone: (ref: DeckRef) => void }) {
  const toast = useToast();
  const [name, setName] = useState(deck.deck);
  const [course, setCourse] = useState(deck.course_id || '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api('/ai/learn/my-flashcards/decks/rename', { json: { ...deck, new_deck: name, new_course_id: course } });
      toast('Đã cập nhật bộ thẻ', 'success'); onDone({ course_id: course || null, deck: name.trim() });
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open title="Đổi tên bộ thẻ" onClose={onClose}>
      <form className="modal-body" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Tên bộ thẻ"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus /></Field>
        <CourseSelect value={course} onChange={setCourse} courses={courses} label="Thuộc khóa học" />
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={onClose}>Hủy</Button>
          <Button type="submit" loading={busy}>Lưu</Button>
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
        <button type="button" className="mf-back" onClick={onExit}><Icon name="chevronLeft" size={16} /> Thẻ của tôi</button>
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
