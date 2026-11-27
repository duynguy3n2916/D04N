import Ionicons from '@expo/vector-icons/Ionicons';
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus, useAudioRecorder } from 'expo-audio';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View, type ScrollViewInstance } from 'react-native';
import { Text, TextInput } from '../../components/Text';
import { Avatar, ErrorBox, Muted } from '../../components/ui';
import { api, apiUpload, errorText, mediaUrl } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { refreshNotifications } from '../../lib/notifications';
import { C } from '../../lib/theme';

type Kind = 'text' | 'image' | 'video' | 'audio';
interface Message {
  message_id: string; sender_id: string; mine: boolean; body: string; hidden: boolean; created_at: string | null;
  kind?: Kind; url?: string | null; mime?: string | null; duration?: number | null;
}
interface Thread { conversation_id: string; other_id: string; other_name: string; blocked: boolean; blocked_by_me: boolean; other_read_at?: string | null; messages: Message[] }
interface Pending { id: string; kind: Kind; body: string; uri?: string; name?: string; type?: string; duration?: number; error?: string }

const BREAK = 15 * 60_000;
const RED = '#D63B44';
const MAX_VOICE_SEC = 300;
const pad = (n: number) => String(n).padStart(2, '0');
const fmtDur = (s: number | null | undefined) => {
  if (s == null || !isFinite(s)) return '0:00';
  const n = Math.max(0, Math.round(s));
  return `${Math.floor(n / 60)}:${pad(n % 60)}`;
};
/** Mốc giờ giữa các cụm tin, kiểu Messenger: "14:05", "Hôm qua 09:12", "Th 3 20:30", "12/11/2026 08:00". */
function fmtStamp(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return hm;
  if (diff === 1) return `Hôm qua ${hm}`;
  if (diff < 7) return `${['CN', 'Th 2', 'Th 3', 'Th 4', 'Th 5', 'Th 6', 'Th 7'][d.getDay()]} ${hm}`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${hm}`;
}
const gapMs = (a: string | null, b: string | null) => (a && b ? new Date(b).getTime() - new Date(a).getTime() : 0);

/** Một cuộc trò chuyện riêng kiểu app chat: bong bóng gom cụm, mốc giờ, "Đã xem", gửi ảnh / video / tin nhắn thoại. Tự tải tin mới mỗi 8 giây. */
export default function DirectChat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const data = useAsync((signal) => api<Thread>(`/ai/messages/conversations/${id}`, { signal }), [id]);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ kind: 'image' | 'video'; src: string } | null>(null);
  const [recStart, setRecStart] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const headerHeight = useHeaderHeight();
  const t = data.data;

  // tải lại êm (không hiện vòng quay) để thấy tin mới; server tự đánh dấu đã đọc
  useEffect(() => {
    const timer = setInterval(() => { api<Thread>(`/ai/messages/conversations/${id}`).then(data.setData).catch(() => {}); }, 8000);
    return () => clearInterval(timer);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (t) refreshNotifications(); }, [t?.messages.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // đồng hồ khi đang ghi âm, tự dừng và gửi khi quá 5 phút
  useEffect(() => {
    if (recStart == null) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - recStart >= MAX_VOICE_SEC * 1000) stopRec(true);
    }, 250);
    return () => clearInterval(timer);
  }, [recStart]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async () => { try { data.setData(await api<Thread>(`/ai/messages/conversations/${id}`)); } catch { /* lần tải sau sẽ thử lại */ } };

  const upload = async (p: Pending) => {
    setPending((ps) => ps.map((x) => (x.id === p.id ? { ...x, error: undefined } : x)));
    try {
      if (p.kind === 'text') {
        await api(`/ai/messages/conversations/${id}`, { json: { body: p.body } });
      } else {
        const f = new FormData();
        f.append('file', { uri: p.uri, name: p.name, type: p.type } as any);
        f.append('kind', p.kind);
        if (p.duration != null) f.append('duration', String(p.duration));
        await apiUpload(`/ai/messages/conversations/${id}/files`, f);
      }
      await refresh();
      setPending((ps) => ps.filter((x) => x.id !== p.id));
    } catch (e) {
      setPending((ps) => ps.map((x) => (x.id === p.id ? { ...x, error: errorText(e) } : x)));
    }
  };
  const queue = (items: Omit<Pending, 'id'>[]) => {
    const ps = items.map((it, i) => ({ ...it, id: `p${Date.now()}-${i}` }));
    setPending((old) => [...old, ...ps]);
    (async () => { for (const p of ps) await upload(p); })();
  };

  const send = () => {
    const body = text.trim();
    if (!body) return;
    setText('');
    queue([{ kind: 'text', body }]);
  };

  const pickMedia = async () => {
    setError(null);
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, selectionLimit: 10, quality: 0.8, videoMaxDuration: 180 });
    if (r.canceled) return;
    const items: Omit<Pending, 'id'>[] = [];
    for (const a of r.assets) {
      const video = a.type === 'video' || (a.mimeType || '').startsWith('video/');
      const limit = video ? 50 : 10;
      if (a.fileSize && a.fileSize > limit * 1024 * 1024) { setError(`${video ? 'Video' : 'Ảnh'} tối đa ${limit} MB.`); continue; }
      const mime = a.mimeType || (video ? 'video/mp4' : 'image/jpeg');
      let name = a.fileName || '';
      if (!/\.[a-z0-9]+$/i.test(name)) name = `${video ? 'video' : 'anh'}.${video ? (mime.includes('quicktime') ? 'mov' : 'mp4') : (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg')}`;
      // ảnh HEIC của iPhone: trình chọn ảnh đã chuyển sang JPEG khi có quality, đổi đuôi cho khớp
      if (!video && /\.hei[cf]$/i.test(name)) name = name.replace(/\.hei[cf]$/i, '.jpg');
      items.push({ kind: video ? 'video' : 'image', body: '', uri: a.uri, name, type: video ? mime : 'image/jpeg',
        duration: video && a.duration ? a.duration / 1000 : undefined });
    }
    if (items.length) queue(items);
  };

  const startRec = async () => {
    setError(null);
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) { setError('Chưa có quyền dùng micro. Hãy bật micro cho app trong Cài đặt.'); return; }
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecStart(Date.now()); setNow(Date.now());
    } catch (e) { setError(errorText(e)); }
  };
  const stopRec = async (keep: boolean) => {
    const started = recStart;
    setRecStart(null);
    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    } catch { /* đã dừng */ }
    const seconds = started ? (Date.now() - started) / 1000 : 0;
    if (!keep || seconds < 0.5 || !recorder.uri) return;
    queue([{ kind: 'audio', body: '', uri: recorder.uri, name: 'tin-nhan-thoai.m4a', type: 'audio/mp4', duration: Math.round(seconds * 10) / 10 }]);
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

  const msgs = t?.messages || [];
  const lastMine = [...msgs].reverse().find((m) => m.mine);
  const seen = !!(lastMine && t?.other_read_at && lastMine.created_at && new Date(t.other_read_at) >= new Date(lastMine.created_at));

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
      <ScrollView ref={scrollRef} contentContainerStyle={{ paddingHorizontal: 10, paddingVertical: 12, flexGrow: 1, justifyContent: 'flex-end' }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })} keyboardShouldPersistTaps="handled">
        {data.loading && !t && <ActivityIndicator color={C.brand} style={{ marginTop: 32 }} />}
        {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
        {t && (
          <View style={{ alignItems: 'center', gap: 4, paddingVertical: 18 }}>
            <Avatar name={t.other_name} size={64} />
            <Text style={{ fontSize: 17, fontWeight: '700' }}>{t.other_name}</Text>
            <Muted style={{ fontSize: 13 }}>{msgs.length ? 'Tin nhắn riêng giữa hai bạn trong lớp' : 'Hãy gửi lời chào đầu tiên 👋'}</Muted>
          </View>
        )}
        {msgs.map((m, i) => {
          const prev = msgs[i - 1];
          const next = msgs[i + 1];
          const stamp = !prev || gapMs(prev.created_at, m.created_at) > BREAK;
          const first = stamp || prev.mine !== m.mine;
          const last = !next || next.mine !== m.mine || gapMs(m.created_at, next.created_at) > BREAK;
          return (
            <Fragment key={m.message_id}>
              {stamp && <Muted style={{ alignSelf: 'center', fontSize: 12, marginTop: 14, marginBottom: 6 }}>{fmtStamp(m.created_at)}</Muted>}
              <Pressable onLongPress={() => !m.mine && !m.hidden && report(m)} delayLongPress={350}
                style={{ flexDirection: m.mine ? 'row-reverse' : 'row', alignItems: 'flex-end', gap: 6, maxWidth: '84%', alignSelf: m.mine ? 'flex-end' : 'flex-start', marginTop: first ? 8 : 2 }}>
                {!m.mine && <View style={{ width: 28 }}>{last && <Avatar name={t!.other_name} size={28} />}</View>}
                <View style={{ alignItems: m.mine ? 'flex-end' : 'flex-start', gap: 2, flexShrink: 1 }}>
                  <Body m={m} first={first} last={last} onView={setViewer} />
                </View>
              </Pressable>
              {m === lastMine && !pending.length && <Muted style={{ alignSelf: 'flex-end', fontSize: 12, marginTop: 3, marginRight: 4 }}>{seen ? 'Đã xem' : 'Đã gửi'}</Muted>}
            </Fragment>
          );
        })}
        {pending.map((p) => (
          <View key={p.id} style={{ alignSelf: 'flex-end', alignItems: 'flex-end', maxWidth: '84%', marginTop: 4, opacity: 0.75 }}>
            <Body m={{ message_id: p.id, sender_id: '', mine: true, body: p.body, hidden: false, kind: p.kind, url: p.uri, duration: p.duration, created_at: null }} local first last onView={setViewer} />
            {p.error ? (
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 3 }}>
                <Text style={{ color: RED, fontSize: 12, flexShrink: 1 }}>Chưa gửi được: {p.error}</Text>
                <Pressable onPress={() => upload(p)} hitSlop={8}><Text style={{ color: C.brand, fontSize: 12, fontWeight: '700' }}>Thử lại</Text></Pressable>
                <Pressable onPress={() => setPending((ps) => ps.filter((x) => x.id !== p.id))} hitSlop={8}><Text style={{ color: C.muted, fontSize: 12, fontWeight: '700' }}>Bỏ</Text></Pressable>
              </View>
            ) : <Muted style={{ fontSize: 12, marginTop: 3 }}>Đang gửi…</Muted>}
          </View>
        ))}
      </ScrollView>
      {!!error && <View style={{ paddingHorizontal: 12 }}><ErrorBox message={error} /></View>}
      {t?.blocked ? (
        <Muted style={{ padding: 16, textAlign: 'center' }}>{t.blocked_by_me ? 'Bạn đã chặn người này.' : 'Bạn không thể nhắn cho người này.'}</Muted>
      ) : recStart != null ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, margin: 12, marginTop: 4 }}>
          <Pressable onPress={() => stopRec(false)} accessibilityLabel="Hủy ghi âm" hitSlop={8} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="trash-outline" size={24} color={RED} />
          </Pressable>
          <View style={{ flex: 1, height: 44, borderRadius: 22, backgroundColor: '#FDE3E2', flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: RED }} />
            <Text style={{ color: RED, fontWeight: '700' }}>Đang ghi âm… {fmtDur((now - recStart) / 1000)}</Text>
          </View>
          <Pressable onPress={() => stopRec(true)} accessibilityLabel="Gửi tin nhắn thoại"
            style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.brand, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="send" size={19} color={C.white} />
          </Pressable>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2, margin: 10, marginTop: 4 }}>
          <Pressable onPress={pickMedia} accessibilityLabel="Gửi ảnh hoặc video" disabled={!t} style={{ width: 42, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="image" size={25} color={C.brand} />
          </Pressable>
          {!text.trim() && (
            <Pressable onPress={startRec} accessibilityLabel="Ghi âm tin nhắn thoại" disabled={!t} style={{ width: 42, height: 44, alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="mic" size={25} color={C.brand} />
            </Pressable>
          )}
          <TextInput value={text} onChangeText={setText} placeholder="Aa" placeholderTextColor={C.muted} multiline maxLength={2000}
            style={{ flex: 1, maxHeight: 120, minHeight: 44, fontSize: 16, color: C.ink, paddingHorizontal: 16, paddingTop: 11, paddingBottom: 11, borderRadius: 22, backgroundColor: C.wash, marginHorizontal: 4 }} />
          <Pressable onPress={send} disabled={!text.trim()} accessibilityLabel="Gửi"
            style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.brand, alignItems: 'center', justifyContent: 'center', opacity: text.trim() ? 1 : 0.35 }}>
            <Ionicons name="send" size={19} color={C.white} />
          </Pressable>
        </View>
      )}
      <Viewer item={viewer} onClose={() => setViewer(null)} />
    </KeyboardAvoidingView>
  );
}

