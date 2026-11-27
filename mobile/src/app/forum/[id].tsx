import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { Text, TextInput } from '../../components/Text';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { Avatar, Button, Card, ErrorBox, Muted, Row, Spinner, Tag } from '../../components/ui';
import { api, errorText, timeAgo } from '../../lib/api';
import { isTeacher, useAuth } from '../../lib/auth';
import { useAsync } from '../../lib/hooks';
import { C } from '../../lib/theme';

interface Reply {
  reply_id: string; parent_id: string | null; body: string; author_name: string; author_is_teacher: boolean;
  accepted: boolean; hidden?: boolean; like_count: number; created_at: string | null;
}
interface ThreadFull {
  thread_id: string; class_id: string; title: string; body: string; kind: string; author_name: string; locked: boolean;
  has_answer: boolean; created_at: string | null; lesson_code: string | null; replies: Reply[]; can_moderate: boolean;
}
interface Draft { draft: string | null; refused: boolean; message?: string }

/** Một bài trên diễn đàn: đọc, bình luận; giáo viên chọn lời giải đúng và nhờ AI soạn nháp trả lời. */
export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const teacher = isTeacher(user);
  const data = useAsync((signal) => api<ThreadFull>(`/ai/forum/threads/${id}`, { signal }), [id]);
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<Reply | null>(null);
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headerHeight = useHeaderHeight();
  const t = data.data;

  const send = async () => {
    if (!text.trim()) return;
    setBusy(true); setError(null);
    try {
      await api(`/ai/forum/threads/${id}/replies`, { json: { body: text.trim(), parent_id: replyTo?.reply_id || null, images: [] } });
      setText(''); setReplyTo(null); data.reload();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const accept = async (r: Reply) => {
    try { await api(`/ai/forum/replies/${r.reply_id}/accept`, { method: 'POST' }); data.reload(); } catch (e) { setError(errorText(e)); }
  };
  const aiDraft = async () => {
    setDrafting(true); setError(null);
    try {
      const d = await api<Draft>(`/ai/forum/threads/${id}/ai-draft`, { method: 'POST', timeoutMs: 120_000 });
      if (d.draft) setText(d.draft); else setError(d.message || 'AI không soạn được nháp cho bài này.');
    } catch (e) { setError(errorText(e)); } finally { setDrafting(false); }
  };

  const top = (t?.replies || []).filter((r) => !r.parent_id);
  const children = (pid: string) => (t?.replies || []).filter((r) => r.parent_id === pid);

  const renderReply = (r: Reply, nested = false) => (
    <View key={r.reply_id} style={{ gap: 6, marginLeft: nested ? 28 : 0, padding: 12, borderRadius: 16, backgroundColor: r.accepted ? C.okSoft : C.card, borderWidth: 1, borderColor: r.accepted ? C.ok : C.line }}>
      <Row>
        <Avatar name={r.author_name} size={28} />
        <Text style={{ fontWeight: '700', color: C.ink, flex: 1 }}>{r.author_name}{r.author_is_teacher ? ' · GV' : ''}</Text>
        <Muted style={{ fontSize: 12 }}>{timeAgo(r.created_at)}</Muted>
      </Row>
      {r.accepted && <Tag tone="ok" label="Lời giải được chọn" />}
      <Text style={{ color: r.hidden ? C.muted : C.ink, fontSize: 15, lineHeight: 21 }}>{r.hidden ? '(Bình luận đã bị ẩn)' : r.body}</Text>
      <Row>
        {!nested && !t?.locked && <Pressable onPress={() => setReplyTo(r)}><Text style={{ color: C.brand, fontWeight: '700', fontSize: 13 }}>Trả lời</Text></Pressable>}
        {teacher && t?.can_moderate && !r.accepted && !nested && t.kind !== 'announcement' && (
          <Pressable onPress={() => accept(r)}><Text style={{ color: C.okText, fontWeight: '700', fontSize: 13, marginLeft: 12 }}>Chọn làm lời giải</Text></Pressable>
        )}
      </Row>
    </View>
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={headerHeight}>
      <Stack.Screen options={{ title: t?.lesson_code || 'Thảo luận' }} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {data.loading && !t && <Spinner />}
        {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
        {t && (
          <>
            <Card>
              <Row><Avatar name={t.author_name} size={32} /><View style={{ flex: 1 }}><Text style={{ fontWeight: '700', color: C.ink }}>{t.author_name}</Text><Muted style={{ fontSize: 12 }}>{timeAgo(t.created_at)}</Muted></View></Row>
              <Text style={{ fontSize: 20, fontWeight: '800', color: C.ink }}>{t.title}</Text>
              <Text style={{ fontSize: 16, color: C.ink, lineHeight: 23 }}>{t.body}</Text>
              {t.locked && <Tag label="Đã khoá bình luận" />}
            </Card>
            <Muted>{t.replies.length} bình luận</Muted>
            {top.map((r) => <View key={r.reply_id} style={{ gap: 8 }}>{renderReply(r)}{children(r.reply_id).map((c) => renderReply(c, true))}</View>)}
          </>
        )}
      </ScrollView>
      {t && !t.locked && (
        <View style={{ padding: 12, gap: 8, borderTopWidth: 1, borderTopColor: C.line, backgroundColor: C.card }}>
          {error && <ErrorBox message={error} />}
          {replyTo && (
            <Row>
              <Muted style={{ flex: 1, fontSize: 13 }} numberOfLines={1}>Trả lời {replyTo.author_name}: {replyTo.body}</Muted>
              <Pressable onPress={() => setReplyTo(null)}><Ionicons name="close" size={18} color={C.muted} /></Pressable>
            </Row>
          )}
          {teacher && !replyTo && <Button small variant="soft" icon="sparkles-outline" title="AI soạn nháp trả lời" busy={drafting} onPress={aiDraft} style={{ alignSelf: 'flex-start' }} />}
          <Row style={{ alignItems: 'flex-end' }}>
            <TextInput value={text} onChangeText={setText} multiline placeholder="Viết bình luận…" placeholderTextColor={C.muted}
              style={{ flex: 1, maxHeight: 140, fontSize: 16, color: C.ink, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20, backgroundColor: C.wash }} />
            <Pressable onPress={send} disabled={busy || !text.trim()} accessibilityLabel="Gửi"
              style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.brand, alignItems: 'center', justifyContent: 'center', opacity: busy || !text.trim() ? 0.4 : 1 }}>
              <Ionicons name="send" size={18} color={C.white} />
            </Pressable>
          </Row>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}
