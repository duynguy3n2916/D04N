import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { Text } from '../../components/Text';
import { QuizItem } from '../../components/items/QuizItem';
import { ReadingItem } from '../../components/items/ReadingItem';
import { SlideItem } from '../../components/items/SlideItem';
import { VideoItem } from '../../components/items/VideoItem';
import type { ItemProps } from '../../components/items/types';
import { ErrorBox, Screen, Spinner } from '../../components/ui';
import { api, type ItemDetail, type LessonView } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { C } from '../../lib/theme';


export default function Item() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [xpToast, setXpToast] = useState<number | null>(null);
  const data = useAsync(async (signal) => {
    const item = await api<ItemDetail>(`/ai/learn/items/${id}`, { signal });
    const lesson = await api<LessonView>(`/ai/learn/lessons/${item.lesson_id}`, { signal }).catch(() => null);
    return { item, lesson };
  }, [id]);
  const item = data.data?.item;
  const items = data.data?.lesson?.items || [];
  const idx = items.findIndex((x) => x.item_id === id);
  const next = idx >= 0 ? items[idx + 1] : undefined;
  const goNext = next ? () => router.replace(`/item/${next.item_id}`) : null;
  const onCompleted = useCallback((xp?: number) => { if (xp) { setXpToast(xp); setTimeout(() => setXpToast(null), 2500); } }, []);

  if (!item) {
    return (
      <Screen>
        <Stack.Screen options={{ title: '' }} />
        {data.loading ? <Spinner /> : data.error ? <ErrorBox message={data.error} onRetry={data.reload} /> : null}
      </Screen>
    );
  }
  const props: ItemProps = { item, onCompleted, goNext };
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Stack.Screen options={{ title: idx >= 0 ? `${idx + 1}/${items.length} · ${item.title}` : item.title }} />
      {item.type === 'video' && <VideoItem {...props} />}
      {item.type === 'reading' && <ReadingItem {...props} />}
      {item.type === 'slide' && <SlideItem {...props} />}
      {item.type === 'quiz' && <QuizItem {...props} />}
      {xpToast != null && (
        <View pointerEvents="none" style={{ position: 'absolute', top: 12, alignSelf: 'center', backgroundColor: C.ink, paddingVertical: 8, paddingHorizontal: 16, borderRadius: 999 }}>
          <Text style={{ color: C.white, fontWeight: '800' }}>+{xpToast} XP</Text>
        </View>
      )}
    </View>
  );
}

