import { useEffect, useRef, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { Button, Card, ErrorBox, Muted, Row, Screen, Spinner } from '../ui';
import { api, errorText, mediaUrl } from '../../lib/api';
import { C } from '../../lib/theme';
import type { ItemProps } from './types';

interface TextSlide { page: number | null; title: string | null; text: string }

/** Slide trên điện thoại: hiện chữ từng trang (backend tách chữ từ PDF/PPTX), có nút mở file gốc. */
export function SlideItem({ item, onCompleted, goNext }: ItemProps) {
  const s = item.slide || ({} as NonNullable<typeof item.slide>);
  const [slides, setSlides] = useState<TextSlide[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(Math.max(1, item.progress_position || 1));
  const completed = useRef(item.completed);

  useEffect(() => {
    if (!s.document_id) { setSlides([]); return; }
    api<{ slides: TextSlide[] }>(`/ai/documents/${s.document_id}/slides`).then((r) => setSlides(r.slides)).catch((e) => setError(errorText(e)));
  }, [s.document_id]);

  const n = slides?.length || 0;
  useEffect(() => {
    if (!n) return;
    const t = setTimeout(() => api(`/ai/learn/items/${item.item_id}/position`, { json: { position: page } }).catch(() => {}), 800);
    if (page >= n && !completed.current) {
      completed.current = true;
      api<{ xp_awarded: number }>(`/ai/learn/items/${item.item_id}/complete`, { method: 'POST' })
        .then((r) => onCompleted(r.xp_awarded)).catch(() => { completed.current = false; });
    }
    return () => clearTimeout(t);
  }, [page, n, item.item_id, onCompleted]);

  const cur = slides?.[Math.min(page, n) - 1];
  return (
    <Screen>
      {!slides && !error && <Spinner />}
      {error && <ErrorBox message={error} />}
      {slides && !n && <Muted>Slide này chưa có nội dung chữ để xem trên điện thoại.</Muted>}
      {cur && (
        <Card style={{ minHeight: 320 }}>
          <Text style={{ color: C.brand, fontWeight: '800', fontSize: 13 }}>TRANG {Math.min(page, n)}/{n}</Text>
          {!!cur.title && <Text style={{ fontSize: 20, fontWeight: '800', color: C.ink }}>{cur.title}</Text>}
          <Text style={{ fontSize: 16, lineHeight: 24, color: C.ink }}>{cur.text}</Text>
        </Card>
      )}
      {n > 0 && (
        <Row style={{ justifyContent: 'space-between' }}>
          <Button small variant="ghost" icon="chevron-back" title="Trước" disabled={page <= 1} onPress={() => setPage((p) => Math.max(1, p - 1))} />
          <Muted>{Math.min(page, n)} / {n}</Muted>
          <Button small icon="chevron-forward" title="Sau" disabled={page >= n} onPress={() => setPage((p) => Math.min(n, p + 1))} />
        </Row>
      )}
      {!!s.notes && <Card><Text style={{ fontWeight: '700', color: C.ink }}>Ghi chú của giáo viên</Text><Muted>{s.notes}</Muted></Card>}
      <View style={{ gap: 8, marginTop: 8 }}>
        {!!s.file_path && <Button variant="ghost" icon="open-outline" title="Mở file slide gốc" onPress={() => Linking.openURL(mediaUrl(s.file_path!))} />}
        {goNext && page >= n && <Button icon="arrow-forward" title="Mục tiếp theo" onPress={goNext} />}
      </View>
    </Screen>
  );
}
