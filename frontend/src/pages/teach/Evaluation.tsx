import { useRef, useState } from 'react';
import { PageHeader } from '../../components/AppShell';
import { Markdown } from '../../components/Markdown';
import { Button, Empty, ErrorBox, Spinner, useToast } from '../../components/ui';
import { api, errorText, pollJob } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAsync } from '../../lib/hooks';
import { KpiRow, PillSelect, StatusTag } from '../../components/Manage';

/** Biểu đồ đường nhỏ theo các lần chạy (cũ → mới), giá trị 0–1. */
function RunChart({ runs }: { runs: Run[] }) {
  const pts = [...runs].reverse().slice(-12);
  if (pts.length < 2) return <p className="muted small">Cần ít nhất 2 lần chạy để vẽ xu hướng.</p>;
  const W = 640, H = 200, P = 28;
  const x = (i: number) => P + (i * (W - 2 * P)) / (pts.length - 1);
  const y = (v: number) => H - P - v * (H - 2 * P);
  const series = [
    { key: 'hit', label: 'Tìm đúng nguồn', cls: 'ln-brand', get: (r: Run) => r.metrics?.hit_at_k ?? r.hit_at_k },
    { key: 'gr', label: 'Bám nguồn', cls: 'ln-ink', get: (r: Run) => r.metrics?.groundedness ?? r.groundedness_score },
    { key: 'ref', label: 'Từ chối đúng', cls: 'ln-mid', get: (r: Run) => r.metrics?.correct_refusal_rate },
  ];
  return (
    <div className="run-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Xu hướng chỉ số qua các lần chạy">
        {[0, .25, .5, .75, 1].map((g) => <g key={g}><line x1={P} x2={W - P} y1={y(g)} y2={y(g)} className="grid" /><text x={2} y={y(g) + 4} className="axis">{g * 100}%</text></g>)}
        {series.map((sr) => {
          const vals = pts.map((r, i) => [i, sr.get(r)] as const).filter(([, v]) => v != null) as [number, number][];
          if (!vals.length) return null;
          return <g key={sr.key} className={sr.cls}>
            <polyline points={vals.map(([i, v]) => `${x(i)},${y(v)}`).join(' ')} fill="none" />
            {vals.map(([i, v]) => <circle key={i} cx={x(i)} cy={y(v)} r={4}><title>{`${sr.label}: ${pct(v)}`}</title></circle>)}
          </g>;
        })}
      </svg>
      <div className="run-legend">{series.map((sr) => <span key={sr.key}><i className={sr.cls} />{sr.label}</span>)}</div>
    </div>
  );
}

interface Run { evaluation_id: string; test_suite_name: string; split: string; total_samples: number; error_count: number; hit_at_k: number | null; groundedness_score: number | null; avg_latency_ms: number | null; metrics: Record<string, any>; config?: { mode?: string } | null; created_at: string }
interface RunFull extends Run { report_markdown: string | null }

