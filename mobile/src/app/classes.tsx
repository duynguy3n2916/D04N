import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { Text, TextInput } from '../components/Text';
import { Avatar, Button, Card, Empty, ErrorBox, H2, Muted, Pill, Row, Screen, Spinner, st, Tag } from '../components/ui';
import { api, errorText, type ClassInfo, type User } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync } from '../lib/hooks';
import { C } from '../lib/theme';

interface Member { user_id: string; name: string; role: string }

/** Học sinh: tham gia lớp bằng mã, xem lớp đang học, thành viên và nhắn tin nhanh. */
export default function MyClasses() {
  const me = useAsync((signal) => api<User & { classes: ClassInfo[] }>('/ai/auth/me', { signal }), []);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = async () => {
    if (code.trim().length < 4) return;
    setBusy(true); setError(null);
    try {
      const r = await api<{ class: ClassInfo }>('/ai/auth/join-class', { json: { code: code.trim().toUpperCase() } });
      setCode(''); me.reload(); Alert.alert('Đã vào lớp', r.class?.name || '');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const leave = (c: ClassInfo) => Alert.alert(`Rời lớp ${c.name}?`, 'Bạn sẽ không thấy khóa học, diễn đàn và tin nhắn của lớp này nữa.', [
    { text: 'Huỷ', style: 'cancel' },
    { text: 'Rời lớp', style: 'destructive', onPress: async () => {
      try { await api(`/ai/auth/leave-class/${encodeURIComponent(c.class_id)}`, { method: 'POST' }); me.reload(); }
      catch (e) { Alert.alert('Không rời lớp được', errorText(e)); }
    } },
  ]);

  const classes = me.data?.classes || [];
  return (
    <Screen onRefresh={me.reload} refreshing={me.loading && !!me.data}>
      <Card style={{ borderColor: C.brandTint, gap: 10 }}>
        <Row>
          <View style={{ width: 42, height: 42, borderRadius: 14, backgroundColor: C.brand, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="school" size={22} color={C.white} />
          </View>
          <View style={{ flex: 1 }}>
            <H2>Tham gia lớp bằng mã</H2>
            <Muted style={{ fontSize: 13 }}>Mã lớp do giáo viên đưa cho bạn.</Muted>
          </View>
        </Row>
        <TextInput style={[st.input, { fontSize: 20, fontWeight: '700', letterSpacing: 2, textAlign: 'center' }]} value={code}
          onChangeText={(v) => { setCode(v.toUpperCase()); setError(null); }} autoCapitalize="characters" autoCorrect={false} maxLength={16}
          placeholder="VD: K7P2QM" placeholderTextColor={C.muted} />
        <Button title="Tham gia" onPress={join} busy={busy} disabled={code.trim().length < 4} />
        {error && <ErrorBox message={error} />}
      </Card>
      {me.loading && !me.data && <Spinner />}
      {me.error && <ErrorBox message={me.error} onRetry={me.reload} />}
      {me.data && !classes.length && <Empty title="Chưa có lớp" icon="people-outline">Bạn chưa vào lớp nào. Nhập mã lớp giáo viên đưa để tham gia.</Empty>}
      {classes.map((c) => <ClassCard key={c.class_id} c={c} onLeave={() => leave(c)} />)}
    </Screen>
  );
}

function ClassCard({ c, onLeave }: { c: ClassInfo; onLeave: () => void }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const members = useAsync((signal) => api<Member[]>(`/ai/forum/classes/${encodeURIComponent(c.class_id)}/members`, { signal }), [c.class_id]);
  const [tag, setTag] = useState<'all' | 'teacher' | 'student'>('all');
  const all = members.data || [];
  const isT = (m: Member) => m.role === 'teacher' || m.role === 'admin';
  const teachers = all.filter(isT);
  const me = user?.user_id;
  // bản thân đứng đầu, rồi giáo viên, rồi học sinh theo tên
  const shown = [...all].sort((a, b) => (a.user_id === me ? -1 : b.user_id === me ? 1 : isT(a) !== isT(b) ? (isT(a) ? -1 : 1) : a.name.localeCompare(b.name)))
    .filter((m) => tag === 'all' || (tag === 'teacher') === isT(m));
  const dm = async (userId: string) => {
    try {
      const r = await api<{ conversation_id: string }>('/ai/messages/conversations', { json: { user_id: userId } });
      router.push(`/dm/${r.conversation_id}`);
    } catch (e) { Alert.alert('Không mở được tin nhắn', errorText(e)); }
  };
  return (
    <Card style={{ gap: 8 }}>
      <Muted style={{ fontSize: 12, fontWeight: '700' }}>{c.class_id}</Muted>
      <H2>{c.name}</H2>
      <Muted style={{ fontSize: 13 }}>
        {teachers.length ? `Giáo viên: ${teachers.map((t) => t.name).join(', ')}` : members.loading ? 'Đang tải…' : 'Chưa có giáo viên'}
        {members.data ? ` · ${all.length} thành viên` : ''}
      </Muted>
      <Row style={{ flexWrap: 'wrap' }}>
        <Button small variant="soft" icon="book-outline" title="Khóa học" onPress={() => router.push('/')} />
        <Button small variant="soft" icon="chatbubbles-outline" title="Tin nhắn" onPress={() => router.push('/messages')} />
        <Button small variant="ghost" title="Rời lớp" onPress={onLeave} />
      </Row>
      <Pressable onPress={() => setOpen((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 }}>
        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={16} color={C.brand} />
        <Text style={{ color: C.brand, fontWeight: '700' }}>{open ? 'Ẩn thành viên' : `Xem thành viên${members.data ? ` (${all.length})` : ''}`}</Text>
      </Pressable>
      {open && members.error && <ErrorBox message={members.error} onRetry={members.reload} />}
      {open && members.data && (
        <Row style={{ flexWrap: 'wrap' }}>
          <Pill label="Tất cả" count={all.length} active={tag === 'all'} onPress={() => setTag('all')} />
          <Pill label="Giáo viên" count={teachers.length} active={tag === 'teacher'} onPress={() => setTag('teacher')} />
          <Pill label="Học sinh" count={all.length - teachers.length} active={tag === 'student'} onPress={() => setTag('student')} />
        </Row>
      )}
      {open && shown.map((m) => (
        <Row key={m.user_id} style={{ paddingVertical: 4 }}>
          <Avatar name={m.name} size={32} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: C.ink, fontWeight: '700' }}>{m.name}</Text>
            <Muted style={{ fontSize: 12 }}>{isT(m) ? 'Giáo viên' : 'Học sinh'}</Muted>
          </View>
          {m.user_id === me ? <Tag tone="brand" label="Bạn" />
            : <Button small variant="ghost" icon="chatbubble-outline" title="Nhắn tin" onPress={() => dm(m.user_id)} />}
        </Row>
      ))}
    </Card>
  );
}
