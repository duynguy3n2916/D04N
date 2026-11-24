import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Text } from '../../components/Text';
import { Button, Card, Cover, Empty, ErrorBox, PageHead, Pill, Progress, Ring, Row, Screen, Spinner, Stat } from '../../components/ui';
import { api, type CourseSummary, type Stats } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAsync } from '../../lib/hooks';
import { useNotifications } from '../../lib/notifications';
import { C } from '../../lib/theme';

type Filter = 'all' | 'doing' | 'new' | 'done';

/** Trang học: bố cục giống trang Học trên web (khoá đang học dở, chuỗi ngày, mục tiêu XP, thẻ cần ôn, danh sách khoá). */
export default function Learn() {
  const { user } = useAuth();
  const noti = useNotifications();
  const [filter, setFilter] = useState<Filter>('all');
  const data = useAsync(async (signal) => {
    const [me, courses] = await Promise.all([
      api<{ stats: Stats }>('/ai/learn/me', { signal }),
      api<CourseSummary[]>('/ai/learn/courses', { signal }),
    ]);
    return { stats: me.stats, courses };
  }, []);
  const s = data.data?.stats;
  const courses = data.data?.courses || [];
  const first = (user?.display_name || user?.name || '').replace(/\([^)]*\)/g, '').trim().split(/\s+/).pop();
  const resume = courses.find((c) => c.current_item_id && c.items_done > 0 && c.items_done < c.items_total) || courses.find((c) => c.current_item_id && c.items_done < c.items_total);
  const state = (c: CourseSummary): Filter => (c.items_total && c.items_done >= c.items_total ? 'done' : c.items_done > 0 ? 'doing' : 'new');
  const count = (f: Filter) => courses.filter((c) => f === 'all' || state(c) === f).length;
  const shown = courses.filter((c) => filter === 'all' || state(c) === filter);
  const goal = s ? s.today_xp / Math.max(1, s.daily_goal_xp) : 0;

  return (
    <Screen onRefresh={data.reload} refreshing={data.loading && !!data.data}>
      <PageHead kicker="Học" title={`Chào ${first || 'bạn'}, học gì hôm nay?`} />
      {data.loading && !data.data && <Spinner />}
      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}

      {resume && (
        <Card style={{ padding: 10 }} onPress={() => router.push(`/item/${resume.current_item_id}`)}>
          <Cover title={resume.title} height={128} radius={18} />
          <View style={{ padding: 6, gap: 8 }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: C.muted, letterSpacing: 1 }}>ĐANG HỌC DỞ</Text>
            <Text style={{ fontSize: 22, fontWeight: '800', letterSpacing: -0.6 }}>{resume.title}</Text>
            <Row>
              <Progress value={resume.items_done / Math.max(1, resume.items_total)} style={{ flex: 1 }} />
              <Text style={{ fontSize: 13, color: C.muted }}>{resume.items_done}/{resume.items_total} mục · {Math.round((resume.items_done / Math.max(1, resume.items_total)) * 100)}%</Text>
            </Row>
            <Button title="Học tiếp" icon="play" onPress={() => router.push(`/item/${resume.current_item_id}`)} style={{ alignSelf: 'flex-start', marginTop: 2 }} />
          </View>
        </Card>
      )}

      {s && (
        <>
          <Row style={{ gap: 10 }}>
            <Stat icon="star" label="Chuỗi" value={`${s.streak_days} ngày`} brand />
            <Stat icon="sparkles" label="Tổng XP" value={s.total_xp.toLocaleString('vi-VN')} />
          </Row>
          <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
            <Ring value={goal} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 17, fontWeight: '700' }}>Mục tiêu hôm nay</Text>
              <Text style={{ color: C.muted }}>{s.today_xp} / {s.daily_goal_xp} XP{goal < 1 ? ` · còn ${s.daily_goal_xp - s.today_xp} XP` : ' · đã đạt'}</Text>
              <Text style={{ color: C.muted, fontSize: 13 }}>Tuần này {s.week_xp} XP</Text>
            </View>
          </Card>
        </>
      )}

      {!!noti?.flashcards?.length && (
        <Card>
          <Text style={{ fontSize: 15, fontWeight: '700' }}>Thẻ cần ôn hôm nay</Text>
          {noti.flashcards.slice(0, 3).map((f) => (
            <Text key={f.lesson_code} onPress={() => router.push(`/flashcards/${encodeURIComponent(f.lesson_code)}`)}
              style={{ color: C.brand, fontWeight: '600', textDecorationLine: 'underline' }}>{f.lesson_title || f.lesson_code} · {f.due} thẻ</Text>
          ))}
        </Card>
      )}

      {!!courses.length && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} style={{ marginTop: 4 }}>
          <Pill label="Tất cả" active={filter === 'all'} onPress={() => setFilter('all')} count={count('all')} />
          <Pill label="Đang học" active={filter === 'doing'} onPress={() => setFilter('doing')} count={count('doing')} />
          <Pill label="Chưa bắt đầu" active={filter === 'new'} onPress={() => setFilter('new')} count={count('new')} />
          <Pill label="Đã xong" active={filter === 'done'} onPress={() => setFilter('done')} count={count('done')} />
        </ScrollView>
      )}
      {data.data && !courses.length && <Empty title="Chưa có khoá học">Bạn chưa được thêm vào lớp nào có khoá học. Nhập mã lớp ở tab Tôi.</Empty>}
      {shown.map((c) => {
        const st = state(c);
        return (
          <Pressable key={c.course_id} onPress={() => router.push(`/course/${c.course_id}`)}
            style={({ pressed }) => [{ backgroundColor: C.card, borderRadius: 24, borderWidth: 1, borderColor: C.cardLine, overflow: 'hidden' }, pressed && { opacity: 0.92 }]}>
            <Cover title={c.title} radius={0} chip={st === 'done' ? 'Đã xong' : st === 'doing' ? 'Đang học' : 'Mới'} />
            <View style={{ padding: 16, gap: 8 }}>
              <Text style={{ fontSize: 18, fontWeight: '700', letterSpacing: -0.3 }}>{c.title}</Text>
              {!!c.description && <Text style={{ color: C.muted, fontSize: 14, lineHeight: 20 }} numberOfLines={2}>{c.description}</Text>}
              <Row>
                <Progress value={c.items_done / Math.max(1, c.items_total)} style={{ flex: 1 }} />
                <Text style={{ fontSize: 13, color: C.muted }}>{c.items_done}/{c.items_total} mục</Text>
              </Row>
              <Row style={{ gap: 2 }}>
                <Text style={{ fontWeight: '700', color: C.brand }}>{st === 'new' ? 'Bắt đầu học' : st === 'done' ? 'Xem lại' : 'Học tiếp'}</Text>
                <Ionicons name="chevron-forward" size={16} color={C.brand} />
              </Row>
            </View>
          </Pressable>
        );
      })}
    </Screen>
  );
}
