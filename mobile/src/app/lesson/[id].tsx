import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '../../components/Text';
import { Button, ErrorBox, ItemIcon, Kicker, ListCard, Muted, Progress, Row, Screen, Spinner } from '../../components/ui';
import { api, type ItemSummary, type LessonView } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { C } from '../../lib/theme';

const ITEM_LABEL: Record<ItemSummary['type'], string> = { video: 'Video', slide: 'Slide', reading: 'Bài đọc', quiz: 'Kiểm tra' };

/** Nội dung bài học: danh sách mục giống cột "Nội dung bài học" trên web. */
export default function Lesson() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const data = useAsync((signal) => api<LessonView>(`/ai/learn/lessons/${id}`, { signal }), [id]);
  // quay lại từ một mục thì tải lại để cập nhật dấu đã xong
  const first = useRef(true);
  useFocusEffect(useCallback(() => { if (first.current) { first.current = false; return; } data.reload(); }, [data.reload]));
  const l = data.data;
  const next = l?.items.find((it) => !it.completed && it.status !== 'locked');
  return (
    <Screen onRefresh={data.reload} refreshing={data.loading && !!l}>
      <Stack.Screen options={{ title: l?.code || 'Bài học' }} />
      {data.loading && !l && <Spinner />}
      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
      {l && (
        <>
          <View style={{ gap: 4 }}>
            <Kicker>{l.chapter_title}</Kicker>
            <Text style={{ fontSize: 28, fontWeight: '800', letterSpacing: -0.9, lineHeight: 32 }}>{l.title}</Text>
            {!!l.description && <Muted>{l.description}</Muted>}
          </View>
          <Row>
            <Progress value={l.items_done / Math.max(1, l.items_total)} style={{ flex: 1 }} />
            <Text style={{ fontSize: 13, color: C.muted }}>{l.items_done}/{l.items_total} mục</Text>
          </Row>
          <Row>
            {next && <Button title={l.items_done ? 'Học tiếp' : 'Bắt đầu'} icon="play" onPress={() => router.push(`/item/${next.item_id}`)} style={{ flex: 1 }} />}
            <Button variant="ghost" icon="refresh" title="Ôn thẻ" onPress={() => router.push(`/flashcards/${encodeURIComponent(l.code)}`)} style={next ? undefined : { flex: 1 }} />
          </Row>
          <Kicker style={{ color: C.muted, marginTop: 6 }}>Nội dung bài học</Kicker>
          <ListCard>
            {l.items.map((it) => {
              const locked = it.status === 'locked';
              const current = next?.item_id === it.item_id;
              return (
                <Pressable key={it.item_id} disabled={locked} onPress={() => router.push(`/item/${it.item_id}`)}
                  style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10, borderRadius: 18, opacity: locked ? 0.55 : 1 },
                    current && { backgroundColor: C.wash }, pressed && { backgroundColor: C.brandSoft }]}>
                  <ItemIcon type={it.type} locked={locked} />
                  <View style={{ flex: 1, gap: 1 }}>
                    <Text style={{ fontSize: 16, fontWeight: '700' }}>{it.title}</Text>
                    {it.score != null && <Text style={{ fontSize: 13, color: C.muted }}>Điểm {Math.round(it.score * 100)}%</Text>}
                  </View>
                  {it.completed ? (
                    <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: C.brand, alignItems: 'center', justifyContent: 'center' }}>
                      <Ionicons name="checkmark" size={15} color={C.white} />
                    </View>
                  ) : current ? <Ionicons name="arrow-forward-circle" size={24} color={C.ink} /> : null}
                </Pressable>
              );
            })}
          </ListCard>
        </>
      )}
    </Screen>
  );
}
