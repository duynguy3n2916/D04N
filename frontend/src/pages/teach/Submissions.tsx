import { useState } from 'react';
import { PageHeader } from '../../components/AppShell';
import { Drawer, FilterPills, KpiRow, PillSelect, SearchBox, StatusTag, Toolbar } from '../../components/Manage';
import { Avatar } from '../../components/Social';
import { Button, Empty, ErrorBox, Spinner, useToast } from '../../components/ui';
import { api, apiBlob, errorText, type ClassInfo } from '../../lib/api';
import { useAsync } from '../../lib/hooks';

interface Row {
  student_id: string; student_name: string; item_id: string; quiz_title: string; lesson_code: string; course_title: string;
  status: 'not_started' | 'in_progress' | 'passed' | 'failed'; passed: boolean | null; correct: number | null; total: number | null;
  score: number | null; time_up: boolean; started_at: string | null; finished_at: string | null;
}
interface Submissions { class_id: string; quizzes: number; students: number; rows: Row[] }

const STATUS: Record<Row['status'], { label: string; tone: 'ok' | 'bad' | 'wait' | 'muted' }> = {
  passed: { label: 'Đạt', tone: 'ok' }, failed: { label: 'Chưa đạt', tone: 'bad' },
  in_progress: { label: 'Đang làm', tone: 'wait' }, not_started: { label: 'Chưa làm', tone: 'muted' },
};
type St = '' | Row['status'];

function fmtTime(iso: string | null) {
  return iso ? new Date(iso).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '—';
}

