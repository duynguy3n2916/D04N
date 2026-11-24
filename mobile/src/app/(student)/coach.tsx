import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { Button, Card, ErrorBox, Kicker, Muted, Screen, Spinner } from '../../components/ui';
import { api, timeAgo } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { C } from '../../lib/theme';

interface ConvSummary { id: string; title: string; created_at: string; updated_at: string }

/** Trợ lý học tập: bắt đầu cuộc trò chuyện mới hoặc chat tiếp cuộc cũ. */
export default function CoachList() {
  const list = useAsync((signal) => api<ConvSummary[]>('/ai/coach/conversations', { signal }), []);
  const first = useRef(true);
  useFocusEffect(useCallback(() => { if (first.current) { first.current = false; return; } list.reload(); }, [list.reload]));
  const remove = (c: ConvSummary) => Alert.alert('Xoá cuộc trò chuyện?', c.title, [
    { text: 'Huỷ', style: 'cancel' },
    { text: 'Xoá', style: 'destructive', onPress: async () => { await api(`/ai/coach/conversations/${c.id}`, { method: 'DELETE' }).catch(() => {}); list.reload(); } },
  ]);
  return (
    <Screen onRefresh={list.reload} refreshing={list.loading && !!list.data}>
      <Card style={{ backgroundColor: C.brandSoft, borderColor: C.brandTint }}>
        <Ionicons name="sparkles" size={26} color={C.brand} />
        <Text style={{ fontSize: 18, fontWeight: '800', color: C.ink }}>Hỏi Trợ lý về việc học của bạn</Text>
        <Muted>Trợ lý xem tiến độ, tìm phần bạn hay sai, gợi ý bài ôn và đưa câu sai vào thẻ ghi nhớ.</Muted>
        <Button title="Cuộc trò chuyện mới" icon="add" onPress={() => router.push('/coach/new')} />
      </Card>
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {!!list.data?.length && <Kicker>Gần đây</Kicker>}
      {list.data?.map((c) => (
        <Pressable key={c.id} onPress={() => router.push(`/coach/${c.id}`)} onLongPress={() => remove(c)}
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 16, backgroundColor: pressed ? C.wash : C.card, borderWidth: 1, borderColor: C.line })}>
          <Ionicons name="chatbubble-ellipses-outline" size={20} color={C.brand} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: C.ink }} numberOfLines={1}>{c.title || 'Cuộc trò chuyện'}</Text>
            <Muted style={{ fontSize: 12 }}>{timeAgo(c.updated_at)}</Muted>
          </View>
        </Pressable>
      ))}
      {!!list.data?.length && <Muted style={{ fontSize: 12, textAlign: 'center' }}>Nhấn giữ một cuộc trò chuyện để xoá.</Muted>}
    </Screen>
  );
}