const MODE_LABEL: Record<string, string> = { rag: 'RAG đầy đủ', no_filter: 'RAG không lọc bài', no_rag: 'Baseline: không RAG' };

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
  const [mode, setMode] = useState('rag');
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
      const j = await api<{ job_id: string }>('/ai/evaluation/run', { json: { split, use_judge: judge, mode } });
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
  const curId = sel || runs.data?.[0]?.evaluation_id;
  return (
    <>
      <PageHeader title="Đánh giá Tutor AI" sub={`Đo xem Tutor có tìm đúng nguồn, trả lời bám tài liệu và biết từ chối câu ngoài phạm vi không. Bộ chuẩn: ${samples.data?.total ?? '—'} mẫu, ${n.filter((x) => x.split === 'test').length} mẫu test, ${n.filter((x) => !x.answerable).length} câu phải từ chối.`}
        actions={r?.report_markdown ? <Button variant="ghost" icon="doc" onClick={download}>Tải báo cáo .md</Button> : undefined} />
      {admin ? (
        <div className="m-toolbar eval-run">
          <Button size="sm" variant="ghost" onClick={loadDefault}>Nạp bộ mẫu mặc định</Button>
          <input ref={fileRef} type="file" accept=".json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); }} />
          <Button size="sm" variant="ghost" icon="upload" onClick={() => fileRef.current?.click()}>Nạp file JSON</Button>
          <span className="grow" />
          <PillSelect label="Tập dữ liệu" value={split} onChange={setSplit}><option value="test">Tập test</option><option value="dev">Tập dev</option><option value="all">Tất cả</option></PillSelect>
          <PillSelect label="Chế độ" value={mode} onChange={setMode}>{Object.entries(MODE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</PillSelect>
          <label className="check"><input type="checkbox" checked={judge} onChange={(e) => setJudge(e.target.checked)} />Chấm bám nguồn bằng LLM</label>
          <Button icon="play" loading={!!job} disabled={!samples.data?.total} onClick={run}>Chạy đánh giá</Button>
        </div>
      ) : <p className="muted small" style={{ marginBottom: 16 }}>Chỉ quản trị viên được chạy đánh giá.</p>}
      {job && <div className="notice" style={{ marginBottom: 12 }} aria-live="polite">{job}</div>}
      {report.loading && !r && <Spinner />}
      {report.error && <ErrorBox message={report.error} />}
      {!report.loading && !r && <Empty title="Chưa có lần đánh giá nào">Nạp bộ mẫu rồi bấm “Chạy đánh giá”. Kết quả và báo cáo sẽ hiện ở đây.</Empty>}
      {r && <KpiRow items={[
        { label: `Tìm đúng nguồn (Hit@${r.metrics?.config?.top_k ?? 5})`, value: pct(r.metrics?.hit_at_k ?? null), brand: true },
        { label: 'Bám nguồn', value: pct(r.metrics?.groundedness ?? null) },
        { label: 'Từ chối đúng', value: pct(r.metrics?.correct_refusal_rate) },
        { label: 'Thời gian trả lời TB', value: r.avg_latency_ms != null ? `${(r.avg_latency_ms / 1000).toFixed(1)} s` : '—', hint: `${r.total_samples} mẫu${r.error_count ? ` · ${r.error_count} lỗi` : ''}` },
      ]} />}
      <div className="split eval-split">
        <div className="main">
          {!!runs.data?.length && <section className="card col"><h2>Xu hướng qua các lần chạy</h2><RunChart runs={runs.data} /></section>}
          {r && (
            <section className="card">
              <div className="card-title"><h2>Báo cáo lần chạy {new Date(r.created_at).toLocaleDateString('vi-VN')}</h2></div>
              {r.report_markdown ? <Markdown className="report" source={r.report_markdown} /> : <p className="muted">Không có báo cáo.</p>}
            </section>
          )}
        </div>
        <div className="side">
          <section className="card col" style={{ gap: 4 }}>
            <h2 style={{ fontSize: 17, marginBottom: 6 }}>Các lần chạy</h2>
            {runs.data?.map((x) => (
              <button key={x.evaluation_id} className={`run-row ${curId === x.evaluation_id ? 'on' : ''}`} onClick={() => setSel(x.evaluation_id)}>
                <span className="row" style={{ justifyContent: 'space-between', gap: 6 }}>
                  <strong>{new Date(x.created_at).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</strong>
                  <span className="row" style={{ gap: 4 }}>
                    {x.config?.mode && x.config.mode !== 'rag' && <StatusTag tone="ai">{MODE_LABEL[x.config.mode] ?? x.config.mode}</StatusTag>}
                    <StatusTag tone="muted">{x.split}</StatusTag>
                  </span>
                </span>
                <span className="td-sub">Hit {pct(x.metrics?.hit_at_k ?? null)} · bám nguồn {pct(x.metrics?.groundedness ?? null)} · {x.total_samples} mẫu{x.error_count ? ` · ${x.error_count} lỗi` : ''}</span>
              </button>
            ))}
            {runs.data && !runs.data.length && <span className="muted small">Chưa có.</span>}
          </section>
        </div>
      </div>
    </>
  );
}
