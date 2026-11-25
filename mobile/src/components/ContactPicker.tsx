import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { api, errorText } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { C, R } from '../lib/theme';
import { Text, TextInput } from './Text';
import { Avatar, Empty, ErrorBox, Muted, Pill, Spinner, Tag } from './ui';

export interface Contact { user_id: string; name: string; role: string; class_ids: string[]; conversation_id: string | null; blocked: boolean }
interface Contacts { classes: { class_id: string; name: string; count: number }[]; people: Contact[] }
type RoleTag = 'all' | 'teacher' | 'student';
const isTeacher = (c: Contact) => c.role === 'teacher' || c.role === 'admin';

/** Mở hội thoại với một người (tạo mới nếu chưa có) rồi chuyển sang màn chat. */
export async function openChat(p: { user_id: string; conversation_id?: string | null }, replace = false) {
  const id = p.conversation_id || (await api<{ conversation_id: string }>('/ai/messages/conversations', { json: { user_id: p.user_id } })).conversation_id;
  if (replace) router.replace(`/dm/${id}`); else router.push(`/dm/${id}`);
}

/** Chọn người để nhắn: bấm thẻ lớp, thẻ vai trò, rồi gõ hoặc bấm vào tên. */
export function ContactPicker({ replace, header }: { replace?: boolean; header?: React.ReactNode }) {
  const data = useAsync((s) => api<Contacts>('/ai/messages/contacts', { signal: s }), []);
  const [cls, setCls] = useState('');
  const [role, setRole] = useState<RoleTag>('all');
  const [q, setQ] = useState('');
  const [opening, setOpening] = useState('');
  const [error, setError] = useState<string | null>(null);
  const classes = data.data?.classes || [];
  const inClass = (data.data?.people || []).filter((p) => !cls || p.class_ids.includes(cls));
  const term = q.trim().toLowerCase();
  const shown = inClass.filter((p) => (role === 'all' || (role === 'teacher') === isTeacher(p)) && `${p.name} ${p.user_id}`.toLowerCase().includes(term));
  const nTeacher = inClass.filter(isTeacher).length;

  const open = async (p: Contact) => {
    setOpening(p.user_id); setError(null);
    try { await openChat(p, replace); } catch (e) { setError(errorText(e)); } finally { setOpening(''); }
  };

  if (data.loading && !data.data) return <Spinner />;
  if (data.error) return <ErrorBox message={data.error} onRetry={data.reload} />;
  if (!classes.length) return <Empty title="Bạn chưa vào lớp nào" icon="people-outline">Vào lớp bằng mã lớp ở tab Tôi để nhắn tin với bạn cùng lớp và giáo viên.</Empty>;
  return (
    <View style={{ gap: 12 }}>
      {header}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {classes.length > 1 && <Pill label="Tất cả lớp" active={!cls} onPress={() => setCls('')} />}
        {classes.map((c) => (
          <Pill key={c.class_id} label={c.class_id} count={c.count} active={cls === c.class_id || classes.length === 1}
            onPress={() => setCls(classes.length > 1 && cls === c.class_id ? '' : c.class_id)} />
        ))}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        <Pill label="Mọi người" count={inClass.length} active={role === 'all'} onPress={() => setRole('all')} />
        <Pill label="Giáo viên" count={nTeacher} active={role === 'teacher'} onPress={() => setRole('teacher')} />
        <Pill label="Học sinh" count={inClass.length - nTeacher} active={role === 'student'} onPress={() => setRole('student')} />
      </ScrollView>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.card, borderWidth: 1.5, borderColor: C.line, borderRadius: R.pill, paddingHorizontal: 14 }}>
        <Ionicons name="search" size={18} color={C.muted} />
        <TextInput value={q} onChangeText={setQ} placeholder="Gõ tên hoặc mã để tìm…" placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false}
          style={{ flex: 1, paddingVertical: 12, fontSize: 16, color: C.ink }} />
        {!!q && <Ionicons name="close-circle" size={18} color={C.muted} onPress={() => setQ('')} />}
      </View>
      {!!error && <ErrorBox message={error} />}
      <View style={{ backgroundColor: C.card, borderRadius: R.lg, borderWidth: 1, borderColor: C.cardLine, overflow: 'hidden' }}>
        {!shown.length ? <Muted style={{ padding: 16 }}>Không có ai khớp.</Muted> : shown.map((p, i) => (
          <Pressable key={p.user_id} onPress={() => open(p)} disabled={!!opening || p.blocked}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14,
              borderTopWidth: i ? 1 : 0, borderTopColor: C.cardLine, backgroundColor: pressed ? C.wash : C.card, opacity: p.blocked ? 0.5 : 1 })}>
            <Avatar name={p.name} size={42} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ fontSize: 16, fontWeight: '700' }} numberOfLines={1}>{p.name}</Text>
              <Muted style={{ fontSize: 13 }} numberOfLines={1}>@{p.user_id}{classes.length > 1 ? ` · ${p.class_ids.join(', ')}` : ''}</Muted>
            </View>
            {isTeacher(p) && <Tag label="Giáo viên" tone="brand" />}
            {opening === p.user_id ? <ActivityIndicator color={C.brand} /> : <Ionicons name={p.blocked ? 'ban' : p.conversation_id ? 'chatbubble' : 'chatbubble-outline'} size={20} color={C.brand} />}
          </Pressable>
        ))}
      </View>
    </View>
  );
}
