import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import { Text } from '../../components/Text';
import { ClassPicker } from '../../components/teacher/ClassPicker';
import { Card, Empty, ErrorBox, Muted, Pill, Row, Screen, Spinner, Tag } from '../../components/ui';
import { api, timeAgo, type ClassInfo } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { refreshNotifications, useNotifications } from '../../lib/notifications';
import { C } from '../../lib/theme';

interface ThreadRow {
  thread_id: string; title: string; body: string; kind: string; author_name: string; pinned: boolean; locked: boolean;
  reply_count: number; has_answer: boolean; like_count: number; created_at: string | null; lesson_code: string | null;
}
type Sort = 'unanswered' | 'new' | 'top';

/** Giáo viên: bảng tin diễn đàn của lớp, mặc định lọc câu hỏi chưa có ai trả lời. */
export default function Forum() {
  const noti = useNotifications();
  const classes = useAsync((signal) => api<ClassInfo[]>('/ai/classes', { signal }), []);
  const [picked, setPicked] = useState('');
  const [sort, setSort] = useState<Sort>('unanswered');
  const cid = picked || classes.data?.[0]?.class_id || '';
  const list = useAsync((signal) => (cid ? api<ThreadRow[]>(`/ai/forum/classes/${encodeURIComponent(cid)}/threads?sort=${sort}`, { signal }) : Promise.resolve([])), [cid, sort]);
  const first = useRef(true);
  useFocusEffect(useCallback(() => {
    if (first.current) { first.current = false; } else list.reload();
    if (cid) api('/ai/notifications/seen', { json: { key: `forum:${cid}` } }).then(refreshNotifications).catch(() => {});
  }, [list.reload, cid]));

  return (
    <Screen onRefresh={list.reload} refreshing={list.loading && !!list.data}>
      {classes.error && <ErrorBox message={classes.error} onRetry={classes.reload} />}
      <ClassPicker classes={classes.data || []} value={cid} onChange={setPicked} counts={noti?.forum_by_class} />
      <Row>
        <Pill label="Chưa trả lời" active={sort === 'unanswered'} onPress={() => setSort('unanswered')} />
        <Pill label="Mới nhất" active={sort === 'new'} onPress={() => setSort('new')} />
        <Pill label="Nổi bật" active={sort === 'top'} onPress={() => setSort('top')} />
      </Row>
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.data && !list.data.length && <Empty title={sort === 'unanswered' ? 'Không còn câu hỏi chờ trả lời' : 'Chưa có bài nào'} icon="chatbubbles-outline" />}
      {list.data?.map((t) => (
        <Card key={t.thread_id} onPress={() => router.push(`/forum/${t.thread_id}`)}>
          <Row style={{ flexWrap: 'wrap' }}>
            {t.pinned && <Tag tone="brand" label="Ghim" />}
            {t.has_answer ? <Tag tone="ok" label="Đã có lời giải" /> : t.kind === 'question' ? <Tag tone="bad" label="Chưa giải" /> : null}
            {!!t.lesson_code && <Tag label={t.lesson_code} />}
          </Row>
          <Text style={{ fontSize: 16, fontWeight: '700', color: C.ink }}>{t.title}</Text>
          <Muted numberOfLines={2}>{t.body}</Muted>
          <Row>
            <Muted style={{ fontSize: 12, flex: 1 }}>{t.author_name} · {timeAgo(t.created_at)}</Muted>
            <Ionicons name="chatbubble-outline" size={14} color={C.muted} /><Muted style={{ fontSize: 12 }}>{t.reply_count}</Muted>
            <View style={{ width: 6 }} />
            <Ionicons name="heart-outline" size={14} color={C.muted} /><Muted style={{ fontSize: 12 }}>{t.like_count}</Muted>
          </Row>
        </Card>
      ))}
    </Screen>
  );
}
