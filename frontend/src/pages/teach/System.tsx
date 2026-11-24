import { useState } from 'react';
import { PageHeader } from '../../components/AppShell';
import { Icon, type IconName } from '../../components/Icon';
import { KpiRow, StatusTag } from '../../components/Manage';
import { Button, ErrorBox, Spinner } from '../../components/ui';
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

  const [sec, setSec] = useState<'overview' | 'tasks' | 'calls' | 'jobs'>('overview');
  const SECTIONS: { id: typeof sec; label: string; icon: IconName; n?: number }[] = [
    { id: 'overview', label: 'Tổng quan', icon: 'chart' }, { id: 'tasks', label: 'Theo tác vụ', icon: 'list', n: stats.data?.tasks.length },
    { id: 'calls', label: 'Lượt gọi gần đây', icon: 'history', n: calls.data?.length }, { id: 'jobs', label: 'Job nền', icon: 'refresh', n: jobs.data?.length },
  ];
  const failedCalls = calls.data?.filter((c) => c.status !== 'ok').length || 0;

  return (
    <>
      <PageHeader title="Hệ thống" sub="Sức khỏe dịch vụ, chi phí và độ trễ của các lượt gọi AI (7 ngày gần nhất)."
        actions={<Button variant="ghost" icon="refresh" onClick={reload}>Làm mới</Button>} />
      {health.error && <ErrorBox message={health.error} />}
      <div className="settings-layout">
        <nav className="settings-menu" aria-label="Nhóm thông tin">
          {SECTIONS.map((x) => (
            <button key={x.id} className={`fl-item ${sec === x.id ? 'on' : ''}`} aria-current={sec === x.id ? 'true' : undefined} onClick={() => setSec(x.id)}>
              <Icon name={x.icon} size={18} />{x.label}{x.n != null && <span className="ce-n">{x.n}</span>}
            </button>
          ))}
        </nav>
        <div className="settings-main">
          {sec === 'overview' && <>
            <KpiRow items={[
              { label: 'Trạng thái dịch vụ', value: health.data ? (health.data.status === 'ok' ? 'Ổn định' : 'Có lỗi') : '—', brand: true, hint: `Cơ sở dữ liệu ${health.data?.database ? 'hoạt động' : 'lỗi'}` },
              { label: 'Nhà cung cấp LLM', value: health.data?.llm_provider || '—' },
              { label: 'Lượt gọi LLM', value: totals?.calls ?? '—', hint: `${totals?.failed ?? 0} lỗi` },
              { label: 'Chi phí ước tính', value: totals ? `$${totals.cost.toFixed(3)}` : '—' },
            ]} />
            <section className="card col">
              <div className="card-title"><h2>Cần chú ý</h2></div>
              {failedCalls > 0 ? <p><StatusTag tone="bad">{failedCalls} lượt gọi lỗi</StatusTag> <button className="linkbtn" onClick={() => setSec('calls')}>Xem lượt gọi gần đây</button></p>
                : <p className="muted">Không có lượt gọi lỗi trong danh sách gần đây.</p>}
              {running && <p><StatusTag tone="wait">Có job đang chạy</StatusTag> <button className="linkbtn" onClick={() => setSec('jobs')}>Xem job nền</button></p>}
            </section>
          </>}
          {sec === 'tasks' && <section className="col" style={{ gap: 12 }}>
            {stats.loading && !stats.data && <Spinner />}
            {stats.error && <ErrorBox message={stats.error} />}
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Tác vụ</th><th>Lượt</th><th>Lỗi</th><th>p50</th><th>p95</th><th>Token vào/ra</th><th>Chi phí</th></tr></thead>
                <tbody>
                  {stats.data?.tasks.map((t) => (
                    <tr key={t.task}><td><strong>{t.task}</strong></td><td className="td-num">{t.calls}</td><td>{t.failed ? <StatusTag tone="bad">{t.failed}</StatusTag> : <span className="td-num">0</span>}</td>
                      <td className="td-num">{Math.round(t.latency_ms_p50)} ms</td><td className="td-num">{Math.round(t.latency_ms_p95)} ms</td><td className="td-num">{t.input_tokens.toLocaleString('vi-VN')} / {t.output_tokens.toLocaleString('vi-VN')}</td>
                      <td className="td-num">{t.cost_usd != null ? `$${t.cost_usd.toFixed(4)}` : '—'}</td></tr>
                  ))}
                  {stats.data && !stats.data.tasks.length && <tr><td colSpan={7} className="muted">Chưa có lượt gọi nào.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>}
          {sec === 'calls' && (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Lúc</th><th>Tác vụ</th><th>Model</th><th>Trạng thái</th><th>Độ trễ</th></tr></thead>
                <tbody>
                  {calls.data?.map((c) => (
                    <tr key={c.id} title={c.error || c.prompt}>
                      <td className="td-num">{new Date(c.created_at).toLocaleTimeString('vi-VN')}</td><td><strong>{c.task}</strong>{c.error && <span className="td-sub" style={{ color: 'var(--red-text)' }}>{c.error}</span>}</td>
                      <td><span className="td-sub">{c.model}</span></td><td><StatusTag tone={c.status === 'ok' ? 'ok' : 'bad'}>{c.status}{c.attempt > 1 ? ` · lần ${c.attempt}` : ''}</StatusTag></td>
                      <td className="td-num">{Math.round(c.latency_ms)} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {sec === 'jobs' && (
            <section className="card col" style={{ gap: 4, padding: 8 }}>
              {jobs.data?.map((j) => (
                <div key={j.job_id} className="tree-item">
                  <span className="grow" style={{ minWidth: 0 }}><strong>{j.job_type}</strong><span className="td-sub">{j.error || j.message || ''}{j.progress != null && j.status === 'running' ? ` · ${Math.round(j.progress * 100)}%` : ''}</span></span>
                  <StatusTag tone={j.status === 'succeeded' ? 'ok' : j.status === 'failed' ? 'bad' : 'wait'}>{j.status}</StatusTag>
                </div>
              ))}
              {jobs.data && !jobs.data.length && <span className="muted small" style={{ padding: 12 }}>Chưa có job.</span>}
            </section>
          )}
        </div>
      </div>
    </>
  );
}
