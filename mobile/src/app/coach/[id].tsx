import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, View, type ScrollViewInstance } from 'react-native';
import { Text, TextInput } from '../../components/Text';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { Markdown } from '../../components/Markdown';
import { Muted } from '../../components/ui';
import { api, apiStream, errorText, fmtTime, type Source } from '../../lib/api';
import { C } from '../../lib/theme';

interface CoachAction { type: 'item' | 'flashcards'; label: string; item_id?: string; lesson_id?: string; lesson_code?: string }
interface CoachResult { answer: string; sources: Source[]; actions: CoachAction[]; steps?: { tool: string }[] }
type CoachResponse = CoachResult & { conversation: { id: string; title: string } };
interface Msg { role: 'user' | 'assistant'; content: string; res?: CoachResult | null; error?: boolean }

const SUGGESTIONS = ['Mình đang yếu phần nào?', 'Mình nên ôn gì cho bài kiểm tra sắp tới?', 'Lập kế hoạch học 30 phút hôm nay giúp mình', 'Đưa các câu mình hay sai vào thẻ ôn'];
// Trạng thái thân thiện lúc trợ lý đang làm việc; không cho người dùng thấy tên công cụ nội bộ.
const BUSY_TEXT: Record<string, string> = {
  get_progress: 'Đang xem tiến độ của bạn', get_weak_points: 'Đang tìm phần bạn còn yếu', get_due_flashcards: 'Đang xem thẻ cần ôn',
  search_materials: 'Đang tìm trong học liệu', get_practice_quiz: 'Đang tìm bài luyện tập', queue_flashcards: 'Đang chuẩn bị thẻ ôn',
};
const busyText = (tool?: string) => (tool && BUSY_TEXT[tool]) || 'Đang soạn câu trả lời';
const MAX_SOURCES = 5;

type CompactAction = { kind: 'item'; label: string; item_id: string } | { kind: 'cards'; label: string; lesson_code: string | null };

/** Gộp nút hành động: tối đa một nút "Học tiếp" và một nút "Ôn thẻ" (cộng dồn số thẻ của mọi bài). */
function compactActions(actions: CoachAction[] | undefined): CompactAction[] {
  const out: CompactAction[] = [];
  const next = (actions || []).find((a) => a.type === 'item' && a.item_id);
  if (next) out.push({ kind: 'item', label: next.label, item_id: next.item_id! });
  const cards = (actions || []).filter((a) => a.type === 'flashcards');
  const codes = [...new Set(cards.map((a) => a.lesson_code).filter(Boolean))] as string[];
  if (cards.length) {
    const counts = cards.map((a) => Number(/Ôn\s+(\d+)\s+thẻ/i.exec(a.label)?.[1]));
    const total = counts.every((n) => Number.isFinite(n)) ? counts.reduce((s, n) => s + n, 0) : 0;
    out.push({ kind: 'cards', label: total ? `Ôn ${total} thẻ đến hạn` : 'Ôn thẻ đến hạn', lesson_code: codes.length === 1 ? codes[0] : null });
  }
  return out;
}

