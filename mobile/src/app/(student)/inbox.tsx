import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '../../components/Text';
import { Button, Empty, ErrorBox, Muted, Screen, Spinner, type IconName } from '../../components/ui';
import { api, timeAgo } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { refreshNotifications } from '../../lib/notifications';
import { C } from '../../lib/theme';

interface Noti { notification_id: string; kind: 'mention' | 'reply' | 'dm'; text: string; thread_id: string | null; read: boolean; created_at: string | null }
const ICON: Record<Noti['kind'], IconName> = { mention: 'at', reply: 'return-down-forward', dm: 'chatbubble-outline' };

/** Hộp thông báo: được @nhắc tên, có người trả lời bài/bình luận của mình. Dùng chung cho học sinh và giáo viên. */
export default function Inbox() {
  const list = useAsync((signal) => api<Noti[]>('/ai/notifications/inbox', { signal }), []);
  const first = useRef(true);
  useFocusEffect(useCallback(() => { if (first.current) { first.current = false; return; } list.reload(); }, [list.reload]));
  const unread = list.data?.filter((n) => !n.read).length || 0;
  const markAll = async () => { await api('/ai/notifications/inbox/read', { json: {} }).catch(() => {}); list.reload(); refreshNotifications(); };
  const open = async (n: Noti) => {
    if (!n.read) { await api('/ai/notifications/inbox/read', { json: { notification_id: n.notification_id } }).catch(() => {}); refreshNotifications(); }
    if (n.thread_id) router.push(`/forum/${n.thread_id}`); else list.reload();
  };
  return (
    <Screen onRefresh={() => { list.reload(); refreshNotifications(); }} refreshing={list.loading && !!list.data}>
      {unread > 0 && <Button small variant="ghost" icon="checkmark-done" title={`Đánh dấu đã đọc (${unread})`} onPress={markAll} style={{ alignSelf: 'flex-start' }} />}
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.data && !list.data.length && <Empty title="Chưa có thông báo" icon="notifications-outline">Khi bạn được @nhắc tên hoặc có người trả lời bài của bạn, thông báo sẽ hiện ở đây.</Empty>}
      {list.data?.map((n) => (
        <Pressable key={n.notification_id} onPress={() => open(n)}
          style={({ pressed }) => ({ flexDirection: 'row', gap: 12, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: n.read ? C.line : C.brandTint, backgroundColor: pressed ? C.wash : n.read ? C.card : C.brandSoft })}>
          <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.line }}>
            <Ionicons name={ICON[n.kind] || 'notifications-outline'} size={18} color={C.brand} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: C.ink, fontSize: 15, fontWeight: n.read ? '400' : '700' }}>{n.text}</Text>
            <Muted style={{ fontSize: 12 }}>{timeAgo(n.created_at)}</Muted>
          </View>
        </Pressable>
      ))}
    </Screen>
  );
}
