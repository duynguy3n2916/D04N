import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Markdown } from '../../../components/Markdown';
import { Text } from '../../../components/Text';
import { Button, Card, Empty, ErrorBox, Muted, Pill, Row, Screen, Spinner, Tag } from '../../../components/ui';
import { api, errorText } from '../../../lib/api';
import { useAsync } from '../../../lib/hooks';
import { refreshNotifications } from '../../../lib/notifications';

const FILTERS = [
  { id: 'all', label: 'Tất cả' },
  { id: 'remembered', label: 'Đã nhớ' },
  { id: 'unremembered', label: 'Chưa nhớ' },
] as const;
type Filter = typeof FILTERS[number]['id'];
interface LibraryCard {
  card_id: string; lesson_title: string; front: string; back: string; explanation: string; remembered: boolean;
}
interface LibraryPage { cards: LibraryCard[]; next_offset: number | null }

export default function FlashcardLibrary() {
  const [filter, setFilter] = useState<Filter>('all');
  const [offset, setOffset] = useState(0);
  return (
    <Screen>
      <Row style={{ flexWrap: 'wrap' }}>
        {FILTERS.map((f) => (
          <Pill key={f.id} label={f.label} active={filter === f.id} onPress={() => { setFilter(f.id); setOffset(0); }} />
        ))}
      </Row>
      <LibraryCards key={`${filter}/${offset}`} filter={filter} offset={offset} setOffset={setOffset} />
    </Screen>
  );
}

function LibraryCards({ filter, offset, setOffset }: { filter: Filter; offset: number; setOffset: (value: number) => void }) {
  const page = useAsync((signal) => api<LibraryPage>(`/ai/learn/flashcards/library?status=${filter}&offset=${offset}`, { signal }), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mark = async (card: LibraryCard) => {
    setBusy(card.card_id);
    setError(null);
    try {
      const result = await api<{ remembered: boolean }>(`/ai/learn/flashcards/${card.card_id}/memory`, {
        method: 'PUT', json: { remembered: !card.remembered },
      });
      if (filter === 'all') {
        page.setData((prev) => prev && ({ ...prev, cards: prev.cards.map((c) => c.card_id === card.card_id ? { ...c, remembered: result.remembered } : c) }));
      } else if (offset > 0) {
        setOffset(0);
      } else {
        page.reload();
      }
      void refreshNotifications();
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  };
  const nextOffset = page.data?.next_offset;
  return (
    <>
      {page.loading && <Spinner />}
      {page.error && <ErrorBox message={page.error} onRetry={page.reload} />}
      {error && <ErrorBox message={error} />}
      {page.data && !page.data.cards.length && <Empty title={filter === 'all' ? 'Bạn chưa mở khóa thẻ nào' : 'Không có thẻ trong bộ lọc này'} />}
      {page.data?.cards.map((card) => (
        <MemoryCard key={card.card_id} card={card} disabled={busy !== null || page.loading} onMark={() => mark(card)} />
      ))}
      {(offset > 0 || nextOffset != null) && (
        <Row style={{ justifyContent: 'space-between' }}>
          <Button variant="ghost" title="Trang trước" disabled={!offset || busy !== null} onPress={() => setOffset(Math.max(0, offset - 20))} />
          {nextOffset != null && <Button title="Trang sau" disabled={busy !== null} onPress={() => setOffset(nextOffset)} />}
        </Row>
      )}
    </>
  );
}

function MemoryCard({ card, disabled, onMark }: { card: LibraryCard; disabled: boolean; onMark: () => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Card>
      <View style={{ gap: 10 }}>
        <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <Muted>{card.lesson_title}</Muted>
          <Tag tone={card.remembered ? 'ok' : undefined} label={card.remembered ? 'Đã nhớ' : 'Chưa nhớ'} />
        </Row>
        <Text style={{ fontWeight: '700' }}>{card.front}</Text>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)}>
          <Text style={{ paddingVertical: 6 }}>{expanded ? 'Ẩn đáp án' : 'Xem đáp án'}</Text>
        </Pressable>
        {expanded && <><Markdown text={card.back} />{!!card.explanation && <Markdown text={card.explanation} />}</>}
        <Button small variant="ghost" disabled={disabled} onPress={onMark}
          title={card.remembered ? 'Đánh dấu chưa nhớ' : 'Đánh dấu đã nhớ'} />
      </View>
    </Card>
  );
}
