import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import { api, errorText } from '../lib/api';
import { C, R } from '../lib/theme';
import { Text, TextInput } from './Text';
import { Button, ErrorBox, Muted, Row, Spinner } from './ui';

/** Thẻ riêng ("Thẻ của tôi"): xếp theo khóa học → bộ thẻ (một khóa có nhiều bộ) → thẻ. */
export interface MyCard {
  card_id: string; course_id: string | null; deck: string; front: string; back: string; origin: 'manual' | 'ai';
  new: boolean; due: boolean; remembered: boolean;
}
export interface Deck { course_id: string | null; deck: string; total: number; due: number; learned: number }
export interface CourseLite { course_id: string; title: string }
export interface MyList { cards: MyCard[]; decks: Deck[]; courses: CourseLite[]; total: number; due: number; learned: number }
export interface DeckRef { course_id: string | null; deck: string }

export const NO_COURSE = 'Thẻ ngoài khóa học';
export const deckName = (d: string) => d || 'Chưa đặt tên bộ';
export const sameDeck = (a: DeckRef, b: DeckRef) => (a.course_id || null) === (b.course_id || null) && a.deck === b.deck;
export const dueOrder = (cards: MyCard[]) => cards.filter((c) => c.due).sort((a, b) => Number(a.new) - Number(b.new));

const input = { borderWidth: 1, borderColor: C.line, borderRadius: R.sm, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: C.ink, backgroundColor: C.card } as const;

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' }}>
        <View style={{ backgroundColor: C.bg, borderTopLeftRadius: R.xl, borderTopRightRadius: R.xl, maxHeight: '90%' }}>
          <Row style={{ justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6 }}>
            <Text style={{ fontSize: 19, fontWeight: '700' }}>{title}</Text>
            <Pressable onPress={onClose} accessibilityLabel="Đóng" hitSlop={10}><Ionicons name="close" size={24} color={C.muted} /></Pressable>
          </Row>
          <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 8, gap: 12, paddingBottom: 36 }} keyboardShouldPersistTaps="handled">{children}</ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <Text style={{ fontSize: 14, fontWeight: '600', color: C.ink }}>{children}</Text>;
}

