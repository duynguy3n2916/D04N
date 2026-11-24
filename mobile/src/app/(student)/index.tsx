import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { Button, Card, Empty, ErrorBox, H2, Kicker, Muted, Progress, Row, Screen, Spinner } from '../../components/ui';
import { api, type CourseSummary, type Stats } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAsync } from '../../lib/hooks';
import { C } from '../../lib/theme';

export default function Learn() {
  const { user } = useAuth();
  const data = useAsync(async (signal) => {
    const [me, courses] = await Promise.all([
      api<{ stats: Stats }>('/ai/learn/me', { signal }),
      api<CourseSummary[]>('/ai/learn/courses', { signal }),
    ]);
    return { stats: me.stats, courses };
  }, []);
  const s = data.data?.stats;
  const first = (user?.display_name || user?.name || '').trim().split(/\s+/).pop();
  const resume = data.data?.courses.find((c) => c.current_item_id && c.items_done < c.items_total);

  return (
    <Screen onRefresh={data.reload} refreshing={data.loading && !!data.data}>
      <View style={{ gap: 2 }}>
        <Kicker>Xin chào{first ? `, ${first}` : ''}</Kicker>
        <Text style={{ fontSize: 24, fontWeight: '800', color: C.ink }}>Hôm nay học gì nhỉ?</Text>
      </View>
      {data.loading && !data.data && <Spinner />}
      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
      {s && (
        <Card style={{ backgroundColor: C.brand, borderColor: C.brand }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View>
              <Text style={{ color: C.brandTint, fontWeight: '700' }}>Mục tiêu hôm nay</Text>
              <Text style={{ color: C.white, fontSize: 28, fontWeight: '800' }}>{s.today_xp}<Text style={{ fontSize: 16 }}> / {s.daily_goal_xp} XP</Text></Text>
            </View>
            <View style={{ alignItems: 'center' }}>
              <Ionicons name="flame" size={28} color={s.studied_today ? '#FFD8A8' : C.brandMid} />
              <Text style={{ color: C.white, fontWeight: '800' }}>{s.streak_days} ngày</Text>
            </View>
          </Row>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: C.brandStrong, overflow: 'hidden' }}>
            <View style={{ height: '100%', width: `${Math.min(100, (s.today_xp / Math.max(1, s.daily_goal_xp)) * 100)}%`, backgroundColor: C.white }} />
          </View>
          <Text style={{ color: C.brandTint, fontSize: 13 }}>Tuần này {s.week_xp} XP · tổng {s.total_xp} XP</Text>
        </Card>
      )}
      {resume && (
        <Button title={`Học tiếp: ${resume.title}`} icon="play" onPress={() => router.push(`/item/${resume.current_item_id}`)} />
      )}
      {data.data && <H2 style={{ marginTop: 8 }}>Khoá học của bạn</H2>}
      {data.data && !data.data.courses.length && <Empty title="Chưa có khoá học">Bạn chưa được thêm vào lớp nào có khoá học. Nhập mã lớp ở tab Tôi.</Empty>}
      {data.data?.courses.map((c) => (
        <Card key={c.course_id} onPress={() => router.push(`/course/${c.course_id}`)}>
          <Kicker>{c.code}</Kicker>
          <H2>{c.title}</H2>
          {!!c.description && <Muted numberOfLines={2}>{c.description}</Muted>}
          <Progress value={c.items_done / Math.max(1, c.items_total)} />
          <Muted style={{ fontSize: 13 }}>{c.items_done}/{c.items_total} mục đã xong</Muted>
        </Card>
      ))}
    </Screen>
  );
}
