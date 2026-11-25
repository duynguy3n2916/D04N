import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, View, type ScrollViewInstance } from 'react-native';
import { Text, TextInput } from '../../components/Text';
import { Avatar, ErrorBox, Muted } from '../../components/ui';
import { api, errorText, timeAgo } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { refreshNotifications } from '../../lib/notifications';
import { C } from '../../lib/theme';

interface Message { message_id: string; sender_id: string; mine: boolean; body: string; hidden: boolean; created_at: string | null }
interface Thread { conversation_id: string; other_id: string; other_name: string; blocked: boolean; blocked_by_me: boolean; messages: Message[] }

/** Một cuộc trò chuyện riêng: bong bóng tin nhắn, ô nhập ở dưới, chặn và báo cáo tin nhắn. Tự tải tin mới mỗi 8 giây. */
export default function DirectChat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const data = useAsync((signal) => api<Thread>(`/ai/messages/conversations/${id}`, { signal }), [id]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const headerHeight = useHeaderHeight();
  const t = data.data;

  // tải lại êm (không hiện vòng quay) để thấy tin mới; server tự đánh dấu đã đọc
  useEffect(() => {
    const timer = setInterval(() => { api<Thread>(`/ai/messages/conversations/${id}`).then(data.setData).catch(() => {}); }, 8000);
    return () => clearInterval(timer);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (t) refreshNotifications(); }, [t?.messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true); setError(null);
    try {
      await api(`/ai/messages/conversations/${id}`, { json: { body } });
      setText('');
      data.setData(await api<Thread>(`/ai/messages/conversations/${id}`));
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  const block = (blocked: boolean) => {
    const run = async () => {
      try { await api('/ai/messages/blocks', { json: { user_id: t?.other_id, blocked } }); data.reload(); } catch (e) { setError(errorText(e)); }
    };
    if (!blocked) { run(); return; }
    Alert.alert(`Chặn ${t?.other_name}?`, 'Hai bạn sẽ không nhắn tin cho nhau được cho đến khi bỏ chặn.', [{ text: 'Huỷ', style: 'cancel' }, { text: 'Chặn', style: 'destructive', onPress: run }]);
  };

  const report = (m: Message) => {
    Alert.alert('Báo cáo tin nhắn?', 'Chỉ tin nhắn này được gửi cho giáo viên của lớp xem xét.', [
      { text: 'Huỷ', style: 'cancel' },
      { text: 'Báo cáo', style: 'destructive', onPress: async () => {
        try {
          const r = await api<{ duplicate: boolean }>(`/ai/messages/${m.message_id}/report`, { json: { reason: 'Báo cáo từ app điện thoại' } });
          Alert.alert(r.duplicate ? 'Bạn đã báo cáo tin nhắn này rồi' : 'Đã gửi báo cáo cho giáo viên');
        } catch (e) { setError(errorText(e)); }
      } },
    ]);
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={headerHeight}>
      <Stack.Screen options={{
        headerTitle: () => t ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Avatar name={t.other_name} size={32} />
            <View><Text style={{ fontSize: 16, fontWeight: '700' }} numberOfLines={1}>{t.other_name}</Text><Muted style={{ fontSize: 12, lineHeight: 15 }}>@{t.other_id}</Muted></View>
          </View>
        ) : <Text style={{ fontSize: 17, fontWeight: '700' }}>Tin nhắn</Text>,
        headerRight: () => t ? (
          <Pressable onPress={() => block(!t.blocked_by_me)} hitSlop={10} style={{ marginRight: 16 }} accessibilityLabel={t.blocked_by_me ? 'Bỏ chặn' : 'Chặn'}>
            <Text style={{ color: C.muted, fontWeight: '700', fontSize: 14 }}>{t.blocked_by_me ? 'Bỏ chặn' : 'Chặn'}</Text>
          </Pressable>
        ) : null,
      }} />
      <ScrollView ref={scrollRef} contentContainerStyle={{ padding: 16, gap: 6, flexGrow: 1, justifyContent: 'flex-end' }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })} keyboardShouldPersistTaps="handled">
        {data.loading && !t && <ActivityIndicator color={C.brand} style={{ marginTop: 32 }} />}
        {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
        {t && !t.messages.length && <Muted style={{ textAlign: 'center', marginBottom: 12 }}>Hãy gửi lời chào đầu tiên 👋</Muted>}
        {t?.messages.map((m, i) => {
          const prev = t.messages[i - 1];
          const grouped = prev && prev.mine === m.mine;
          return (
            <Pressable key={m.message_id} onLongPress={() => !m.mine && !m.hidden && report(m)} delayLongPress={350}
              style={{ alignSelf: m.mine ? 'flex-end' : 'flex-start', maxWidth: '82%', marginTop: grouped ? 0 : 8 }}>
              <View style={{ backgroundColor: m.mine ? C.brand : C.card, borderWidth: m.mine ? 0 : 1, borderColor: C.cardLine,
                borderRadius: 20, borderBottomRightRadius: m.mine ? 6 : 20, borderBottomLeftRadius: m.mine ? 20 : 6, paddingVertical: 9, paddingHorizontal: 14 }}>
                <Text style={{ fontSize: 16, lineHeight: 22, color: m.mine ? C.white : C.ink, fontStyle: m.hidden ? 'italic' : 'normal', opacity: m.hidden ? 0.7 : 1 }}>{m.body}</Text>
              </View>
              {(!t.messages[i + 1] || t.messages[i + 1].mine !== m.mine) && (
                <Muted style={{ fontSize: 11, marginTop: 3, alignSelf: m.mine ? 'flex-end' : 'flex-start' }}>{timeAgo(m.created_at)}{!m.mine && !m.hidden ? ' · giữ để báo cáo' : ''}</Muted>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
      {!!error && <View style={{ paddingHorizontal: 12 }}><ErrorBox message={error} /></View>}
      {t?.blocked ? (
        <Muted style={{ padding: 16, textAlign: 'center' }}>{t.blocked_by_me ? 'Bạn đã chặn người này.' : 'Bạn không thể nhắn cho người này.'}</Muted>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, margin: 12, marginTop: 4, padding: 6, paddingLeft: 4, borderRadius: 26, borderWidth: 1.5, borderColor: C.brandTint, backgroundColor: C.card }}>
          <TextInput value={text} onChangeText={setText} placeholder="Nhập tin nhắn…" placeholderTextColor={C.muted} multiline maxLength={2000}
            style={{ flex: 1, maxHeight: 120, fontSize: 16, color: C.ink, paddingHorizontal: 14, paddingVertical: 10 }} />
          <Pressable onPress={send} disabled={busy || !text.trim()} accessibilityLabel="Gửi"
            style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.brand, alignItems: 'center', justifyContent: 'center', opacity: busy || !text.trim() ? 0.4 : 1 }}>
            {busy ? <ActivityIndicator color={C.white} /> : <Ionicons name="send" size={19} color={C.white} />}
          </Pressable>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}
