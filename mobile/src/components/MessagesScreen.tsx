import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';
import { Pressable, View } from 'react-native';
import { api, timeAgo } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { refreshNotifications } from '../lib/notifications';
import { C, R } from '../lib/theme';
import { ContactPicker } from './ContactPicker';
import { Text } from './Text';
import { Avatar, Button, ErrorBox, Muted, Screen, Spinner } from './ui';

export interface Conversation { conversation_id: string; other_id: string; other_name: string; last_message: string; last_at: string | null; unread: number; blocked: boolean }

/** Tab Tin nhắn: danh sách cuộc trò chuyện. Chưa có cuộc nào thì hiện thẳng khung chọn người trong lớp. Dùng chung cho học sinh và giáo viên. */
export function MessagesScreen() {
  const list = useAsync((signal) => api<Conversation[]>('/ai/messages/conversations', { signal }), []);
  const first = useRef(true);
  useFocusEffect(useCallback(() => { if (first.current) { first.current = false; return; } list.reload(); refreshNotifications(); }, [list.reload]));
  const reload = () => { list.reload(); refreshNotifications(); };

  if (list.loading && !list.data) return <Spinner />;
  if (list.data && !list.data.length) {
    return (
      <Screen onRefresh={reload} refreshing={list.loading}>
        <ContactPicker header={<View style={{ gap: 2 }}>
          <Text style={{ fontSize: 22, fontWeight: '800', letterSpacing: -0.5 }}>Bắt đầu trò chuyện</Text>
          <Muted>Chọn lớp, giáo viên hay học sinh, rồi bấm vào tên.</Muted>
        </View>} />
      </Screen>
    );
  }
  return (
    <Screen onRefresh={reload} refreshing={list.loading && !!list.data}>
      <Button icon="create-outline" title="Tin nhắn mới" onPress={() => router.push('/dm/new')} small style={{ alignSelf: 'flex-start' }} />
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      <View style={{ backgroundColor: C.card, borderRadius: R.lg, borderWidth: 1, borderColor: C.cardLine, overflow: 'hidden' }}>
        {list.data?.map((c, i) => (
          <Pressable key={c.conversation_id} onPress={() => router.push(`/dm/${c.conversation_id}`)}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderTopWidth: i ? 1 : 0, borderTopColor: C.cardLine, backgroundColor: pressed ? C.wash : C.card })}>
            <Avatar name={c.other_name} size={46} />
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={{ fontSize: 16, fontWeight: '700', flexShrink: 1 }} numberOfLines={1}>{c.other_name}</Text>
                {c.blocked && <Ionicons name="ban" size={14} color={C.muted} />}
                <Muted style={{ fontSize: 12, marginLeft: 'auto' }}>{timeAgo(c.last_at)}</Muted>
              </View>
              <Text numberOfLines={1} style={{ fontSize: 14, color: c.unread ? C.ink : C.muted, fontWeight: c.unread ? '700' : '400' }}>{c.last_message || 'Chưa có tin nhắn'}</Text>
            </View>
            {c.unread > 0 && (
              <View style={{ minWidth: 22, height: 22, borderRadius: 11, backgroundColor: C.brand, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 }}>
                <Text style={{ color: C.white, fontSize: 12, fontWeight: '800' }}>{c.unread}</Text>
              </View>
            )}
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}