/** Bỏ nguồn trùng (cùng tài liệu/video và cùng mục), giữ tối đa MAX_SOURCES. */
function uniqueSources(sources: Source[] | undefined): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const s of sources || []) {
    const key = `${s.source_type || ''}|${s.document_title || s.source_id || ''}|${s.display}|${s.page ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

/** Danh sách nguồn thu gọn sẵn: bấm "Nguồn (N)" mới mở. */
function SourceFold({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 4 }}>
      <Pressable onPress={() => setOpen((v) => !v)} hitSlop={8} accessibilityRole="button" accessibilityState={{ expanded: open }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' }}>
        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={14} color={C.muted} />
        <Muted style={{ fontSize: 13, fontWeight: '600' }}>Nguồn ({sources.length})</Muted>
      </Pressable>
      {open && sources.map((s, k) => <Muted key={k} style={{ fontSize: 12, paddingLeft: 18 }}>{sourceText(s)}</Muted>)}
    </View>
  );
}
const THINKING = ['Đang xem tiến độ của bạn', 'Đang tìm các câu bạn hay sai', 'Đang lập kế hoạch ôn'];

function sourceText(s: Source) {
  if (s.source_type === 'video') return `${s.label} · ${s.display} · ${fmtTime(s.start_time)}`;
  if (s.page) return `${s.label} · ${s.document_title || 'Tài liệu'} · trang ${s.page}`;
  return `${s.label} · ${s.display}`;
}

export default function CoachChat() {
  const params = useLocalSearchParams<{ id: string; q?: string; course?: string }>();
  const [convId, setConvId] = useState<string | null>(params.id === 'new' ? null : params.id);
  const [title, setTitle] = useState('Trợ lý học tập');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(params.id !== 'new');
  const [thinking, setThinking] = useState(0);
  const [status, setStatus] = useState(''); // công cụ agent đang dùng
  const [draft, setDraft] = useState(''); // chữ của câu trả lời hiện dần khi stream
  const scrollRef = useRef<ScrollViewInstance>(null);
  const headerHeight = useHeaderHeight();

  // mở từ gợi ý ở màn Trợ lý: gửi luôn câu hỏi
  const sentQ = useRef(false);
  useEffect(() => { if (params.id === 'new' && params.q && !sentQ.current) { sentQ.current = true; send(params.q); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (params.id === 'new') return;
    api<{ title?: string; messages: Msg[] }>(`/ai/coach/conversations/${params.id}`)
      .then((d) => { setMsgs(d.messages.map((m) => ({ role: m.role, content: m.content, res: m.res }))); if (d.title) setTitle(d.title); })
      .catch((e) => setMsgs([{ role: 'assistant', content: errorText(e), error: true }]))
      .finally(() => setLoading(false));
  }, [params.id]);

  useEffect(() => {
    if (!busy) return;
    setThinking(0);
    const t = setInterval(() => setThinking((i) => (i + 1) % THINKING.length), 2200);
    return () => clearInterval(t);
  }, [busy]);

  const send = async (raw?: string) => {
    const message = (raw ?? text).trim();
    if (!message || busy) return;
    setMsgs((m) => [...m, { role: 'user', content: message }]);
    setText('');
    setBusy(true);
    setStatus('');
    setDraft('');
    try {
      const out: { res?: CoachResponse; failure?: string } = {};
      await apiStream('/ai/coach/chat/stream', { message, conversation_id: convId, course_id: params.course || null }, (event, data) => {
        if (event === 'step_start') setStatus(busyText(data.tool));
        else if (event === 'delta') setDraft((d) => d + data.text);
        else if (event === 'reset') setDraft('');
        else if (event === 'done') out.res = data;
        else if (event === 'error') out.failure = data.message || 'Lỗi khi tạo câu trả lời.';
      });
      if (out.failure || !out.res) throw new Error(out.failure || 'Mất kết nối khi đang trả lời. Hãy thử lại.');
      const res = out.res;
      setMsgs((m) => [...m, { role: 'assistant', content: res.answer, res }]);
      setConvId(res.conversation.id);
      if (res.conversation.title) setTitle(res.conversation.title);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: errorText(e), error: true }]);
    } finally { setBusy(false); setDraft(''); }
  };

  const openAction = (a: CompactAction) => {
    if (a.kind === 'item') router.push(`/item/${a.item_id}`);
    else if (a.lesson_code) router.push(`/flashcards/${encodeURIComponent(a.lesson_code)}`);
    else router.push('/review');
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={headerHeight}>
      <Stack.Screen options={{ title }} />
      <ScrollView ref={scrollRef} contentContainerStyle={{ padding: 16, gap: 14, flexGrow: 1 }} onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}>
        {loading && <ActivityIndicator color={C.brand} style={{ marginTop: 32 }} />}
        {!loading && !msgs.length && (
          <View style={{ gap: 10, marginTop: 24 }}>
            <Text style={{ fontSize: 26, fontWeight: '800', letterSpacing: -0.8 }}>Mình giúp gì cho việc học của bạn?</Text>
            {SUGGESTIONS.map((s) => (
              <Pressable key={s} onPress={() => send(s)} style={({ pressed }) => ({ padding: 14, borderRadius: 16, borderWidth: 1, borderColor: C.line, backgroundColor: pressed ? C.wash : C.card })}>
                <Text style={{ color: C.ink, fontSize: 15 }}>{s}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {msgs.map((m, i) => m.role === 'user' ? (
          <View key={i} style={{ alignSelf: 'flex-end', maxWidth: '85%', backgroundColor: C.brandSoft, borderRadius: 22, borderBottomRightRadius: 6, paddingVertical: 10, paddingHorizontal: 16 }}>
            <Text style={{ fontSize: 16, lineHeight: 22 }}>{m.content}</Text>
          </View>
        ) : (
          <View key={i} style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: C.brand, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="sparkles" size={13} color={C.white} />
              </View>
              <Text style={{ fontWeight: '700', fontSize: 14 }}>Trợ lý</Text>
            </View>
            {m.error ? <Text style={{ color: C.wrong }}>{m.content}</Text> : <Markdown text={m.content} />}
            {compactActions(m.res?.actions).length > 0 && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {compactActions(m.res?.actions).map((a) => (
                  <Pressable key={a.kind} onPress={() => openAction(a)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999, backgroundColor: C.brandSoft }}>
                    <Ionicons name={a.kind === 'cards' ? 'layers-outline' : 'arrow-forward-circle-outline'} size={16} color={C.brand} />
                    <Text style={{ color: C.brand, fontWeight: '700' }}>{a.label}</Text>
                  </Pressable>
                ))}
              </View>
            )}
            {uniqueSources(m.res?.sources).length > 0 && <SourceFold sources={uniqueSources(m.res?.sources)} />}
          </View>
        ))}
        {busy && (draft ? <Markdown text={draft} /> : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ActivityIndicator color={C.brand} size="small" />
            <Muted>{status || THINKING[thinking]}…</Muted>
          </View>
        ))}
      </ScrollView>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, margin: 12, marginTop: 4, padding: 6, paddingLeft: 4, borderRadius: 26, borderWidth: 1.5, borderColor: C.brandTint, backgroundColor: C.card }}>
        <TextInput value={text} onChangeText={setText} placeholder="Hỏi Trợ lý…" placeholderTextColor={C.muted} multiline
          style={{ flex: 1, maxHeight: 120, fontSize: 16, color: C.ink, paddingHorizontal: 14, paddingVertical: 10 }} />
        <Pressable onPress={() => send()} disabled={busy || !text.trim()} accessibilityLabel="Gửi"
          style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.brand, alignItems: 'center', justifyContent: 'center', opacity: busy || !text.trim() ? 0.4 : 1 }}>
          <Ionicons name="arrow-up" size={22} color={C.white} />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
