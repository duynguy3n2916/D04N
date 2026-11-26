import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Text } from '../../components/Text';
import { ClassPicker } from '../../components/teacher/ClassPicker';
import { Avatar, Card, PageHead, Empty, ErrorBox, Muted, Pill, Row, Screen, Spinner, Tag } from '../../components/ui';
import { api, type ClassInfo } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { C } from '../../lib/theme';

interface SubRow {
  student_id: string; student_name: string; item_id: string; quiz_title: string; lesson_code: string; course_title?: string;
  status: 'not_started' | 'in_progress' | 'passed' | 'failed'; correct: number | null; total: number | null; score: number | null; finished_at: string | null;
}
interface Submissions { class_id: string; quizzes: number; students: number; rows: SubRow[] }
type Result = 'all' | 'passed' | 'failed';

function fmtTime(iso: string | null) {
  return iso ? new Date(iso).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '';
}

/** Giáo viên: kết quả bài kiểm tra đã nộp của lớp, lọc theo khóa học. Bài chưa làm không hiện. */
export default function ClassProgress() {
  const classes = useAsync((signal) => api<ClassInfo[]>('/ai/classes', { signal }), []);
  const [picked, setPicked] = useState('');
  const cid = picked || classes.data?.[0]?.class_id || '';
  const data = useAsync((signal) => (cid ? api<Submissions>(`/ai/classes/${encodeURIComponent(cid)}/submissions`, { signal }) : Promise.resolve(null)), [cid]);
  const [course, setCourse] = useState('');
  const [result, setResult] = useState<Result>('all');

  const done = (data.data?.rows || []).filter((r) => r.status === 'passed' || r.status === 'failed');
  const courses = [...done.reduce((m, r) => m.set(r.course_title || 'Khóa học', (m.get(r.course_title || 'Khóa học') || 0) + 1), new Map<string, number>())];
  const inCourse = done.filter((r) => !course || (r.course_title || 'Khóa học') === course);
  const passed = inCourse.filter((r) => r.status === 'passed').length;
  const scored = inCourse.filter((r) => r.score != null);
  const avg = scored.length ? Math.round((scored.reduce((s, r) => s + (r.score || 0), 0) / scored.length) * 100) : null;
  const shown = inCourse.filter((r) => result === 'all' || r.status === result).sort((a, b) => (b.finished_at || '').localeCompare(a.finished_at || ''));

  return (
    <Screen onRefresh={() => { classes.reload(); data.reload(); }} refreshing={data.loading && !!data.data}>
      <PageHead kicker="Lớp học" title="Kết quả kiểm tra" />
      {classes.error && <ErrorBox message={classes.error} onRetry={classes.reload} />}
      <ClassPicker classes={classes.data || []} value={cid} onChange={(v) => { setPicked(v); setCourse(''); }} />
      {classes.data && !classes.data.length && <Empty title="Chưa có lớp nào">Tạo lớp và thêm học sinh trên bản web.</Empty>}
      {(classes.loading || data.loading) && !data.data && <Spinner />}
      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
      {data.data && !data.data.quizzes && <Empty title="Lớp này chưa có bài kiểm tra">Thêm mục loại Kiểm tra vào bài học (trên web).</Empty>}
      {data.data && !!data.data.quizzes && !done.length && <Empty title="Chưa có bài nộp">Chưa có học sinh nào nộp bài kiểm tra.</Empty>}
      {data.data && done.length > 0 && (
        <>
          {courses.length > 1 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              <Pill label="Tất cả khóa" active={!course} onPress={() => setCourse('')} count={done.length} />
              {courses.map(([title, count]) => <Pill key={title} label={title} active={course === title} onPress={() => setCourse(title)} count={count} />)}
            </ScrollView>
          )}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            <Kpi label="Bài đã nộp" value={String(inCourse.length)} />
            <Kpi label="Đạt" value={String(passed)} brand />
            <Kpi label="Chưa đạt" value={String(inCourse.length - passed)} />
            <Kpi label="Điểm trung bình" value={avg != null ? `${avg}%` : '—'} />
          </View>
          <Row>
            <Pill label="Tất cả" active={result === 'all'} onPress={() => setResult('all')} count={inCourse.length} />
            <Pill label="Đạt" active={result === 'passed'} onPress={() => setResult('passed')} count={passed} />
            <Pill label="Chưa đạt" active={result === 'failed'} onPress={() => setResult('failed')} count={inCourse.length - passed} />
          </Row>
          {!shown.length && <Empty title="Không có bài nộp nào khớp">Thử chọn “Tất cả”.</Empty>}
          {shown.map((r) => (
            <Card key={`${r.student_id}-${r.item_id}`}>
              <Row>
                <Avatar name={r.student_name} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 16, fontWeight: '700', color: C.ink }}>{r.student_name}</Text>
                  <Muted style={{ fontSize: 13 }}>{r.quiz_title}{course ? '' : r.course_title ? ` · ${r.course_title}` : ''}</Muted>
                  <Muted style={{ fontSize: 12 }}>
                    {r.score != null ? `${r.correct}/${r.total} (${Math.round(r.score * 100)}%)` : ''}{r.finished_at ? ` · nộp ${fmtTime(r.finished_at)}` : ''}
                  </Muted>
                </View>
                <Tag label={r.status === 'passed' ? 'Đạt' : 'Chưa đạt'} tone={r.status === 'passed' ? 'ok' : 'bad'} />
              </Row>
            </Card>
          ))}
        </>
      )}
    </Screen>
  );
}

function Kpi({ label, value, brand }: { label: string; value: string; brand?: boolean }) {
  return (
    <View style={{ flexBasis: '47%', flexGrow: 1, padding: 14, borderRadius: 18, backgroundColor: brand ? C.brand : C.card, borderWidth: 1, borderColor: brand ? C.brand : C.line }}>
      <Text style={{ fontSize: 13, color: brand ? C.brandTint : C.muted, fontWeight: '600' }}>{label}</Text>
      <Text style={{ fontSize: 24, fontWeight: '800', color: brand ? C.white : C.ink }}>{value}</Text>
    </View>
  );
}
