import { PageHeader } from '../../components/AppShell';
import { Badge, Button, ErrorBox, Spinner } from '../../components/ui';
import { api, type Job } from '../../lib/api';
import { useAsync, useInterval } from '../../lib/hooks';

interface Health { status: string; database: boolean; llm_provider: string; [k: string]: any }
interface TaskStat { task: string; calls: number; failed: number; latency_ms_p50: number; latency_ms_p95: number; input_tokens: number; output_tokens: number; cost_usd: number | null }
interface Call { id: string; task: string; prompt: string; model: string; status: string; attempt: number; latency_ms: number; input_tokens: number | null; output_tokens: number | null; error: string | null; created_at: string }

/** Quan sát hệ thống (admin): sức khỏe, thống kê gọi LLM, job nền. */
export function System() {
  const health = useAsync((s) => api<Health>('/health', { signal: s }), []);
  const stats = useAsync((s) => api<{ tasks: TaskStat[] }>('/ai/admin/llm-stats', { signal: s }), []);
  const calls = useAsync((s) => api<Call[]>('/ai/admin/llm-calls?limit=30', { signal: s }), []);
  const jobs = useAsync((s) => api<Job[]>('/ai/jobs', { signal: s }), []);
  const running = jobs.data?.some((j) => j.status === 'queued' || j.status === 'running');
  useInterval(() => jobs.reload(), running ? 3000 : null);

  const totals = stats.data?.tasks.reduce((a, t) => ({ calls: a.calls + t.calls, failed: a.failed + t.failed, cost: a.cost + (t.cost_usd || 0) }), { calls: 0, failed: 0, cost: 0 });
  const reload = () => { health.reload(); stats.reload(); calls.reload(); jobs.reload(); };

  return (
    <>
      <PageHeader title="Hệ thống" sub="Sức khỏe dịch vụ, chi phí và độ trễ của các lượt gọi AI (7 ngày gần nhất)."
        actions={<Button variant="ghost" icon="refresh" onClick={reload}>Làm mới</Button>} />
      {health.error && <ErrorBox message={health.error} />}
      <div className="stat-tiles">
        <div className="tile"><strong style={{ color: health.data?.status === 'ok' ? 'var(--green)' : 'var(--red)' }}>{health.data ? (health.data.status === 'ok' ? 'Ổn định' : 'Có lỗi') : '—'}</strong><span>Trạng thái · DB {health.data?.database ? 'OK' : 'lỗi'}</span></div>
        <div className="tile"><strong>{health.data?.llm_provider || '—'}</strong><span>Nhà cung cấp LLM</span></div>
        <div className="tile"><strong>{totals?.calls ?? '—'}</strong><span>Lượt gọi LLM · {totals?.failed ?? 0} lỗi</span></div>
        <div className="tile"><strong>{totals ? `$${totals.cost.toFixed(3)}` : '—'}</strong><span>Chi phí ước tính</span></div>
      </div>

      <section className="card" style={{ marginBottom: 18 }}>
        <div className="card-title"><h2>Theo tác vụ</h2></div>
        {stats.loading && !stats.data && <Spinner />}
        {stats.error && <ErrorBox message={stats.error} />}
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Tác vụ</th><th>Lượt</th><th>Lỗi</th><th>p50</th><th>p95</th><th>Token vào/ra</th><th>Chi phí</th></tr></thead>
            <tbody>
              {stats.data?.tasks.map((t) => (
                <tr key={t.task}><td style={{ fontWeight: 800 }}>{t.task}</td><td>{t.calls}</td><td>{t.failed ? <Badge tone="red">{t.failed}</Badge> : 0}</td>
                  <td>{Math.round(t.latency_ms_p50)} ms</td><td>{Math.round(t.latency_ms_p95)} ms</td><td>{t.input_tokens.toLocaleString('vi-VN')} / {t.output_tokens.toLocaleString('vi-VN')}</td>
                  <td>{t.cost_usd != null ? `$${t.cost_usd.toFixed(4)}` : '—'}</td></tr>
              ))}
              {stats.data && !stats.data.tasks.length && <tr><td colSpan={7} className="muted">Chưa có lượt gọi nào.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <div className="split">
        <section className="card main">
          <div className="card-title"><h2>Lượt gọi gần đây</h2></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Lúc</th><th>Tác vụ</th><th>Model</th><th>Trạng thái</th><th>Độ trễ</th></tr></thead>
              <tbody>
                {calls.data?.map((c) => (
                  <tr key={c.id} title={c.error || c.prompt}>
                    <td className="small">{new Date(c.created_at).toLocaleTimeString('vi-VN')}</td><td style={{ fontWeight: 800 }}>{c.task}</td>
                    <td className="small">{c.model}</td><td><Badge tone={c.status === 'ok' ? 'green' : 'red'}>{c.status}{c.attempt > 1 ? ` · lần ${c.attempt}` : ''}</Badge></td>
                    <td>{Math.round(c.latency_ms)} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card side">
          <div className="card-title"><h2>Job nền</h2>{running && <Badge tone="yellow">đang chạy</Badge>}</div>
          <div className="col" style={{ gap: 10 }}>
            {jobs.data?.map((j) => (
              <div key={j.job_id} className="job">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong>{j.job_type}</strong>
                  <Badge tone={j.status === 'succeeded' ? 'green' : j.status === 'failed' ? 'red' : 'yellow'}>{j.status}</Badge>
                </div>
                <span className="muted small">{j.error || j.message || ''}{j.progress != null && j.status === 'running' ? ` · ${Math.round(j.progress * 100)}%` : ''}</span>
              </div>
            ))}
            {jobs.data && !jobs.data.length && <span className="muted small">Chưa có job.</span>}
          </div>
        </section>
      </div>
    </>
  );
}
