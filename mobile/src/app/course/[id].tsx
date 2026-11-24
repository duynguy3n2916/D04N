import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { Card, ErrorBox, H1, Muted, Progress, Screen, Spinner } from '../../components/ui';
import { api, type CourseTree } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { C } from '../../lib/theme';

export default function Course() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const data = useAsync((signal) => api<CourseTree>(`/ai/learn/courses/${id}`, { signal }), [id]);
  const c = data.data;
  return (
    <Screen onRefresh={data.reload} refreshing={data.loading && !!c}>
      <Stack.Screen options={{ title: c?.code || 'Khoá học' }} />
      {data.loading && !c && <Spinner />}
      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
      {c && (
        <>
          <H1>{c.title}</H1>
          <Progress value={c.items_done / Math.max(1, c.items_total)} />
          <Muted>{c.items_done}/{c.items_total} mục đã xong</Muted>
          {c.chapters.map((ch) => (
            <Card key={ch.chapter_id} style={{ gap: 0, padding: 0, overflow: 'hidden' }}>
              <Text style={{ padding: 16, paddingBottom: 8, fontSize: 13, fontWeight: '800', color: C.brand, textTransform: 'uppercase' }}>{ch.title}</Text>
              {ch.lessons.map((l) => {
                const done = l.items_total > 0 && l.items_done >= l.items_total;
                return (
                  <Pressable key={l.lesson_id} onPress={() => router.push(`/lesson/${l.lesson_id}`)}
                    style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderTopWidth: 1, borderTopColor: C.line }, pressed && { backgroundColor: C.wash }]}>
                    <View style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: done ? C.brand : C.brandSoft }}>
                      <Ionicons name={done ? 'checkmark' : 'book-outline'} size={16} color={done ? C.white : C.brand} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 16, fontWeight: '600', color: C.ink }}>{l.title}</Text>
                      <Muted style={{ fontSize: 13 }}>{l.items_done}/{l.items_total} mục</Muted>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={C.muted} />
                  </Pressable>
                );
              })}
            </Card>
          ))}
        </>
      )}
    </Screen>
  );
}
