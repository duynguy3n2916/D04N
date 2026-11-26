import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import { Text } from '../../components/Text';
import { ErrorBox, Kicker, ListCard, Pill, Spinner, type IconName } from '../../components/ui';
import { Screen } from '../../components/ui';
import { api, timeAgo } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAsync } from '../../lib/hooks';
import { C, shadow } from '../../lib/theme';

interface ConvSummary { id: string; title: string; created_at: string; updated_at: string }

const SUGGESTIONS: { icon: IconName; title: string; text: string }[] = [
  { icon: 'list', title: 'Ôn cho bài kiểm tra', text: 'Mình nên ôn gì cho bài kiểm tra sắp tới?' },
  { icon: 'stats-chart', title: 'Tìm phần còn yếu', text: 'Mình đang yếu phần nào?' },
  { icon: 'time-outline', title: 'Kế hoạch 30 phút', text: 'Lập kế hoạch học 30 phút hôm nay giúp mình' },
  { icon: 'copy-outline', title: 'Đưa câu sai vào thẻ ôn', text: 'Đưa các câu mình hay sai vào thẻ ôn' },
];

/** Trợ lý học tập: màn chào giống web (gợi ý câu hỏi) + lịch sử trò chuyện để chat tiếp. */
export default function CoachList() {
  const { user } = useAuth();
  const list = useAsync((signal) => api<ConvSummary[]>('/ai/coach/conversations', { signal }), []);
  const courses = useAsync((signal) => api<{ course_id: string; title: string }[]>('/ai/learn/courses', { signal }), []);
  // khóa học đang ôn: trợ lý chỉ xem tiến độ và tìm học liệu trong khóa này
  const [course, setCourse] = useState('');
  useEffect(() => { if (courses.data?.length === 1) setCourse(courses.data[0].course_id); }, [courses.data]);
  const courseTitle = courses.data?.find((c) => c.course_id === course)?.title;
  const first = useRef(true);
  useFocusEffect(useCallback(() => { if (first.current) { first.current = false; return; } list.reload(); }, [list.reload]));
  const name = (user?.display_name || user?.name || '').replace(/\([^)]*\)/g, '').trim().split(/\s+/).pop();
  const ask = (q?: string) => {
    const qs = [q && `q=${encodeURIComponent(q)}`, course && `course=${encodeURIComponent(course)}`].filter(Boolean).join('&');
    router.push(`/coach/new${qs ? `?${qs}` : ''}`);
  };
  const remove = (c: ConvSummary) => Alert.alert('Xoá cuộc trò chuyện?', c.title, [
    { text: 'Huỷ', style: 'cancel' },
    { text: 'Xoá', style: 'destructive', onPress: async () => { await api(`/ai/coach/conversations/${c.id}`, { method: 'DELETE' }).catch(() => {}); list.reload(); } },
  ]);
  return (
    <Screen onRefresh={list.reload} refreshing={list.loading && !!list.data}>
      <View style={{ alignItems: 'center', gap: 10, paddingTop: 8 }}>
        <View style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: C.brand, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="sparkles" size={26} color={C.white} />
        </View>
        <Text style={{ fontSize: 26, fontWeight: '800', letterSpacing: -0.8, textAlign: 'center' }}>Chào {name || 'bạn'}, hôm nay mình ôn gì?</Text>
        <Text style={{ color: C.muted, textAlign: 'center', lineHeight: 21 }}>Trợ lý xem tiến độ, các câu bạn hay sai và thẻ đến hạn của bạn, rồi lập kế hoạch ôn. Trợ lý không nói đáp án bài kiểm tra.</Text>
      </View>
      {!!courses.data?.length && (
        <View style={{ gap: 6 }}>
          <Text style={{ color: C.muted, fontSize: 13 }}>Ôn khóa học</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            <Pill label="Tất cả khóa" active={!course} onPress={() => setCourse('')} />
            {courses.data.map((c) => <Pill key={c.course_id} label={c.title} active={course === c.course_id} onPress={() => setCourse(c.course_id)} />)}
          </ScrollView>
        </View>
      )}
      <Pressable onPress={() => ask()} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 24, borderWidth: 1.5, borderColor: C.brandTint, padding: 8, paddingLeft: 18, ...shadow }}>
        <Text style={{ flex: 1, color: C.muted, fontSize: 15 }}>{courseTitle ? `Hỏi về khóa ${courseTitle}…` : 'Hỏi trợ lý, ví dụ: Mai kiểm tra chương 1, giúp mình ôn'}</Text>
        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: C.brand, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="arrow-forward" size={20} color={C.white} />
        </View>
      </Pressable>
      {SUGGESTIONS.map((s) => (
        <Pressable key={s.title} onPress={() => ask(s.text)}
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 20, backgroundColor: pressed ? C.wash : C.card, borderWidth: 1, borderColor: C.cardLine })}>
          <Ionicons name={s.icon} size={18} color={C.brand} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: '700', fontSize: 15 }}>{s.title}</Text>
            <Text style={{ color: C.muted, fontSize: 13 }}>{s.text}</Text>
          </View>
        </Pressable>
      ))}

      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {!!list.data?.length && (
        <>
          <Kicker style={{ color: C.muted, marginTop: 10 }}>Lịch sử</Kicker>
          <ListCard>
            {list.data.map((c, i) => (
              <Pressable key={c.id} onPress={() => router.push(`/coach/${c.id}`)} onLongPress={() => remove(c)}
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 16, backgroundColor: pressed ? C.wash : 'transparent', borderTopWidth: i ? 1 : 0, borderTopColor: C.cardLine })}>
                <Ionicons name="chatbubble-ellipses-outline" size={18} color={C.brand} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '600' }} numberOfLines={1}>{c.title || 'Cuộc trò chuyện'}</Text>
                  <Text style={{ color: C.muted, fontSize: 12 }}>{timeAgo(c.updated_at)}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={C.muted} />
              </Pressable>
            ))}
          </ListCard>
          <Text style={{ fontSize: 12, textAlign: 'center', color: C.muted }}>Nhấn giữ một cuộc trò chuyện để xoá.</Text>
        </>
      )}
    </Screen>
  );
}
