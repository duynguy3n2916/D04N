import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Button, Card, ErrorBox, H1, Kicker, Muted, Progress, Screen, Spinner, type IconName } from '../../components/ui';
import { api, type ItemSummary, type LessonView } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { C } from '../../lib/theme';

const ITEM_ICON: Record<ItemSummary['type'], IconName> = { video: 'play-circle-outline', slide: 'easel-outline', reading: 'document-text-outline', quiz: 'help-circle-outline' };
const ITEM_LABEL: Record<ItemSummary['type'], string> = { video: 'Video', slide: 'Slide', reading: 'Bài đọc', quiz: 'Kiểm tra' };

export default function Lesson() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const data = useAsync((signal) => api<LessonView>(`/ai/learn/lessons/${id}`, { signal }), [id]);
  // quay lại từ một mục thì tải lại để cập nhật dấu đã xong
  const first = useRef(true);
  useFocusEffect(useCallback(() => { if (first.current) { first.current = false; return; } data.reload(); }, [data.reload]));
  const l = data.data;
  return (
    <Screen onRefresh={data.reload} refreshing={data.loading && !!l}>
      <Stack.Screen options={{ title: l?.code || 'Bài học' }} />
      {data.loading && !l && <Spinner />}
      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
      {l && (
        <>
          <Kicker>{l.course_title} · {l.chapter_title}</Kicker>
          <H1>{l.title}</H1>
          {!!l.description && <Muted>{l.description}</Muted>}
          <Progress value={l.items_done / Math.max(1, l.items_total)} />
          <Card style={{ padding: 0, gap: 0, overflow: 'hidden' }}>
            {l.items.map((it, i) => {
              const locked = it.status === 'locked';
              const done = it.completed;
              return (
                <Pressable key={it.item_id} disabled={locked} onPress={() => router.push(`/item/${it.item_id}`)}
                  style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderTopWidth: i ? 1 : 0, borderTopColor: C.line, opacity: locked ? 0.5 : 1 }, pressed && { backgroundColor: C.wash }]}>
                  <Ionicons name={locked ? 'lock-closed-outline' : done ? 'checkmark-circle' : ITEM_ICON[it.type]} size={26} color={done ? C.ok : C.brand} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 16, fontWeight: '600', color: C.ink }}>{it.title}</Text>
                    <Muted style={{ fontSize: 13 }}>{ITEM_LABEL[it.type]}{it.meta_text ? ` · ${it.meta_text}` : ''}{it.score != null ? ` · ${Math.round(it.score * 100)}%` : ''}</Muted>
                  </View>
                  {!locked && <Ionicons name="chevron-forward" size={18} color={C.muted} />}
                </Pressable>
              );
            })}
          </Card>
          <Button variant="soft" icon="layers-outline" title="Ôn thẻ ghi nhớ của bài này" onPress={() => router.push(`/flashcards/${encodeURIComponent(l.code)}`)} />
        </>
      )}
    </Screen>
  );
}