/** Nội dung một tin: chữ, ảnh, video (bấm để xem lớn) hoặc tin nhắn thoại. */
function Body({ m, local, first, last, onView }: { m: Message; local?: boolean; first: boolean; last: boolean; onView: (v: { kind: 'image' | 'video'; src: string }) => void }) {
  const kind = m.kind || 'text';
  const src = m.url ? (local ? m.url : mediaUrl(m.url)) : '';
  const big = 20, small = 6;
  const radius = m.mine
    ? { borderTopLeftRadius: big, borderBottomLeftRadius: big, borderTopRightRadius: first ? big : small, borderBottomRightRadius: last ? big : small }
    : { borderTopRightRadius: big, borderBottomRightRadius: big, borderTopLeftRadius: first ? big : small, borderBottomLeftRadius: last ? big : small };
  const bubble = (body: string) => (
    <View style={{ backgroundColor: m.mine ? C.brand : C.card, borderWidth: m.mine ? 0 : 1, borderColor: C.cardLine, paddingVertical: 9, paddingHorizontal: 14, ...radius }}>
      <Text style={{ fontSize: 16, lineHeight: 22, color: m.mine ? C.white : C.ink, fontStyle: m.hidden ? 'italic' : 'normal', opacity: m.hidden ? 0.7 : 1 }}>{body}</Text>
    </View>
  );
  if (kind === 'text' || !src) return bubble(m.body);
  return (
    <>
      {kind === 'image' && <ChatImage src={src} onPress={() => onView({ kind: 'image', src })} />}
      {kind === 'video' && (
        <Pressable onPress={() => onView({ kind: 'video', src })} accessibilityLabel="Xem video"
          style={{ width: 220, height: 150, borderRadius: 18, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="play" size={26} color={C.white} style={{ marginLeft: 3 }} />
          </View>
          <Text style={{ position: 'absolute', left: 12, bottom: 10, color: C.white, fontSize: 12, fontWeight: '700' }}>🎬 Video{m.duration ? ` · ${fmtDur(m.duration)}` : ''}</Text>
        </Pressable>
      )}
      {kind === 'audio' && <Voice src={src} duration={m.duration} mine={m.mine} />}
      {!!m.body && bubble(m.body)}
    </>
  );
}

function ChatImage({ src, onPress }: { src: string; onPress: () => void }) {
  const [ratio, setRatio] = useState(4 / 3);
  return (
    <Pressable onPress={onPress} accessibilityLabel="Xem ảnh">
      <Image source={{ uri: src }} resizeMode="cover"
        onLoad={(e) => { const s = e.nativeEvent.source; if (s?.width && s?.height) setRatio(Math.max(0.6, Math.min(1.8, s.width / s.height))); }}
        style={{ width: 230, aspectRatio: ratio, borderRadius: 18, backgroundColor: C.wash }} />
    </Pressable>
  );
}

const BARS = 26;
function Voice({ src, duration, mine }: { src: string; duration?: number | null; mine: boolean }) {
  const player = useAudioPlayer(src);
  const st = useAudioPlayerStatus(player);
  const len = st.duration && isFinite(st.duration) && st.duration > 0 ? st.duration : duration || 0;
  const ratio = len ? Math.min(1, st.currentTime / len) : 0;
  const bars = useMemo(() => {
    let h = 0;
    for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) >>> 0;
    return Array.from({ length: BARS }, () => { h = (h * 1103515245 + 12345) >>> 0; return 0.3 + ((h >>> 16) % 70) / 100; });
  }, [src]);
  useEffect(() => { if (st.didJustFinish) { player.pause(); player.seekTo(0); } }, [st.didJustFinish]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = async () => {
    if (st.playing) { player.pause(); return; }
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false }).catch(() => {});
    player.play();
  };
  const fg = mine ? C.white : C.brand;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingLeft: 8, paddingRight: 14, borderRadius: 22, width: 230,
      backgroundColor: mine ? C.brand : C.card, borderWidth: mine ? 0 : 1, borderColor: C.cardLine }}>
      <Pressable onPress={toggle} accessibilityLabel={st.playing ? 'Tạm dừng' : 'Nghe tin nhắn thoại'}
        style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: mine ? C.white : C.brand, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name={st.playing ? 'pause' : 'play'} size={16} color={mine ? C.brand : C.white} style={{ marginLeft: st.playing ? 0 : 2 }} />
      </Pressable>
      <View style={{ flex: 1, height: 26, flexDirection: 'row', alignItems: 'center', gap: 2 }}>
        {bars.map((b, i) => <View key={i} style={{ flex: 1, height: `${Math.round(b * 100)}%`, borderRadius: 2, backgroundColor: fg, opacity: i / BARS < ratio ? 1 : 0.3 }} />)}
      </View>
      <Text style={{ fontSize: 13, color: mine ? C.white : C.ink, minWidth: 34, textAlign: 'right' }}>{fmtDur(st.playing || st.currentTime > 0 ? st.currentTime : len)}</Text>
    </View>
  );
}

/** Xem ảnh / video toàn màn hình. */
function Viewer({ item, onClose }: { item: { kind: 'image' | 'video'; src: string } | null; onClose: () => void }) {
  return (
    <Modal visible={!!item} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.94)', justifyContent: 'center' }}>
        {item?.kind === 'image' && <Pressable style={{ flex: 1 }} onPress={onClose}><Image source={{ uri: item.src }} resizeMode="contain" style={{ flex: 1 }} /></Pressable>}
        {item?.kind === 'video' && <FullVideo src={item.src} />}
        <Pressable onPress={onClose} accessibilityLabel="Đóng" hitSlop={12}
          style={{ position: 'absolute', top: 54, right: 18, width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="close" size={24} color={C.white} />
        </Pressable>
      </View>
    </Modal>
  );
}

function FullVideo({ src }: { src: string }) {
  const player = useVideoPlayer(src, (p) => { p.play(); });
  return <VideoView player={player} style={{ width: '100%', aspectRatio: 9 / 16, maxHeight: '85%' }} contentFit="contain" nativeControls fullscreenOptions={{ enable: true }} />;
}
