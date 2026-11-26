import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '../../components/Text';
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
  return <FlashcardSession key={code} code={code} />;
}

function FlashcardSession({ code }: { code: string }) {
  const path = `/ai/learn/flashcards/${encodeURIComponent(code)}`;
  const summary = useAsync((signal) => api<Summary>(`${path}/summary`, { signal }), [path]);
  const due = useAsync((signal) => api<Due>(`${path}/due`, { signal }), [path]);
  const [queue, setQueue] = useState<FCard[]>([]);
  const [flipped, setFlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (due.data) { setQueue(due.data.cards); setDone(0); } }, [due.data]);
  const card = queue[0];
  const total = done + queue.length;

  const rate = async (rating: string) => {
    if (!card || busy) return;
    setBusy(true); setError(null);
    try {
      await api(`/ai/learn/flashcards/${card.card_id}/review`, { json: { rating } });
      summary.reload();
      setQueue((q) => (rating === 'again' ? [...q.slice(1), card] : q.slice(1)));
      if (rating !== 'again') setDone((n) => n + 1);
      setFlipped(false);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  useEffect(() => () => { refreshNotifications(); }, []);

  const s = summary.data;
  const loading = (summary.loading && !s) || (due.loading && !due.data);
  const loadError = summary.error || due.error;
  return (
    <Screen>
      {loading && <Spinner />}
      {loadError && <ErrorBox message={loadError} onRetry={() => { summary.reload(); due.reload(); }} />}
      {s && !s.total && <Empty title="Bài này chưa có thẻ">Giáo viên cần duyệt câu hỏi cho bài để tạo thẻ.</Empty>}
      {!loading && !loadError && s && !!s.total && (
        <>
          <Text style={{ fontSize: 20, fontWeight: '800', color: C.ink }}>{s.lesson_title || s.lesson_code}</Text>
          <Row style={{ flexWrap: 'wrap' }}>
            <Tag tone="brand" label={`${s.due} cần ôn`} />
            <Tag label={`${s.new} thẻ mới`} />
            <Tag tone="ok" label={`${s.learned} đã nhớ`} />
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
            <Empty title={done ? `Bạn vừa ôn ${done} thẻ` : 'Phiên ôn thẻ'} icon="trophy-outline">
              {s.due > 0 ? 'Bạn còn thẻ đến hạn.' : 'Không còn thẻ đến hạn.'}
            </Empty>
          )}
          {!card && s.due > 0 && <Button title="Ôn tiếp" busy={due.loading} onPress={due.reload} />}
          {!card && <Button variant="ghost" title="Quay lại" onPress={() => router.back()} />}
        </>
      )}
    </Screen>
  );
}
