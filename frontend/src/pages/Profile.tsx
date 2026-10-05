import { useState } from 'react';
import { PageHeader } from '../components/AppShell';
import { Flame, Gem } from '../components/Icon';
import { Mascot } from '../components/Mascot';
import { ErrorBox, Spinner, useToast } from '../components/ui';
import { api, errorText, type Stats } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync } from '../lib/hooks';
import { AccountSection } from './Account';

const GOALS = [{ v: 10, t: 'Nhẹ nhàng' }, { v: 20, t: 'Vừa phải' }, { v: 30, t: 'Nghiêm túc' }, { v: 50, t: 'Chăm chỉ' }, { v: 100, t: 'Thử thách' }];
const DOW = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

export function Profile() {
  const { user } = useAuth();
  const toast = useToast();
  const me = useAsync((s) => api<{ name: string; stats: Stats }>('/ai/learn/me', { signal: s }), []);
  const [saving, setSaving] = useState<number | null>(null);
  const stats = me.data?.stats;
  const max = Math.max(10, ...(stats?.last_7_days.map((d) => d.xp) || [0]));

  const setGoal = async (v: number) => {
    setSaving(v);
    try {
      const s = await api<Stats>('/ai/learn/goal', { method: 'PUT', json: { daily_goal_xp: v } });
      me.setData({ ...(me.data as any), stats: s });
      toast(`Mục tiêu mới: ${v} XP mỗi ngày`, 'success');
    } catch (e) { toast(errorText(e), 'error'); } finally { setSaving(null); }
  };

  return (
    <div style={{ maxWidth: 820 }}>
      <PageHeader title={me.data?.name || user?.user_id || 'Hồ sơ'} sub={`@${user?.user_id}${user?.class_ids?.length ? ` · lớp ${user.class_ids.join(', ')}` : ' · chưa vào lớp nào'}`} />
      {me.loading && <Spinner />}
      {me.error && <ErrorBox message={me.error} onRetry={me.reload} />}
      {stats && (
        <div className="col" style={{ gap: 20 }}>
          <div className="stat-tiles">
            <div className="tile"><span className="row" style={{ gap: 6 }}><Flame size={26} dim={!stats.studied_today} /><strong>{stats.streak_days}</strong></span><span>Ngày học liên tiếp</span></div>
            <div className="tile"><span className="row" style={{ gap: 6 }}><Gem size={24} /><strong>{stats.total_xp}</strong></span><span>Tổng XP</span></div>
            <div className="tile"><strong>{stats.week_xp}</strong><span>XP tuần này</span></div>
            <div className="tile"><strong>{stats.today_xp}/{stats.daily_goal_xp}</strong><span>XP hôm nay</span></div>
          </div>
          <section className="card col">
            <h2>7 ngày gần đây</h2>
            <div className="week-bars" role="img" aria-label={`XP 7 ngày gần đây: ${stats.last_7_days.map((d) => d.xp).join(', ')}`}>
              {stats.last_7_days.map((d) => (
                <div key={d.date} className="week-bar">
                  <span>{d.xp || ''}</span>
                  <span className={`bar ${d.xp ? '' : 'zero'}`} style={{ height: `${Math.max(4, (d.xp / max) * 100)}%` }} />
                  <span>{DOW[new Date(d.date + 'T00:00:00').getDay()]}</span>
                </div>
              ))}
            </div>
          </section>
          <section className="card col">
            <h2>Mục tiêu hằng ngày</h2>
            <p className="muted">Trả lời đúng câu hỏi trong video +10 XP, câu hỏi mở rộng của AI +15 XP, hoàn thành một mục +5 XP, qua bài kiểm tra +20 XP.</p>
            <div className="goal-options">
              {GOALS.map((g) => (
                <button key={g.v} className={`pill ${stats.daily_goal_xp === g.v ? 'pill-on' : ''}`} disabled={saving !== null} onClick={() => setGoal(g.v)} aria-pressed={stats.daily_goal_xp === g.v}>
                  {g.t} · {g.v} XP
                </button>
              ))}
            </div>
          </section>
          <div className="row"><Mascot size={80} /><p className="muted">Mỗi ngày học một chút, chuỗi ngày sẽ dài ra. Cố lên!</p></div>
        </div>
      )}
      <div style={{ marginTop: 28 }}><AccountSection /></div>
    </div>
  );
}