/** Hàng chip chọn một giá trị (thay cho dropdown, dễ bấm trên điện thoại). */
function Chips<T extends string>({ options, value, onChange }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <Pressable key={o.id || '_'} onPress={() => onChange(o.id)} style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: on ? C.brand : C.brandSoft }}>
            <Text style={{ color: on ? C.white : C.brandStrong, fontWeight: '600', fontSize: 14 }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function CoursePick({ value, onChange, courses }: { value: string; onChange: (v: string) => void; courses: CourseLite[] }) {
  return <Chips options={[...courses.map((c) => ({ id: c.course_id, label: c.title })), { id: '', label: NO_COURSE }]} value={value} onChange={onChange} />;
}

function DeckField({ value, onChange, decks, course, placeholder }: { value: string; onChange: (v: string) => void; decks: Deck[]; course: string; placeholder?: string }) {
  const names = [...new Set(decks.filter((d) => (d.course_id || '') === course && d.deck).map((d) => d.deck))];
  return (
    <View style={{ gap: 8 }}>
      <Label>Bộ thẻ</Label>
      <TextInput value={value} onChangeText={onChange} maxLength={120} placeholder={placeholder || 'Gõ tên bộ mới, ví dụ “Chương 1”'} style={input} />
      {names.length > 0 && <Chips options={names.map((n) => ({ id: n, label: n }))} value={value} onChange={onChange} />}
    </View>
  );
}

export function CardForm({ card, preset, courses, decks, onClose, onSaved }: {
  card?: MyCard; preset?: DeckRef; courses: CourseLite[]; decks: Deck[]; onClose: () => void; onSaved: (ref: DeckRef) => void;
}) {
  const [front, setFront] = useState(card?.front || '');
  const [back, setBack] = useState(card?.back || '');
  const [course, setCourse] = useState(card ? card.course_id || '' : preset ? preset.course_id || '' : courses[0]?.course_id || '');
  const [deck, setDeck] = useState(card?.deck ?? preset?.deck ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [added, setAdded] = useState(0);
  const ok = !!front.trim() && !!back.trim();
  const ref = () => ({ course_id: course || null, deck: deck.trim() });
  const save = async (another: boolean) => {
    setBusy(true); setErr(null);
    try {
      const body = { front, back, deck, course_id: course };
      if (card) await api(`/ai/learn/my-flashcards/${card.card_id}`, { method: 'PATCH', json: body });
      else await api('/ai/learn/my-flashcards', { json: body });
      if (another) { setFront(''); setBack(''); setAdded((n) => n + 1); } else onSaved(ref());
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  const close = added ? () => onSaved(ref()) : onClose;
  return (
    <Sheet title={card ? 'Sửa thẻ' : 'Thêm thẻ'} onClose={close}>
      <Label>Mặt trước (câu hỏi, khái niệm)</Label>
      <TextInput value={front} onChangeText={setFront} maxLength={300} multiline style={[input, { minHeight: 64 }]} autoFocus={!card} />
      <Label>Mặt sau (đáp án)</Label>
      <TextInput value={back} onChangeText={setBack} maxLength={600} multiline style={[input, { minHeight: 84 }]} />
      <Label>Khóa học</Label>
      <CoursePick value={course} onChange={setCourse} courses={courses} />
      <DeckField value={deck} onChange={setDeck} decks={decks} course={course} />
      {err && <ErrorBox message={err} />}
      {added > 0 && <Muted>Đã thêm {added} thẻ.</Muted>}
      <Button title={card ? 'Lưu' : 'Thêm thẻ'} busy={busy} disabled={!ok} onPress={() => save(false)} />
      {!card && <Button variant="soft" title="Lưu và viết tiếp" disabled={!ok || busy} onPress={() => save(true)} />}
    </Sheet>
  );
}

interface TreeLesson { lesson_id: string; code: string; title: string }
interface Tree { chapters: { lessons: TreeLesson[] }[] }

export function AiForm({ preset, courses, decks, onClose, onDone }: {
  preset: { course_id: string | null; deck?: string }; courses: CourseLite[]; decks: Deck[];
  onClose: () => void; onDone: (ref?: DeckRef) => void;
}) {
  const [course, setCourse] = useState(preset.course_id || '');
  const [mode, setMode] = useState<'lesson' | 'text'>(preset.course_id ? 'lesson' : 'text');
  const [lessons, setLessons] = useState<TreeLesson[] | null>(null);
  const [lesson, setLesson] = useState('');
  const [text, setText] = useState('');
  const [deck, setDeck] = useState(preset.deck || '');
  const [count, setCount] = useState<'5' | '10' | '15' | '20'>('10');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!course) { setLessons([]); setMode('text'); return; }
    setLessons(null);
    api<Tree>(`/ai/courses/${course}`).then((t) => {
      const ls = t.chapters.flatMap((ch) => ch.lessons).filter((l) => l.code);
      setLessons(ls); setLesson(ls[0]?.code || '');
    }).catch(() => setLessons([]));
  }, [course]);
  const canGo = mode === 'lesson' ? !!lesson : text.trim().length >= 3;
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const n = Number(count);
      const body = mode === 'lesson' ? { count: n, lesson_code: lesson, deck: deck || undefined } : { count: n, text, deck: deck || undefined, course_id: course || undefined };
      const r = await api<MyCard[]>('/ai/learn/my-flashcards/generate', { json: body, timeoutMs: 120000 });
      onDone(r[0] ? { course_id: r[0].course_id, deck: r[0].deck } : undefined);
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet title="Tạo thẻ bằng AI" onClose={busy ? () => {} : onClose}>
      <Label>Thẻ thuộc khóa học</Label>
      <CoursePick value={course} onChange={setCourse} courses={courses} />
      <Label>AI soạn từ</Label>
      <Chips options={course ? [{ id: 'lesson', label: 'Bài học' }, { id: 'text', label: 'Ghi chú của tôi' }] : [{ id: 'text', label: 'Ghi chú của tôi' }]} value={mode} onChange={setMode} />
      {mode === 'lesson' ? (
        lessons === null ? <Spinner /> : lessons.length ? (
          <View style={{ gap: 6 }}>
            {lessons.map((l) => (
              <Pressable key={l.lesson_id} onPress={() => setLesson(l.code)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: R.sm, borderWidth: 1, borderColor: lesson === l.code ? C.brand : C.line, backgroundColor: lesson === l.code ? C.brandSoft : C.card }}>
                <Ionicons name={lesson === l.code ? 'radio-button-on' : 'radio-button-off'} size={18} color={lesson === l.code ? C.brand : C.muted} />
                <Text style={{ flex: 1, fontSize: 15 }}>{l.title}</Text>
              </Pressable>
            ))}
          </View>
        ) : <Muted>Khóa này chưa có bài học. Chọn “Ghi chú của tôi” để dán nội dung.</Muted>
      ) : (
        <TextInput value={text} onChangeText={setText} maxLength={12000} multiline placeholder="Dán ghi chú hoặc gõ chủ đề, ví dụ: 4 tính chất của OOP" style={[input, { minHeight: 120 }]} />
      )}
      <DeckField value={deck} onChange={setDeck} decks={decks} course={course} placeholder={mode === 'lesson' ? 'Mặc định: tên bài' : 'Ví dụ: Ôn giữa kỳ'} />
      <Label>Số thẻ</Label>
      <Chips options={(['5', '10', '15', '20'] as const).map((v) => ({ id: v, label: `${v} thẻ` }))} value={count} onChange={setCount} />
      {err && <ErrorBox message={err} />}
      <Button title={busy ? 'AI đang soạn…' : 'AI soạn thẻ'} icon="sparkles-outline" busy={busy} disabled={!canGo} onPress={go} />
    </Sheet>
  );
}

export function RenameForm({ deck, courses, onClose, onDone }: { deck: DeckRef; courses: CourseLite[]; onClose: () => void; onDone: (ref: DeckRef) => void }) {
  const [name, setName] = useState(deck.deck);
  const [course, setCourse] = useState(deck.course_id || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api('/ai/learn/my-flashcards/decks/rename', { json: { ...deck, new_deck: name, new_course_id: course } });
      onDone({ course_id: course || null, deck: name.trim() });
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet title="Đổi tên bộ thẻ" onClose={onClose}>
      <Label>Tên bộ thẻ</Label>
      <TextInput value={name} onChangeText={setName} maxLength={120} style={input} autoFocus />
      <Label>Thuộc khóa học</Label>
      <CoursePick value={course} onChange={setCourse} courses={courses} />
      {err && <ErrorBox message={err} />}
      <Button title="Lưu" busy={busy} onPress={save} />
    </Sheet>
  );
}
