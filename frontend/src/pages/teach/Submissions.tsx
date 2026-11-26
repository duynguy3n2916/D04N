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
type Result = '' | 'passed' | 'failed';
const submitted = (r: Row) => r.status === 'passed' || r.status === 'failed';

function fmtTime(iso: string | null) {
  return iso ? new Date(iso).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '—';
}

/** Giáo viên: kết quả bài kiểm tra đã nộp, lọc theo lớp → khóa học → bài kiểm tra. Bài chưa làm không hiện. */
export function Submissions() {
  const toast = useToast();
  const classes = useAsync((s) => api<ClassInfo[]>('/ai/classes', { signal: s }), [], 'classes');
  const [classId, setClassId] = useState('');
  const [course, setCourse] = useState('');
  const [quiz, setQuiz] = useState('');
  const [result, setResult] = useState<Result>('');
  const [q, setQ] = useState('');
  const [student, setStudent] = useState<string | null>(null);
  const cid = classId || classes.data?.[0]?.class_id || '';
  const data = useAsync((s) => (cid ? api<Submissions>(`/ai/classes/${encodeURIComponent(cid)}/submissions`, { signal: s }) : Promise.resolve(null)), [cid]);
  const all = data.data?.rows || [];
  const done = all.filter(submitted);
  // khóa học có bài nộp (kèm số bài nộp), rồi bài kiểm tra trong khóa đang chọn
  const courses = [...done.reduce((m, r) => m.set(r.course_title, (m.get(r.course_title) || 0) + 1), new Map<string, number>())];
  const inCourse = done.filter((r) => !course || r.course_title === course);
  const quizzes = [...new Map(inCourse.map((r) => [r.item_id, r])).values()];
  const inQuiz = inCourse.filter((r) => !quiz || r.item_id === quiz);
  const rows = inQuiz
    .filter((r) => (!result || r.status === result) && (!q || `${r.student_name} ${r.student_id}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => (b.finished_at || '').localeCompare(a.finished_at || ''));
  const passed = inQuiz.filter((r) => r.status === 'passed').length;
  const scored = inQuiz.filter((r) => r.score != null);
  const avg = scored.length ? Math.round((scored.reduce((s, r) => s + (r.score || 0), 0) / scored.length) * 100) : null;
  const doing = all.filter((r) => r.status === 'in_progress' && (!course || r.course_title === course) && (!quiz || r.item_id === quiz)).length;
  const students = [...new Set(rows.map((r) => r.student_id))];
  const pickCourse = (c: string) => { setCourse(c); setQuiz(''); };
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
      <PageHeader title="Kết quả kiểm tra"
        sub="Bài kiểm tra trong khóa học được chấm tự động. Đây là danh sách học sinh đã nộp. Thêm bài kiểm tra ở trang Khóa học (mục loại Kiểm tra)."
        actions={cid ? <Button variant="ghost" icon="doc" onClick={downloadCsv}>Tải Excel (CSV)</Button> : undefined} />
      {(classes.data?.length || 0) > 1 && (
        <Toolbar>
          <PillSelect label="Lớp" value={cid} onChange={(v) => { setClassId(v); pickCourse(''); }}>
            {classes.data?.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_id} · {c.name}</option>)}
          </PillSelect>
        </Toolbar>
      )}
      {courses.length > 0 && (
        <div className="sub-courses" role="group" aria-label="Khóa học">
          <button type="button" className={`pill ${!course ? 'pill-on' : ''}`} aria-pressed={!course} onClick={() => pickCourse('')}>
            Tất cả khóa học <span className="lc-count">{done.length}</span>
          </button>
          {courses.map(([title, count]) => (
            <button key={title} type="button" className={`pill ${course === title ? 'pill-on' : ''}`} aria-pressed={course === title} onClick={() => pickCourse(title)}>
              {title} <span className="lc-count">{count}</span>
            </button>
          ))}
        </div>
      )}
      {done.length > 0 && <KpiRow items={[
        { label: 'Bài đã nộp', value: inQuiz.length },
        { label: 'Đạt', value: passed, brand: true, hint: inQuiz.length ? `${Math.round((passed / inQuiz.length) * 100)}%` : undefined },
        { label: 'Chưa đạt', value: inQuiz.length - passed },
        { label: 'Điểm trung bình', value: avg != null ? `${avg}%` : '—' },
      ]} />}
      {doing > 0 && <p className="muted small" style={{ marginTop: -8 }}>{doing} bài đang làm dở (chưa nộp, không tính ở trên).</p>}
      {done.length > 0 && (
        <Toolbar>
          {quizzes.length > 1 && <PillSelect label="Bài kiểm tra" value={quiz} onChange={setQuiz}>
            <option value="">Tất cả bài</option>
            {quizzes.map((r) => <option key={r.item_id} value={r.item_id}>{r.lesson_code} · {r.quiz_title}</option>)}
          </PillSelect>}
          <SearchBox value={q} onChange={setQ} placeholder="Tìm học sinh…" />
          <FilterPills<Result> label="Kết quả" value={result} onChange={setResult} options={[
            { id: '', label: 'Tất cả', count: inQuiz.length }, { id: 'passed', label: 'Đạt', count: passed },
            { id: 'failed', label: 'Chưa đạt', count: inQuiz.length - passed }]} />
        </Toolbar>
      )}
      {!classes.loading && !classes.data?.length && <Empty title="Chưa có lớp nào">Tạo lớp ở trang Học sinh & lớp để theo dõi kết quả kiểm tra.</Empty>}
      {data.loading && !data.data && <Spinner />}
      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
      {data.data && !data.data.quizzes && <Empty title="Lớp này chưa có bài kiểm tra">Thêm mục loại Kiểm tra vào bài học ở trang Khóa học.</Empty>}
      {data.data && !!data.data.quizzes && (
        rows.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Học sinh</th><th>Bài kiểm tra</th><th>Điểm</th><th>Kết quả</th><th>Nộp lúc</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.student_id}-${r.item_id}`} className={`row-click ${student === r.student_id ? 'row-on' : ''}`} onClick={() => setStudent(r.student_id)}>
                    <td className="td-main"><span className="doc-cell"><Avatar name={r.student_name} id={r.student_id} size={34} /><span><strong>{r.student_name}</strong><span className="td-sub">@{r.student_id}</span></span></span></td>
                    <td>{r.quiz_title}<span className="td-sub">{r.lesson_code}{course ? '' : ` · ${r.course_title}`}</span></td>
                    <td className="td-num">{r.score != null ? `${r.correct}/${r.total} · ${Math.round(r.score * 100)}%` : '—'}</td>
                    <td><StatusTag tone={STATUS[r.status].tone}>{STATUS[r.status].label}</StatusTag>{r.time_up && <span className="td-sub">hết giờ</span>}</td>
                    <td className="td-num">{fmtTime(r.finished_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : inQuiz.length ? (
          <Empty title="Không có bài nộp nào khớp bộ lọc">Thử chọn “Tất cả” hoặc xóa từ khóa.</Empty>
        ) : (
          <Empty title="Chưa có bài nộp">Chưa có học sinh nào nộp bài kiểm tra của khóa này.</Empty>
        )
      )}
      {student && (() => {
        const mine = done.filter((r) => r.student_id === student);
        const idx = students.indexOf(student);
        const next = idx >= 0 && idx < students.length - 1 ? students[idx + 1] : null;
        const ok = mine.filter((r) => r.status === 'passed').length;
        return (
          <Drawer title={mine[0]?.student_name || student} onClose={() => setStudent(null)}
            footer={<Button icon="chevronRight" disabled={!next} onClick={() => next && setStudent(next)}>Học sinh tiếp theo</Button>}>
            <p className="muted" style={{ margin: 0 }}>@{student} · đạt {ok}/{mine.length} bài đã nộp</p>
            {mine.map((r) => (
              <div key={r.item_id} className="chunk sub-row">
                <div className="grow" style={{ minWidth: 0 }}>
                  <strong>{r.quiz_title}</strong>
                  <span className="td-sub">{r.course_title} · {r.lesson_code} · nộp {fmtTime(r.finished_at)}{r.time_up ? ' · hết giờ' : ''}</span>
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
