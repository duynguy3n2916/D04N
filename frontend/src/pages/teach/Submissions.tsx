import { useState } from 'react';
import { PageHeader } from '../../components/AppShell';
import { Badge, Button, Empty, ErrorBox, Field, Spinner, useToast } from '../../components/ui';
import { api, apiBlob, errorText, type ClassInfo } from '../../lib/api';
import { useAsync } from '../../lib/hooks';

interface Row {
  student_id: string; student_name: string; item_id: string; quiz_title: string; lesson_code: string; course_title: string;
  status: 'not_started' | 'in_progress' | 'passed' | 'failed'; passed: boolean | null; correct: number | null; total: number | null;
  score: number | null; time_up: boolean; started_at: string | null; finished_at: string | null;
}
interface Submissions { class_id: string; quizzes: number; students: number; rows: Row[] }

const STATUS: Record<Row['status'], { label: string; tone: 'green' | 'red' | 'yellow' | 'gray' }> = {
  passed: { label: 'Đạt', tone: 'green' }, failed: { label: 'Chưa đạt', tone: 'red' },
  in_progress: { label: 'Đang làm', tone: 'yellow' }, not_started: { label: 'Chưa làm', tone: 'gray' },
};

function fmtTime(iso: string | null) {
  return iso ? new Date(iso).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '—';
}

/** Giáo viên: học viên trong lớp đã làm, chưa làm hoặc đạt bài kiểm tra nào. */
export function Submissions() {
  const toast = useToast();
  const classes = useAsync((s) => api<ClassInfo[]>('/ai/classes', { signal: s }), []);
  const [classId, setClassId] = useState('');
  const [status, setStatus] = useState('');
  const cid = classId || classes.data?.[0]?.class_id || '';
  const data = useAsync((s) => (cid ? api<Submissions>(`/ai/classes/${encodeURIComponent(cid)}/submissions`, { signal: s }) : Promise.resolve(null)), [cid]);
  const rows = (data.data?.rows || []).filter((r) => !status || r.status === status);
  const downloadCsv = async () => {
    try {
      const { blob, filename } = await apiBlob(`/ai/classes/${encodeURIComponent(cid)}/submissions.csv`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) { toast(errorText(e), 'error'); }
  };

  return (
    <>
      <PageHeader title="Bài nộp của học viên" sub="Xem học viên trong lớp đã làm bài kiểm tra nào, đạt hay chưa."
        actions={cid ? <Button variant="ghost" icon="doc" onClick={downloadCsv}>Tải Excel (CSV)</Button> : undefined} />
      <div className="row" style={{ marginBottom: 14, alignItems: 'flex-end' }}>
        <Field label="Lớp">
          <select value={cid} onChange={(e) => setClassId(e.target.value)}>
            {classes.data?.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_id} · {c.name}</option>)}
          </select>
        </Field>
        <Field label="Trạng thái">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Tất cả</option><option value="passed">Đạt</option><option value="failed">Chưa đạt</option>
            <option value="in_progress">Đang làm</option><option value="not_started">Chưa làm</option>
          </select>
        </Field>
      </div>
      {!classes.loading && !classes.data?.length && <Empty title="Chưa có lớp nào" />}
      {data.loading && !data.data && <Spinner />}
      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
      {data.data && !data.data.quizzes && <Empty title="Lớp này chưa có bài kiểm tra">Thêm mục kiểm tra vào bài học để theo dõi.</Empty>}
      {data.data && !!data.data.quizzes && (
        <>
          <p className="muted small" style={{ fontWeight: 700 }}>{data.data.students} học viên · {data.data.quizzes} bài kiểm tra</p>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Học viên</th><th>Bài kiểm tra</th><th>Kết quả</th><th>Điểm</th><th>Bắt đầu</th><th>Nộp lúc</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.student_id}-${r.item_id}`}>
                    <td><strong>{r.student_name}</strong><div className="muted small">@{r.student_id}</div></td>
                    <td>{r.quiz_title}<div className="muted small">{r.course_title} · {r.lesson_code}</div></td>
                    <td><Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>{r.time_up && <span className="muted small"> · hết giờ</span>}</td>
                    <td>{r.score != null ? `${r.correct}/${r.total} (${Math.round(r.score * 100)}%)` : '—'}</td>
                    <td>{fmtTime(r.started_at)}</td>
                    <td>{fmtTime(r.finished_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length && <Empty title="Không có dòng nào khớp bộ lọc" />}
        </>
      )}
    </>
  );
}
