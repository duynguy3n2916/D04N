import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Pressable, View } from 'react-native';
import { Text } from '../../components/Text';
import { Button, Cover, ErrorBox, Kicker, ListCard, Progress, Row, Screen, Spinner } from '../../components/ui';
import { api, type CourseTree } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { C } from '../../lib/theme';

export default function Course() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const data = useAsync((signal) => api<CourseTree>(`/ai/learn/courses/${id}`, { signal }), [id]);
  const c = data.data;
  let n = 0;
  return (
    <Screen onRefresh={data.reload} refreshing={data.loading && !!c}>
      <Stack.Screen options={{ title: c?.code || 'Khoá học' }} />
      {data.loading && !c && <Spinner />}
      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
      {c && (
        <>
          <Cover title={c.title} height={170} />
          <Row>
            <Progress value={c.items_done / Math.max(1, c.items_total)} style={{ flex: 1 }} />
            <Text style={{ fontSize: 13, color: C.muted }}>{c.items_done}/{c.items_total} mục · {Math.round((c.items_done / Math.max(1, c.items_total)) * 100)}%</Text>
          </Row>
          {c.current_item_id && c.items_done < c.items_total && (
            <Button title={c.items_done ? 'Học tiếp' : 'Bắt đầu học'} icon="play" onPress={() => router.push(`/item/${c.current_item_id}`)} />
          )}
          {c.chapters.map((ch) => (
            <View key={ch.chapter_id} style={{ gap: 8, marginTop: 6 }}>
              <Kicker>{ch.title}</Kicker>
              <ListCard>
                {ch.lessons.map((l, i) => {
                  n += 1;
                  const done = l.items_total > 0 && l.items_done >= l.items_total;
                  const started = l.items_done > 0 && !done;
                  return (
                    <Pressable key={l.lesson_id} onPress={() => router.push(`/lesson/${l.lesson_id}`)}
                      style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 18, borderTopWidth: i ? 1 : 0, borderTopColor: C.cardLine },
                        pressed && { backgroundColor: C.wash }]}>
                      <View style={{ width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
                        backgroundColor: done ? C.brand : started ? C.ink : C.brandSoft }}>
                        {done ? <Ionicons name="checkmark" size={18} color={C.white} /> : <Text style={{ fontWeight: '800', color: started ? C.white : C.brandStrong }}>{n}</Text>}
                      </View>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={{ fontSize: 16, fontWeight: '700' }}>{l.title}</Text>
                        <Text style={{ fontSize: 13, color: C.muted }}>{l.items_done}/{l.items_total} mục{started ? ' · đang học' : ''}</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={18} color={C.muted} />
                    </Pressable>
                  );
                })}
              </ListCard>
            </View>
          ))}
        </>
      )}
    </Screen>
  );
}
