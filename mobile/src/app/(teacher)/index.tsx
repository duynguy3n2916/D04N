import Ionicons from '@expo/vector-icons/Ionicons';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { Text } from '../../components/Text';
import { ClassPicker } from '../../components/teacher/ClassPicker';
import { Avatar, Card, PageHead, Empty, ErrorBox, Muted, Pill, Progress, Row, Screen, Spinner, Tag } from '../../components/ui';
import { api, type ClassInfo } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { C } from '../../lib/theme';

interface SubRow {
  student_id: string; student_name: string; item_id: string; quiz_title: string; lesson_code: string;
  status: 'not_started' | 'in_progress' | 'passed' | 'failed'; correct: number | null; total: number | null; score: number | null; finished_at: string | null;
}
interface Submissions { class_id: string; quizzes: number; students: number; rows: SubRow[] }
const STATUS = { passed: ['Đạt', 'ok'], failed: ['Chưa đạt', 'bad'], in_progress: ['Đang làm', 'brand'], not_started: ['Chưa làm', 'muted'] } as const;

/** Giáo viên: tổng quan bài kiểm tra của lớp, ai đã đạt, ai chưa làm (dữ liệu từ /ai/classes/{id}/submissions). */
export default function ClassProgress() {
  const classes = useAsync((signal) => api<ClassInfo[]>('/ai/classes', { signal }), []);
  const [picked, setPicked] = useState('');
  const cid = picked || classes.data?.[0]?.class_id || '';
  const data = useAsync((signal) => (cid ? api<Submissions>(`/ai/classes/${encodeURIComponent(cid)}/submissions`, { signal }) : Promise.resolve(null)), [cid]);
  const [filter, setFilter] = useState<'all' | 'behind'>('all');
  const [open, setOpen] = useState<string | null>(null);

  const rows = data.data?.rows || [];
  const n = (s: SubRow['status']) => rows.filter((r) => r.status === s).length;
  const submitted = n('passed') + n('failed');
  const students = useMemo(() => {
    const map = new Map<string, { id: string; name: string; rows: SubRow[] }>();
    rows.forEach((r) => { const s = map.get(r.student_id) || { id: r.student_id, name: r.student_name, rows: [] }; s.rows.push(r); map.set(r.student_id, s); });
    return [...map.values()].map((s) => ({ ...s, passed: s.rows.filter((r) => r.status === 'passed').length, todo: s.rows.filter((r) => r.status === 'not_started' || r.status === 'failed').length }))
      .sort((a, b) => b.todo - a.todo || a.name.localeCompare(b.name));
  }, [rows]);
  const shown = filter === 'behind' ? students.filter((s) => s.todo > 0) : students;

  return (
    <Screen onRefresh={() => { classes.reload(); data.reload(); }} refreshing={data.loading && !!data.data}>
      <PageHead kicker="Lớp học" title="Tiến độ bài kiểm tra" />
      {classes.error && <ErrorBox message={classes.error} onRetry={classes.reload} />}
      <ClassPicker classes={classes.data || []} value={cid} onChange={setPicked} />
      {classes.data && !classes.data.length && <Empty title="Chưa có lớp nào">Tạo lớp và thêm học sinh trên bản web.</Empty>}
      {(classes.loading || data.loading) && !data.data && <Spinner />}
      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
      {data.data && !data.data.quizzes && <Empty title="Lớp này chưa có bài kiểm tra">Thêm mục kiểm tra vào bài học (trên web) để theo dõi tiến độ.</Empty>}
      {data.data && !!data.data.quizzes && (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            <Kpi label="Học sinh" value={String(data.data.students)} />
            <Kpi label="Đã nộp" value={`${submitted}/${rows.length}`} />
            <Kpi label="Tỉ lệ đạt" value={submitted ? `${Math.round((n('passed') / submitted) * 100)}%` : '—'} brand />
            <Kpi label="Chưa làm" value={String(n('not_started'))} />
          </View>
          <Row>
            <Pill label="Tất cả" active={filter === 'all'} onPress={() => setFilter('all')} count={students.length} />
            <Pill label="Cần nhắc" active={filter === 'behind'} onPress={() => setFilter('behind')} count={students.filter((s) => s.todo > 0).length} />
          </Row>
          {shown.map((s) => (
            <Card key={s.id} onPress={() => setOpen(open === s.id ? null : s.id)}>
              <Row>
                <Avatar name={s.name} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 16, fontWeight: '700', color: C.ink }}>{s.name}</Text>
                  <Muted style={{ fontSize: 13 }}>Đạt {s.passed}/{s.rows.length} bài{s.todo ? ` · ${s.todo} bài cần làm lại hoặc chưa làm` : ''}</Muted>
                </View>
                <Ionicons name={open === s.id ? 'chevron-up' : 'chevron-down'} size={18} color={C.muted} />
              </Row>
              <Progress value={s.passed / Math.max(1, s.rows.length)} />
              {open === s.id && s.rows.map((r) => (
                <Row key={r.item_id} style={{ justifyContent: 'space-between', paddingTop: 6 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: C.ink }}>{r.quiz_title}</Text>
                    <Muted style={{ fontSize: 12 }}>{r.lesson_code}{r.score != null ? ` · ${r.correct}/${r.total} (${Math.round(r.score * 100)}%)` : ''}</Muted>
                  </View>
                  <Tag label={STATUS[r.status][0]} tone={STATUS[r.status][1]} />
                </Row>
              ))}
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
