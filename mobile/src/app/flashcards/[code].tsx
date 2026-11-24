import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Markdown } from '../../components/Markdown';
import { Button, Empty, ErrorBox, Muted, Progress, Row, Screen, Spinner, Tag } from '../../components/ui';
import { api, errorText } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { refreshNotifications } from '../../lib/notifications';
import { C } from '../../lib/theme';

interface FCard { card_id: string; front: string; back: string; explanation: string; new: boolean }
interface Summary { lesson_code: string; lesson_title?: string | null; total: number; new: number; due: number; learned: number }
interface Due { lesson_code: string; cards: FCard[]; remaining: number }

const RATINGS = [
  { key: 'again', label: 'Quên', hint: '10 phút', color: C.wrong },
  { key: 'hard', label: 'Khó', hint: 'sớm hơn', color: C.brandMid },
  { key: 'good', label: 'Nhớ', hint: 'theo lịch', color: C.brand },
  { key: 'easy', label: 'Dễ', hint: 'giãn ra', color: C.ok },
];

export default function Flashcards() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const data = useAsync(async (signal) => {
    const [summary, due] = await Promise.all([
      api<Summary>(`/ai/learn/flashcards/${encodeURIComponent(code)}/summary`, { signal }),
      api<Due>(`/ai/learn/flashcards/${encodeURIComponent(code)}/due`, { signal }),
    ]);
    return { summary, due };
  }, [code]);
  const [queue, setQueue] = useState<FCard[]>([]);
  const [flipped, setFlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (data.data) { setQueue(data.data.due.cards); setDone(0); } }, [data.data]);
  const card = queue[0];
  const total = done + queue.length;

  const rate = async (rating: string) => {
    if (!card || busy) return;
    setBusy(true); setError(null);
    try {
      await api(`/ai/learn/flashcards/${card.card_id}/review`, { json: { rating } });
      setQueue((q) => (rating === 'again' ? [...q.slice(1), card] : q.slice(1)));
      if (rating !== 'again') setDone((n) => n + 1);
      setFlipped(false);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  useEffect(() => () => { refreshNotifications(); }, []);

  const s = data.data?.summary;
  return (
    <Screen>
      {data.loading && !data.data && <Spinner />}
      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
      {s && !s.total && <Empty title="Bài này chưa có thẻ">Giáo viên cần duyệt câu hỏi cho bài để tạo thẻ.</Empty>}
      {s && !!s.total && (
        <>
          <Text style={{ fontSize: 20, fontWeight: '800', color: C.ink }}>{s.lesson_title || s.lesson_code}</Text>
          <Row style={{ flexWrap: 'wrap' }}>
            <Tag tone="brand" label={`${s.due + done} cần ôn`} />
            <Tag label={`${s.new} thẻ mới`} />
            <Tag tone="ok" label={`${s.learned} đã thuộc`} />
          </Row>
          {queue.length > 0 && <Row><Progress value={done / Math.max(1, total)} style={{ flex: 1 }} /><Muted>{done}/{total}</Muted></Row>}
          {card ? (
            <>
              <Pressable onPress={() => setFlipped((f) => !f)} accessibilityRole="button" accessibilityLabel={flipped ? 'Mặt sau thẻ' : 'Mặt trước thẻ, chạm để lật'}
                style={{ minHeight: 280, backgroundColor: flipped ? C.card : C.brand, borderRadius: 24, padding: 24, justifyContent: 'center', gap: 12, borderWidth: 1, borderColor: flipped ? C.line : C.brand }}>
                {card.new && !flipped && <Text style={{ color: C.brandTint, fontWeight: '800', fontSize: 12 }}>THẺ MỚI</Text>}
                {!flipped ? (
                  <>
                    <Text style={{ color: C.white, fontSize: 21, fontWeight: '700', lineHeight: 29 }}>{card.front}</Text>
                    <Text style={{ color: C.brandTint, fontSize: 13, marginTop: 8 }}>Chạm để lật thẻ</Text>
                  </>
                ) : (
                  <>
                    <Markdown text={card.back} size={18} />
                    {!!card.explanation && <Muted>{card.explanation}</Muted>}
                  </>
                )}
              </Pressable>
              {error && <ErrorBox message={error} />}
              {flipped ? (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {RATINGS.map((r) => (
                    <Pressable key={r.key} disabled={busy} onPress={() => rate(r.key)}
                      style={({ pressed }) => ({ flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 16, backgroundColor: r.color, opacity: busy || pressed ? 0.7 : 1 })}>
                      <Text style={{ color: C.white, fontWeight: '800', fontSize: 15 }}>{r.label}</Text>
                      <Text style={{ color: C.white, fontSize: 11, opacity: 0.85 }}>{r.hint}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : <Button title="Lật thẻ" icon="sync" onPress={() => setFlipped(true)} />}
            </>
          ) : (
            <Empty title="Xong phiên ôn hôm nay!" icon="trophy-outline">{done ? `Bạn vừa ôn ${done} thẻ.` : 'Không còn thẻ đến hạn.'} Quay lại vào ngày mai nhé.</Empty>
          )}
          {!card && <Button variant="ghost" title="Quay lại" onPress={() => router.back()} />}
        </>
      )}
    </Screen>
  );
}
