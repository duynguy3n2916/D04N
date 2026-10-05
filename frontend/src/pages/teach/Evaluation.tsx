import { useRef, useState } from 'react';
import { PageHeader } from '../../components/AppShell';
import { Markdown } from '../../components/Markdown';
import { Badge, Button, Empty, ErrorBox, Spinner, useToast } from '../../components/ui';
import { api, errorText, pollJob } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAsync } from '../../lib/hooks';

interface Run { evaluation_id: string; test_suite_name: string; split: string; total_samples: number; error_count: number; hit_at_k: number | null; groundedness_score: number | null; avg_latency_ms: number | null; metrics: Record<string, any>; created_at: string }
interface RunFull extends Run { report_markdown: string | null }

const pct = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x * 1000) / 10}%`);

/** Đánh giá chất lượng Tutor (RAG): Hit@k, độ bám nguồn, từ chối đúng, độ trễ. */
export function Evaluation() {
  const toast = useToast();
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const samples = useAsync((s) => api<{ total: number; samples: { split: string; answerable: boolean }[] }>('/ai/evaluation/samples', { signal: s }), []);
  const runs = useAsync((s) => api<Run[]>('/ai/evaluation/runs', { signal: s }), []);
  const [sel, setSel] = useState<string | null>(null);
  const report = useAsync((s) => {
    const id = sel || runs.data?.[0]?.evaluation_id;
    return id ? api<RunFull>(`/ai/evaluation/runs/${id}`, { signal: s }) : Promise.resolve(null);
  }, [sel, runs.data?.[0]?.evaluation_id]);
  const [job, setJob] = useState<string | null>(null);
  const [split, setSplit] = useState('test');
  const [judge, setJudge] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadDefault = async () => {
    try { const r = await api<{ loaded: number; total: number }>('/ai/evaluation/samples', { json: { use_default_file: true, replace: true } }); toast(`Đã nạp ${r.loaded} mẫu`, 'success'); samples.reload(); }
    catch (e) { toast(errorText(e), 'error'); }
  };
  const loadFile = async (f: File) => {
    try {
      const data = JSON.parse(await f.text());
      const list = Array.isArray(data) ? data : data.samples;
      const r = await api<{ loaded: number }>('/ai/evaluation/samples', { json: { samples: list, replace: true } });
      toast(`Đã nạp ${r.loaded} mẫu từ ${f.name}`, 'success'); samples.reload();
    } catch (e) { toast('File JSON không hợp lệ: ' + errorText(e), 'error'); }
    if (fileRef.current) fileRef.current.value = '';
  };
  const run = async () => {
    try {
      const j = await api<{ job_id: string }>('/ai/evaluation/run', { json: { split, use_judge: judge } });
      setJob('Đang chạy…');
      const r = await pollJob(j.job_id, (x) => setJob(`Đang chạy… ${x.progress != null ? Math.round(x.progress * 100) + '%' : ''} ${x.message || ''}`));
      setJob(null);
      if (r.status === 'failed') toast(r.error || 'Đánh giá thất bại', 'error'); else { toast('Đã chạy xong đánh giá', 'success'); setSel(null); runs.reload(); }
    } catch (e) { setJob(null); toast(errorText(e), 'error'); }
  };
  const download = () => {
    const r = report.data; if (!r?.report_markdown) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([r.report_markdown], { type: 'text/markdown' }));
    a.download = `evaluation-${r.created_at.slice(0, 10)}.md`; a.click();
  };

  const n = samples.data?.samples || [];
  const r = report.data;
  return (
    <>
      <PageHeader title="Đánh giá Tutor AI" sub="Đo xem Tutor có tìm đúng nguồn, trả lời bám tài liệu và biết từ chối câu ngoài phạm vi không." />
      <div className="stat-tiles">
        <div className="tile"><strong>{samples.data?.total ?? '—'}</strong><span>Mẫu trong bộ chuẩn</span></div>
        <div className="tile"><strong>{n.filter((x) => x.split === 'test').length}</strong><span>Mẫu tập test</span></div>
        <div className="tile"><strong>{n.filter((x) => !x.answerable).length}</strong><span>Câu ngoài phạm vi (phải từ chối)</span></div>
      </div>
      {admin ? (
        <div className="card row" style={{ marginBottom: 18 }}>
          <Button variant="ghost" onClick={loadDefault}>Nạp bộ mẫu mặc định</Button>
          <input ref={fileRef} type="file" accept=".json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); }} />
          <Button variant="ghost" icon="upload" onClick={() => fileRef.current?.click()}>Nạp file JSON</Button>
          <span style={{ flex: 1 }} />
          <select className="input" style={{ width: 'auto' }} value={split} onChange={(e) => setSplit(e.target.value)} aria-label="Tập dữ liệu">
            <option value="test">Tập test</option><option value="dev">Tập dev</option><option value="all">Tất cả</option>
          </select>
          <label className="check"><input type="checkbox" checked={judge} onChange={(e) => setJudge(e.target.checked)} />Chấm độ bám nguồn bằng LLM</label>
          <Button icon="play" loading={!!job} disabled={!samples.data?.total} onClick={run}>Chạy đánh giá</Button>
        </div>
      ) : <p className="muted small" style={{ marginBottom: 16, fontWeight: 700 }}>Chỉ quản trị viên được chạy đánh giá.</p>}
      {job && <p style={{ fontWeight: 800, marginBottom: 12 }} aria-live="polite">{job}</p>}

      <div className="split">
        <div className="main">
          {report.loading && !r && <Spinner />}
          {report.error && <ErrorBox message={report.error} />}
          {!report.loading && !r && <Empty title="Chưa có lần đánh giá nào" />}
          {r && (
            <>
              <div className="stat-tiles">
                <div className="tile"><strong>{pct(r.hit_at_k)}</strong><span>Hit@{r.metrics?.config?.top_k ?? 5} (tìm đúng nguồn)</span></div>
                <div className="tile"><strong>{pct(r.groundedness_score)}</strong><span>Bám nguồn</span></div>
                <div className="tile"><strong>{pct(r.metrics?.correct_refusal_rate)}</strong><span>Từ chối đúng</span></div>
                <div className="tile"><strong>{r.avg_latency_ms != null ? `${Math.round(r.avg_latency_ms)} ms` : '—'}</strong><span>Độ trễ TB</span></div>
              </div>
              <div className="card">
                <div className="card-title"><h2>Báo cáo</h2>{r.report_markdown && <Button size="sm" variant="ghost" onClick={download}>Tải .md</Button>}</div>
                {r.report_markdown ? <Markdown className="report" source={r.report_markdown} /> : <p className="muted">Không có báo cáo.</p>}
              </div>
            </>
          )}
        </div>
        <div className="side">
          <div className="card col" style={{ gap: 8 }}>
            <h2 style={{ fontSize: 17 }}>Các lần chạy</h2>
            {runs.data?.map((x) => (
              <button key={x.evaluation_id} className="chip" style={(sel || runs.data?.[0]?.evaluation_id) === x.evaluation_id ? { borderColor: 'var(--blue-line)' } : undefined} onClick={() => setSel(x.evaluation_id)}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span>{new Date(x.created_at).toLocaleString('vi-VN')}</span>
                  <Badge tone="blue">{x.split}</Badge>
                </div>
                <span className="muted small">Hit {pct(x.hit_at_k)} · bám nguồn {pct(x.groundedness_score)} · {x.total_samples} mẫu{x.error_count ? ` · ${x.error_count} lỗi` : ''}</span>
              </button>
            ))}
            {runs.data && !runs.data.length && <span className="muted small">Chưa có.</span>}
          </div>
        </div>
      </div>
    </>
  );
}
