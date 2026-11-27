import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import { AiForm, CardForm, NO_COURSE, RenameForm, deckName, dueOrder, sameDeck, type DeckRef, type MyCard, type MyList } from '../../../components/MyCards';
import { Text, TextInput } from '../../../components/Text';
import { Button, Empty, ErrorBox, Muted, Pill, Progress, Row, Screen, Spinner, Tag } from '../../../components/ui';
import { api, errorText } from '../../../lib/api';
import { useAsync } from '../../../lib/hooks';
import { C, R } from '../../../lib/theme';

type Filter = 'all' | 'due' | 'unremembered' | 'remembered';

/** Một bộ thẻ: xem, tìm, sửa, xóa thẻ và ôn. all=1: ôn mọi thẻ đến hạn; all=course: ôn thẻ đến hạn của khóa. */
export default function DeckScreen() {
  const p = useLocalSearchParams<{ course?: string; deck?: string; all?: string; review?: string }>();
  const nav = useNavigation();
  const [ref, setRef] = useState<DeckRef>({ course_id: p.course || null, deck: p.deck || '' });
  const list = useAsync((signal) => api<MyList>('/ai/learn/my-flashcards', { signal }), []);
  const [reviewing, setReviewing] = useState<MyCard[] | null>(null);
  const [editing, setEditing] = useState<MyCard | 'new' | null>(null);
  const [ai, setAi] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const data = list.data;
  const courses = data?.courses || [];
  const courseTitle = ref.course_id ? courses.find((c) => c.course_id === ref.course_id)?.title || 'Khóa học' : NO_COURSE;
  const scoped = p.all === '1' ? (data?.cards || []) : p.all === 'course' ? (data?.cards || []).filter((c) => (c.course_id || null) === ref.course_id) : null;
  const cards = scoped || (data?.cards || []).filter((c) => sameDeck(c, ref));
  const due = dueOrder(cards);
  const learned = cards.filter((c) => c.remembered).length;

  useEffect(() => { nav.setOptions({ title: p.all === '1' ? 'Ôn thẻ của tôi' : p.all === 'course' ? courseTitle : deckName(ref.deck) }); }, [ref.deck, courseTitle]);
  useEffect(() => { if (p.review === '1' && data && reviewing === null) setReviewing(dueOrder(cards)); }, [data]);

  if (reviewing) return <Review cards={reviewing} onExit={() => { setReviewing(null); list.reload(); if (scoped) router.back(); }} />;

  const shown = cards.filter((c) => (filter === 'all' || (filter === 'due' ? c.due : filter === 'remembered' ? c.remembered : !c.remembered))
    && (!q || `${c.front} ${c.back}`.toLowerCase().includes(q.toLowerCase())));
  const removeCard = (c: MyCard) => Alert.alert('Xóa thẻ', 'Xóa thẻ này?', [{ text: 'Hủy', style: 'cancel' }, {
    text: 'Xóa', style: 'destructive', onPress: async () => {
      try { await api(`/ai/learn/my-flashcards/${c.card_id}`, { method: 'DELETE' }); } catch (e) { Alert.alert('Lỗi', errorText(e)); }
      list.reload();
    },
  }]);
  const removeDeck = () => Alert.alert('Xóa bộ thẻ', `Xóa bộ “${deckName(ref.deck)}” cùng ${cards.length} thẻ? Không hoàn tác được.`, [{ text: 'Hủy', style: 'cancel' }, {
    text: 'Xóa bộ thẻ', style: 'destructive', onPress: async () => {
      try { await api('/ai/learn/my-flashcards/decks/delete', { json: ref }); router.back(); } catch (e) { Alert.alert('Lỗi', errorText(e)); }
    },
  }]);

  return (
    <Screen onRefresh={list.reload} refreshing={list.loading && !!data}>
      {list.loading && !data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {data && (
        <>
          <View style={{ gap: 4 }}>
            <Muted style={{ fontSize: 13 }}>{courseTitle}</Muted>
            <Text style={{ fontSize: 24, fontWeight: '800' }}>{deckName(ref.deck)}</Text>
          </View>
          <Row style={{ flexWrap: 'wrap' }}>
            <Tag tone="brand" label={`${due.length} cần ôn`} />
            <Tag label={`${cards.length} thẻ`} />
            <Tag tone="ok" label={`${learned} đã nhớ`} />
          </Row>
          <Button icon="refresh" title={due.length ? `Ôn ${due.length} thẻ` : 'Ôn lại cả bộ'} disabled={!cards.length} onPress={() => setReviewing(due.length ? due : cards)} />
          <Row>
            <Button style={{ flex: 1 }} small variant="soft" icon="add" title="Thêm thẻ" onPress={() => setEditing('new')} />
            <Button style={{ flex: 1 }} small variant="soft" icon="sparkles-outline" title="AI soạn thêm" onPress={() => setAi(true)} />
            <Pressable onPress={() => setRenaming(true)} accessibilityLabel="Đổi tên bộ thẻ" style={{ padding: 8 }}><Ionicons name="create-outline" size={22} color={C.muted} /></Pressable>
            <Pressable onPress={removeDeck} accessibilityLabel="Xóa bộ thẻ" style={{ padding: 8 }}><Ionicons name="trash-outline" size={22} color={C.muted} /></Pressable>
          </Row>
          <TextInput value={q} onChangeText={setQ} placeholder="Tìm trong bộ thẻ…"
            style={{ borderRadius: 999, backgroundColor: C.card, borderWidth: 1, borderColor: C.line, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, color: C.ink }} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            <Pill label="Tất cả" count={cards.length} active={filter === 'all'} onPress={() => setFilter('all')} />
            <Pill label="Cần ôn" count={due.length} active={filter === 'due'} onPress={() => setFilter('due')} />
            <Pill label="Chưa nhớ" count={cards.length - learned} active={filter === 'unremembered'} onPress={() => setFilter('unremembered')} />
            <Pill label="Đã nhớ" count={learned} active={filter === 'remembered'} onPress={() => setFilter('remembered')} />
          </ScrollView>
          {!cards.length && <Empty title="Bộ này chưa có thẻ" icon="layers-outline">Bấm “Thêm thẻ” hoặc “AI soạn thêm”.</Empty>}
          {!!cards.length && !shown.length && <Empty title="Không có thẻ nào khớp" icon="search-outline" />}
          {shown.map((c) => (
            <Pressable key={c.card_id} onPress={() => setEditing(c)}
              style={({ pressed }) => ({ borderRadius: R.md, borderWidth: 1, borderColor: C.cardLine, backgroundColor: C.card, overflow: 'hidden', opacity: pressed ? 0.9 : 1 })}>
              <Text style={{ padding: 14, paddingBottom: 10, fontSize: 16, fontWeight: '600' }}>{c.front}</Text>
              <Text style={{ paddingHorizontal: 14, paddingBottom: 12, paddingTop: 10, color: C.muted, borderTopWidth: 1, borderTopColor: C.line, borderStyle: 'dashed' }}>{c.back}</Text>
              <Row style={{ backgroundColor: C.wash, paddingLeft: 14, paddingRight: 4 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.due ? C.brand : c.remembered ? C.ok : C.line }} />
                <Muted style={{ flex: 1, fontSize: 13 }}>{c.due ? (c.new ? 'Mới' : 'Cần ôn') : c.remembered ? 'Đã nhớ' : 'Chưa nhớ'}{c.origin === 'ai' ? ' · AI soạn' : ''}</Muted>
                <Pressable onPress={() => setEditing(c)} accessibilityLabel="Sửa thẻ" style={{ padding: 10 }}><Ionicons name="create-outline" size={19} color={C.muted} /></Pressable>
                <Pressable onPress={() => removeCard(c)} accessibilityLabel="Xóa thẻ" style={{ padding: 10 }}><Ionicons name="trash-outline" size={19} color={C.muted} /></Pressable>
              </Row>
            </Pressable>
          ))}
          {editing && <CardForm card={editing === 'new' ? undefined : editing} preset={ref} courses={courses} decks={data.decks}
            onClose={() => setEditing(null)} onSaved={(r) => { setEditing(null); if (editing === 'new' && !sameDeck(r, ref)) setRef(r); list.reload(); }} />}
          {ai && <AiForm preset={ref} courses={courses} decks={data.decks} onClose={() => setAi(false)}
            onDone={(r) => { setAi(false); if (r) setRef(r); list.reload(); }} />}
          {renaming && <RenameForm deck={ref} courses={courses} onClose={() => setRenaming(false)}
            onDone={(r) => { setRenaming(false); setRef(r); list.reload(); }} />}
        </>
      )}
    </Screen>
  );
}

const RATINGS = [
  { key: 'again', label: 'Quên', hint: '10 phút', color: C.wrong },
  { key: 'hard', label: 'Khó', hint: 'sớm hơn', color: C.brandMid },
  { key: 'good', label: 'Nhớ', hint: 'theo lịch', color: C.brand },
  { key: 'easy', label: 'Dễ', hint: 'giãn ra', color: C.ok },
];

function Review({ cards, onExit }: { cards: MyCard[]; onExit: () => void }) {
  const [queue, setQueue] = useState(cards);
  const [flipped, setFlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const card = queue[0];
  const total = done + queue.length;
  const rate = async (rating: string) => {
    if (!card || busy) return;
    setBusy(true); setErr(null);
    try {
      await api(`/ai/learn/my-flashcards/${card.card_id}/review`, { json: { rating } });
      setQueue((q) => (rating === 'again' ? [...q.slice(1), card] : q.slice(1)));
      if (rating !== 'again') setDone((n) => n + 1);
      setFlipped(false);
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Screen>
      {queue.length > 0 && <Row><Progress value={done / Math.max(1, total)} style={{ flex: 1 }} /><Muted>{done}/{total}</Muted></Row>}
      {card ? (
        <>
          <Pressable onPress={() => setFlipped((f) => !f)} accessibilityRole="button" accessibilityLabel={flipped ? 'Mặt sau thẻ' : 'Mặt trước thẻ, chạm để lật'}
            style={{ minHeight: 280, backgroundColor: flipped ? C.card : C.brand, borderRadius: 24, padding: 24, justifyContent: 'center', gap: 12, borderWidth: 1, borderColor: flipped ? C.line : C.brand }}>
            {!flipped ? (
              <>
                {!!card.deck && <Text style={{ color: C.brandTint, fontWeight: '700', fontSize: 12 }}>{card.deck.toUpperCase()}</Text>}
                <Text style={{ color: C.white, fontSize: 21, fontWeight: '700', lineHeight: 29 }}>{card.front}</Text>
                <Text style={{ color: C.brandTint, fontSize: 13, marginTop: 8 }}>Chạm để lật thẻ</Text>
              </>
            ) : <Text style={{ fontSize: 18, lineHeight: 26 }}>{card.back}</Text>}
          </Pressable>
          {err && <ErrorBox message={err} />}
          {flipped ? (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {RATINGS.map((r) => (
                <Pressable key={r.key} disabled={busy} onPress={() => rate(r.key)}
                  style={({ pressed }) => ({ flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 16, backgroundColor: r.color, opacity: busy || pressed ? 0.7 : 1 })}>
                  <Text style={{ color: C.white, fontWeight: '800', fontSize: 15 }}>{r.label}</Text>
                  <Text style={{ color: C.white, fontSize: 11, opacity: 0.85 }}>{r.hint}</Text>
                </Pressable>
              ))}
            </View>
          ) : <Button title="Lật thẻ" icon="sync" onPress={() => setFlipped(true)} />}
        </>
      ) : (
        <>
          <Empty title={done ? `Xong! Bạn vừa ôn ${done} thẻ` : 'Không còn thẻ cần ôn'} icon="trophy-outline" />
          <Button title="Quay lại" variant="ghost" onPress={onExit} />
        </>
      )}
    </Screen>
  );
}
