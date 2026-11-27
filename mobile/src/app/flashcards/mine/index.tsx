import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { AiForm, CardForm, NO_COURSE, deckName, type Deck, type DeckRef, type MyList } from '../../../components/MyCards';
import { Text } from '../../../components/Text';
import { Button, Card, ErrorBox, Muted, Progress, Row, Screen, Spinner, Tag } from '../../../components/ui';
import { api } from '../../../lib/api';
import { useAsync } from '../../../lib/hooks';
import { C, R } from '../../../lib/theme';

const openDeck = (d: DeckRef) => router.push({ pathname: '/flashcards/mine/deck', params: { course: d.course_id || '', deck: d.deck } });
const reviewAll = (course?: string | null) => router.push({ pathname: '/flashcards/mine/deck', params: { course: course ?? '', deck: '', all: course === undefined ? '1' : 'course', review: '1' } });

/** Thẻ của tôi: các khóa học, mỗi khóa có nhiều bộ thẻ. */
export default function MyFlashcards() {
  const list = useAsync((signal) => api<MyList>('/ai/learn/my-flashcards', { signal }), []);
  const first = useRef(true);
  useFocusEffect(useCallback(() => { if (first.current) { first.current = false; return; } list.reload(); }, [list.reload]));
  const [adding, setAdding] = useState(false);
  const [ai, setAi] = useState<{ course_id: string | null } | null>(null);
  const data = list.data;
  const courses = data?.courses || [];
  const titleOf = (id: string | null) => (id ? courses.find((c) => c.course_id === id)?.title || 'Khóa học' : NO_COURSE);
  const groups = useMemo(() => {
    if (!data) return [];
    const by = new Map<string | null, { course_id: string | null; decks: Deck[]; total: number; due: number }>();
    for (const d of data.decks) {
      const g = by.get(d.course_id) || { course_id: d.course_id, decks: [], total: 0, due: 0 };
      g.decks.push(d); g.total += d.total; g.due += d.due; by.set(d.course_id, g);
    }
    const order = data.courses.map((c) => c.course_id);
    return [...by.values()].sort((a, b) => (a.course_id === null ? 1 : b.course_id === null ? -1 : order.indexOf(a.course_id) - order.indexOf(b.course_id)));
  }, [data]);

  return (
    <Screen onRefresh={list.reload} refreshing={list.loading && !!data}>
      {list.loading && !data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {data && !data.total && (
        <Card style={{ alignItems: 'center', paddingVertical: 28 }}>
          <View style={{ width: 60, height: 60, borderRadius: 20, backgroundColor: C.brandSoft, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="layers" size={28} color={C.brand} />
          </View>
          <Text style={{ fontSize: 18, fontWeight: '700', textAlign: 'center' }}>Tạo bộ thẻ đầu tiên</Text>
          <Muted style={{ textAlign: 'center' }}>Mỗi khóa học có thể có nhiều bộ thẻ, ví dụ “Chương 1” hay “Ôn giữa kỳ”. Thẻ chỉ mình bạn thấy.</Muted>
        </Card>
      )}
      {data && data.total > 0 && (
        <Row style={{ flexWrap: 'wrap' }}>
          <Tag tone="brand" label={`${data.due} cần ôn`} />
          <Tag label={`${data.total} thẻ`} />
          <Tag tone="ok" label={`${data.learned} đã nhớ`} />
        </Row>
      )}
      {data && data.due > 0 && <Button icon="refresh" title={`Ôn tất cả ${data.due} thẻ`} onPress={() => reviewAll()} />}
      {data && (
        <Row>
          <Button style={{ flex: 1 }} variant={data.due > 0 ? 'soft' : 'primary'} icon="sparkles-outline" title="Tạo bằng AI" onPress={() => setAi({ course_id: courses[0]?.course_id || null })} />
          <Button style={{ flex: 1 }} variant="soft" icon="add" title="Tự viết" onPress={() => setAdding(true)} />
        </Row>
      )}
      {groups.map((g) => (
        <View key={g.course_id || 'none'} style={{ gap: 10, marginTop: 6 }}>
          <Row>
            <View style={{ width: 34, height: 34, borderRadius: 11, backgroundColor: C.brandSoft, alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name={g.course_id ? 'book' : 'pricetag'} size={17} color={C.brandStrong} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 17, fontWeight: '700' }} numberOfLines={2}>{titleOf(g.course_id)}</Text>
              <Muted style={{ fontSize: 13 }}>{g.decks.length} bộ · {g.total} thẻ{g.due ? ` · ${g.due} cần ôn` : ''}</Muted>
            </View>
            {g.due > 0 && <Button small variant="soft" title="Ôn" icon="refresh" onPress={() => reviewAll(g.course_id)} />}
          </Row>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {g.decks.map((d) => (
              <Pressable key={d.deck || '_'} onPress={() => openDeck(d)}
                style={({ pressed }) => ({ width: '48%', flexGrow: 1, minHeight: 128, padding: 14, gap: 6, borderRadius: R.md, backgroundColor: C.card,
                  borderWidth: 1, borderColor: d.due ? C.brandLine : C.cardLine, opacity: pressed ? 0.85 : 1,
                  shadowColor: '#17120F', shadowOpacity: 0.06, shadowRadius: 0, shadowOffset: { width: 4, height: 4 }, elevation: 2 })}>
                <Text style={{ fontSize: 16, fontWeight: '700' }} numberOfLines={2}>{deckName(d.deck)}</Text>
                <Muted style={{ fontSize: 13 }}>{d.total} thẻ · {d.learned} đã nhớ</Muted>
                <Progress value={d.learned / Math.max(1, d.total)} />
                <View style={{ marginTop: 'auto' }}>
                  {d.due > 0 ? <Tag tone="brand" label={`${d.due} cần ôn`} /> : <Tag tone="ok" label="Đã ôn xong" />}
                </View>
              </Pressable>
            ))}
            {g.course_id && (
              <Pressable onPress={() => setAi({ course_id: g.course_id })}
                style={{ width: '48%', flexGrow: 1, minHeight: 128, borderRadius: R.md, borderWidth: 1.5, borderStyle: 'dashed', borderColor: C.line, alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <Ionicons name="add" size={24} color={C.muted} />
                <Muted>Bộ thẻ mới</Muted>
              </Pressable>
            )}
          </View>
        </View>
      ))}
      {adding && data && <CardForm courses={courses} decks={data.decks} onClose={() => setAdding(false)} onSaved={(ref) => { setAdding(false); list.reload(); openDeck(ref); }} />}
      {ai && data && <AiForm preset={ai} courses={courses} decks={data.decks} onClose={() => setAi(null)}
        onDone={(ref) => { setAi(null); list.reload(); if (ref) openDeck(ref); }} />}
    </Screen>
  );
}
