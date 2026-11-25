import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Text } from '../../components/Text';
import { LinearGradient } from 'expo-linear-gradient';
import { Card, Empty, ErrorBox, PageHead, Pill, Progress, Ring, Row, Screen, Spinner } from '../../components/ui';
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
      <PageHead kicker={`Chào ${first || 'bạn'} 👋`} title="Hôm nay học gì?" />
      {data.loading && !data.data && <Spinner />}
      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}

      {resume && (
        <Pressable onPress={() => router.push(`/item/${resume.current_item_id}`)} style={({ pressed }) => ({ opacity: pressed ? 0.94 : 1 })}>
          <LinearGradient colors={[C.brandLight, C.brand, C.brandStrong]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: 24, padding: 18, gap: 12, overflow: 'hidden' }}>
            <View style={{ position: 'absolute', top: -50, right: -40, width: 170, height: 170, borderRadius: 85, backgroundColor: 'rgba(255,255,255,0.08)' }} />
            <Text style={{ fontSize: 12, fontWeight: '800', color: 'rgba(255,255,255,0.8)', letterSpacing: 1.2 }}>ĐANG HỌC DỞ</Text>
            <Text style={{ fontSize: 21, fontWeight: '800', letterSpacing: -0.5, color: C.white }} numberOfLines={2}>{resume.title}</Text>
            <Row>
              <Progress value={resume.items_done / Math.max(1, resume.items_total)} style={{ flex: 1 }} light />
              <Text style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)', fontWeight: '600' }}>{resume.items_done}/{resume.items_total} mục</Text>
            </Row>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: C.white, borderRadius: 999, paddingVertical: 12 }}>
              <Ionicons name="play" size={16} color={C.brand} />
              <Text style={{ color: C.brand, fontWeight: '800', fontSize: 16 }}>Học tiếp</Text>
            </View>
          </LinearGradient>
        </Pressable>
      )}

      {s && (
        <Card style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 0 }}>
          <View style={{ flex: 1, alignItems: 'center', gap: 2 }}>
            <Row style={{ gap: 4 }}><Ionicons name="flame" size={14} color={C.brand} /><Text style={{ fontSize: 12, color: C.muted, fontWeight: '600' }}>Chuỗi</Text></Row>
            <Text style={{ fontSize: 20, fontWeight: '800', color: C.brand, letterSpacing: -0.5 }}>{s.streak_days} ngày</Text>
          </View>
          <View style={{ width: 1, alignSelf: 'stretch', backgroundColor: C.cardLine }} />
          <View style={{ flex: 1, alignItems: 'center', gap: 2 }}>
            <Row style={{ gap: 4 }}><Ionicons name="sparkles" size={14} color={C.muted} /><Text style={{ fontSize: 12, color: C.muted, fontWeight: '600' }}>Tổng XP</Text></Row>
            <Text style={{ fontSize: 20, fontWeight: '800', letterSpacing: -0.5 }}>{s.total_xp.toLocaleString('vi-VN')}</Text>
          </View>
          <View style={{ width: 1, alignSelf: 'stretch', backgroundColor: C.cardLine }} />
          <View style={{ flex: 1.2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Ring value={goal} size={44} stroke={6} label={`${Math.round(Math.min(1, goal) * 100)}%`} />
            <View>
              <Text style={{ fontSize: 12, color: C.muted, fontWeight: '600' }}>Hôm nay</Text>
              <Text style={{ fontSize: 14, fontWeight: '800' }}>{s.today_xp}/{s.daily_goal_xp} XP</Text>
            </View>
          </View>
        </Card>
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
            style={({ pressed }) => [{ flexDirection: 'row', gap: 14, alignItems: 'center', backgroundColor: C.card, borderRadius: 22, borderWidth: 1, borderColor: C.cardLine, padding: 10 }, pressed && { opacity: 0.92 }]}>
            <LinearGradient colors={[C.brandLight, C.brand, C.brandStrong]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
              style={{ width: 76, height: 76, borderRadius: 16, alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name={st === 'done' ? 'checkmark-done' : 'book-outline'} size={26} color={C.white} />
            </LinearGradient>
            <View style={{ flex: 1, minWidth: 0, gap: 6, paddingRight: 4 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', letterSpacing: -0.2 }} numberOfLines={2}>{c.title}</Text>
              <Row>
                <Progress value={c.items_done / Math.max(1, c.items_total)} style={{ flex: 1 }} />
                <Text style={{ fontSize: 12, color: C.muted }}>{c.items_done}/{c.items_total}</Text>
              </Row>
              <Text style={{ fontSize: 13, fontWeight: '700', color: st === 'new' ? C.brand : C.muted }}>{st === 'new' ? 'Mới · Bắt đầu học' : st === 'done' ? 'Đã xong · Xem lại' : 'Đang học · Học tiếp'}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={C.muted} />
          </Pressable>
        );
      })}
    </Screen>
  );
}
