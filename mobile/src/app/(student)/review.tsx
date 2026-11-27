import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Text } from '../../components/Text';
import { Button, Card, Empty, ErrorBox, Muted, Pill, Row, Screen, Spinner } from '../../components/ui';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { refreshNotifications } from '../../lib/notifications';
import { C } from '../../lib/theme';

interface LessonDeck { lesson_code: string; lesson_title: string; chapter_title: string; total: number; due: number; locked: boolean }
interface CourseDecks { course_id: string; title: string; total: number; due: number; lessons: LessonDeck[] }

/** Ôn thẻ: chọn khóa học rồi chọn bài để ôn. Thẻ của từng bài cũng mở được từ trang bài học. */
export default function Review() {
  const data = useAsync((signal) => api<CourseDecks[]>('/ai/learn/flashcards', { signal }), []);
  const first = useRef(true);
  useFocusEffect(useCallback(() => { refreshNotifications(); if (first.current) { first.current = false; return; } data.reload(); }, [data.reload]));
  const courses = data.data || [];
  const [courseId, setCourseId] = useState('');
  useEffect(() => {
    if (courses.length && !courses.some((c) => c.course_id === courseId)) {
      const preferred = courses.find((c) => c.due > 0) || courses.find((c) => c.total > 0)
        || courses.find((c) => c.lessons.length > 0) || courses[0];
      setCourseId(preferred.course_id);
    }
  }, [courses, courseId]);
  const current = courses.find((c) => c.course_id === courseId);
  const dueAll = courses.reduce((n, c) => n + c.due, 0);
  return (
    <Screen onRefresh={data.reload} refreshing={data.loading && !!data.data}>
      <Muted>{dueAll ? `Hôm nay có ${dueAll} thẻ cần ôn. ` : ''}Chọn khóa học và bài để ôn. Thẻ bạn quên sẽ quay lại sớm, thẻ nhớ tốt sẽ giãn ra.</Muted>
      <Row>
        <Button style={{ flex: 1 }} icon="albums-outline" title="Thẻ của tôi" onPress={() => router.push('/flashcards/mine')} />
        <Button style={{ flex: 1 }} variant="ghost" icon="layers-outline" title="Đã học" onPress={() => router.push('/flashcards/library/all')} />
      </Row>
      {data.loading && !data.data && <Spinner />}
      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
      {data.data && !courses.length && <Empty title="Bạn chưa có khóa học nào" icon="book-outline">Vào lớp và khóa học trước để có thẻ ôn.</Empty>}
      {courses.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {courses.map((c) => <Pill key={c.course_id} label={c.title} active={c.course_id === courseId} count={c.due || undefined} onPress={() => setCourseId(c.course_id)} />)}
        </ScrollView>
      )}
      {current && !current.lessons.length && <Empty title="Khóa này chưa có bộ thẻ" icon="layers-outline" />}
      {current?.lessons.map((l) => {
        const empty = !l.total;
        return (
          <Card key={l.lesson_code} onPress={l.locked || empty ? undefined : () => router.push(`/flashcards/${encodeURIComponent(l.lesson_code)}`)}>
            <Row style={{ opacity: empty && !l.locked ? 0.6 : 1 }}>
              <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: l.due ? C.brandSoft : C.wash, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name={l.locked ? 'lock-closed-outline' : 'layers'} size={22} color={l.due ? C.brand : C.muted} />
              </View>
              <View style={{ flex: 1 }}>
                <Muted style={{ fontSize: 12 }}>{l.chapter_title}</Muted>
                <Text style={{ fontSize: 16, fontWeight: '600', color: C.ink }}>{l.lesson_title || l.lesson_code}</Text>
                <Muted style={{ fontSize: 13 }}>{l.locked ? 'Hoàn thành bài học để mở khóa' : empty ? 'Chưa có thẻ' : l.due ? `${l.due} thẻ cần ôn · ${l.total} thẻ` : `Đã ôn xong · ${l.total} thẻ`}</Muted>
              </View>
              {!l.locked && !empty && <Ionicons name="chevron-forward" size={18} color={C.muted} />}
            </Row>
          </Card>
        );
      })}
    </Screen>
  );
}