/** Giáo viên: học viên trong lớp đã làm, chưa làm hoặc đạt bài kiểm tra nào. */
export function Submissions() {
  const toast = useToast();
  const classes = useAsync((s) => api<ClassInfo[]>('/ai/classes', { signal: s }), []);
  const [classId, setClassId] = useState('');
  const [status, setStatus] = useState<St>('');
  const [quiz, setQuiz] = useState('');
  const [q, setQ] = useState('');
  const [student, setStudent] = useState<string | null>(null);
  const cid = classId || classes.data?.[0]?.class_id || '';
  const data = useAsync((s) => (cid ? api<Submissions>(`/ai/classes/${encodeURIComponent(cid)}/submissions`, { signal: s }) : Promise.resolve(null)), [cid]);
  const all = data.data?.rows || [];
  const inQuiz = all.filter((r) => !quiz || r.item_id === quiz);
  const rows = inQuiz.filter((r) => (!status || r.status === status) && (!q || `${r.student_name} ${r.student_id}`.toLowerCase().includes(q.toLowerCase())));
  const quizzes = [...new Map(all.map((r) => [r.item_id, r])).values()];
  const n = (st: Row['status']) => inQuiz.filter((r) => r.status === st).length;
  const done = n('passed') + n('failed');
  const students = [...new Set(rows.map((r) => r.student_id))];
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
      <PageHeader title="Bài nộp" sub="Học viên trong lớp đã làm bài kiểm tra nào, đạt hay chưa. Bài kiểm tra được chấm tự động."
        actions={cid ? <Button variant="ghost" icon="doc" onClick={downloadCsv}>Tải Excel (CSV)</Button> : undefined} />
      {data.data && !!data.data.quizzes && <KpiRow items={[
        { label: 'Đã nộp', value: done, hint: `trên ${inQuiz.length} lượt cần làm` },
        { label: 'Chưa làm', value: n('not_started'), brand: true, hint: 'cần nhắc' },
        { label: 'Tỉ lệ đạt', value: done ? `${Math.round((n('passed') / done) * 100)}%` : '—', hint: `${n('passed')} lượt đạt` },
        { label: 'Đang làm', value: n('in_progress') },
      ]} />}
      <Toolbar>
        <SearchBox value={q} onChange={setQ} placeholder="Tìm học viên…" />
        {(classes.data?.length || 0) > 1 && <PillSelect label="Lớp" value={cid} onChange={setClassId}>
          {classes.data?.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_id} · {c.name}</option>)}
        </PillSelect>}
        {quizzes.length > 1 && <PillSelect label="Bài kiểm tra" value={quiz} onChange={setQuiz}>
          <option value="">Mọi bài kiểm tra</option>
          {quizzes.map((r) => <option key={r.item_id} value={r.item_id}>{r.lesson_code} · {r.quiz_title}</option>)}
        </PillSelect>}
        <FilterPills<St> label="Trạng thái" value={status} onChange={setStatus} options={[
          { id: '', label: 'Tất cả' }, { id: 'not_started', label: 'Chưa làm', count: n('not_started') }, { id: 'failed', label: 'Chưa đạt', count: n('failed') },
          { id: 'passed', label: 'Đạt', count: n('passed') }, { id: 'in_progress', label: 'Đang làm', count: n('in_progress') }]} />
      </Toolbar>
      {!classes.loading && !classes.data?.length && <Empty title="Chưa có lớp nào">Tạo lớp ở trang Học sinh & lớp để theo dõi bài nộp.</Empty>}
      {data.loading && !data.data && <Spinner />}
      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
      {data.data && !data.data.quizzes && <Empty title="Lớp này chưa có bài kiểm tra">Thêm mục kiểm tra vào bài học để theo dõi.</Empty>}
      {data.data && !!data.data.quizzes && (
        <>
          {!!rows.length && <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Học viên</th><th>Bài kiểm tra</th><th>Kết quả</th><th>Điểm</th><th>Nộp lúc</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.student_id}-${r.item_id}`} className={`row-click ${student === r.student_id ? 'row-on' : ''}`} onClick={() => setStudent(r.student_id)}>
                    <td className="td-main"><span className="doc-cell"><Avatar name={r.student_name} id={r.student_id} size={34} /><span><strong>{r.student_name}</strong><span className="td-sub">@{r.student_id}</span></span></span></td>
                    <td>{r.quiz_title}<span className="td-sub">{r.lesson_code} · {r.course_title}</span></td>
                    <td><StatusTag tone={STATUS[r.status].tone}>{STATUS[r.status].label}</StatusTag>{r.time_up && <span className="td-sub">hết giờ</span>}</td>
                    <td className="td-num">{r.score != null ? `${r.correct}/${r.total} · ${Math.round(r.score * 100)}%` : '—'}</td>
                    <td className="td-num">{fmtTime(r.finished_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>}
          {!rows.length && <Empty title="Không có dòng nào khớp bộ lọc">Thử chọn “Tất cả” hoặc xóa từ khóa.</Empty>}
        </>
      )}
      {student && (() => {
        const mine = all.filter((r) => r.student_id === student);
        const idx = students.indexOf(student);
        const next = idx >= 0 && idx < students.length - 1 ? students[idx + 1] : null;
        const passed = mine.filter((r) => r.status === 'passed').length;
        return (
          <Drawer title={mine[0]?.student_name || student} onClose={() => setStudent(null)}
            footer={<Button icon="chevronRight" disabled={!next} onClick={() => next && setStudent(next)}>Học viên tiếp theo</Button>}>
            <p className="muted" style={{ margin: 0 }}>@{student} · đạt {passed}/{mine.length} bài kiểm tra</p>
            {mine.map((r) => (
              <div key={r.item_id} className="chunk sub-row">
                <div className="grow" style={{ minWidth: 0 }}>
                  <strong>{r.quiz_title}</strong>
                  <span className="td-sub">{r.lesson_code} · bắt đầu {fmtTime(r.started_at)} · nộp {fmtTime(r.finished_at)}{r.time_up ? ' · hết giờ' : ''}</span>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <StatusTag tone={STATUS[r.status].tone}>{STATUS[r.status].label}</StatusTag>
                  {r.score != null && <span className="td-num" style={{ display: 'block', marginTop: 4 }}>{r.correct}/{r.total}</span>}
                </div>
              </div>
            ))}
          </Drawer>
        );
      })()}
    </>
  );
}
