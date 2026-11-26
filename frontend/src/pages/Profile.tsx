import { useState } from 'react';
import { PageHeader } from '../components/AppShell';
import { Link } from '../lib/router';
import { Button, ErrorBox, Spinner, useToast } from '../components/ui';
import { api, errorText, type Stats } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync } from '../lib/hooks';
import { navigate } from '../lib/router';
import { AccountSection } from './Account';
import { Icon } from '../components/Icon';
import { ReportButton } from './Learn';
import { savedTheme, setTheme, THEME_PRESETS } from '../lib/theme';

const GOALS = [{ v: 10, t: 'Nhẹ nhàng' }, { v: 20, t: 'Vừa phải' }, { v: 30, t: 'Nghiêm túc' }, { v: 50, t: 'Chăm chỉ' }, { v: 100, t: 'Thử thách' }];
const DOW = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

/** Biểu đồ nhiệt 12 tuần kiểu GitHub: mỗi ô là một ngày, màu đậm dần theo XP. */
function Heatmap({ days, goal }: { days: { date: string; xp: number }[]; goal: number }) {
  if (!days.length) return null;
  // Lùi về Thứ Hai để mỗi cột là một tuần.
  const first = new Date(days[0].date + 'T00:00:00');
  const pad = (first.getDay() + 6) % 7;
  const cells: ({ date: string; xp: number } | null)[] = [...Array(pad).fill(null), ...days];
  const weeks: typeof cells[] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const level = (xp: number) => (xp <= 0 ? 0 : xp < goal * 0.5 ? 1 : xp < goal ? 2 : xp < goal * 2 ? 3 : 4);
  const active = days.filter((d) => d.xp > 0).length;
  return (
    <div className="heat">
      <div className="heat-grid" role="img" aria-label={`Học ${active} trên ${days.length} ngày gần đây`}>
        <div className="heat-dow">{['T2', '', 'T4', '', 'T6', '', ''].map((d, i) => <span key={i}>{d}</span>)}</div>
        {weeks.map((w, i) => (
          <div key={i} className="heat-col">
            {w.map((c, j) => c ? <span key={j} className={`heat-cell heat-${level(c.xp)}`} title={`${c.date}: ${c.xp} XP`} /> : <span key={j} className="heat-cell heat-pad" />)}
          </div>
        ))}
      </div>
      <div className="heat-legend"><span>{active} ngày có học trong 12 tuần</span><span className="grow" />Ít{[0, 1, 2, 3, 4].map((l) => <span key={l} className={`heat-cell heat-${l}`} />)}Nhiều</div>
    </div>
  );
}

export function Profile() {
  const { user } = useAuth();
  const toast = useToast();
  const me = useAsync((s) => api<{ name: string; stats: Stats }>('/ai/learn/me', { signal: s }), [], 'learn/me-profile');
  const [saving, setSaving] = useState<number | null>(null);
  const stats = me.data?.stats;
  const max = Math.max(10, ...(stats?.last_7_days.map((d) => d.xp) || [0]));
  const name = me.data?.name || user?.name || user?.user_id || 'Hồ sơ';

  const setGoal = async (v: number) => {
    setSaving(v);
    try {
      const s = await api<Stats>('/ai/learn/goal', { method: 'PUT', json: { daily_goal_xp: v } });
      me.setData({ ...(me.data as any), stats: s });
      toast(`Mục tiêu mới: ${v} XP mỗi ngày`, 'success');
    } catch (e) { toast(errorText(e), 'error'); } finally { setSaving(null); }
  };

  return (
    <div className="profile-page">
      <header className="profile-hero">
        <span className="profile-avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
        <div className="grow" style={{ minWidth: 0 }}>
          <h1>{name}</h1>
          <p className="muted">@{user?.user_id}{user?.class_ids?.length ? ` · lớp ${user.class_ids.join(', ')}` : ' · chưa vào lớp nào'}</p>
        </div>
        <ReportButton />
        <Button variant="ghost" icon="settings" onClick={() => navigate('/settings')}>Cài đặt tài khoản</Button>
      </header>
      {me.loading && <Spinner />}
      {me.error && <ErrorBox message={me.error} onRetry={me.reload} />}
      {stats && (
        <>
          <div className="kpi-row">
            <div className="kpi kpi-brand"><span className="kpi-label">Chuỗi ngày học</span><strong>{stats.streak_days} ngày</strong></div>
            <div className="kpi"><span className="kpi-label">Tổng XP</span><strong>{stats.total_xp.toLocaleString('vi-VN')}</strong></div>
            <div className="kpi"><span className="kpi-label">XP tuần này</span><strong>{stats.week_xp}</strong></div>
            <div className="kpi"><span className="kpi-label">Hôm nay</span><strong>{stats.today_xp}<small>/{stats.daily_goal_xp} XP</small></strong></div>
          </div>
          <div className="profile-cols">
            {stats.last_84_days && (
              <section className="card col heat-card">
                <h2>12 tuần gần đây</h2>
                <Heatmap days={stats.last_84_days} goal={stats.daily_goal_xp} />
              </section>
            )}
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
          </div>
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
              <p className="muted small">Mỗi ngày học một chút, chuỗi ngày sẽ dài ra.</p>
            </section>
        </>
      )}
      {!stats && !me.loading && <p className="muted">Thông tin tài khoản nằm ở <Link to="/settings">Cài đặt</Link>.</p>}
    </div>
  );
}

/** Trang Cài đặt: thông tin cá nhân, lớp học, mật khẩu, phiên đăng nhập. */
function AppearanceSection() {
  const [color, setColor] = useState(savedTheme);
  const pick = (c: string) => { setColor(c); setTheme(c); };
  const preset = THEME_PRESETS.find((t) => t.color.toLowerCase() === color.toLowerCase());
  return (
    <section className="card col theme-card" style={{ gap: 14 }} aria-label="Giao diện">
      <div className="card-title" style={{ marginBottom: 0 }}><h2>Giao diện</h2><span className="muted small">{preset ? preset.name : 'Màu tự chọn'}</span></div>
      <p className="muted small" style={{ margin: 0 }}>Chọn màu chủ đạo cho nút, menu và điểm nhấn. Lựa chọn được lưu trên trình duyệt này.</p>
      <div className="theme-swatches" role="radiogroup" aria-label="Màu chủ đạo">
        {THEME_PRESETS.map((t) => {
          const on = t.color.toLowerCase() === color.toLowerCase();
          return (
            <button key={t.id} type="button" role="radio" aria-checked={on} className={`theme-swatch ${on ? 'on' : ''}`} onClick={() => pick(t.color)}>
              <span className="theme-dot" style={{ background: t.color }}>{on && <Icon name="check" size={16} />}</span>
              <span>{t.name}</span>
            </button>
          );
        })}
        <label className={`theme-swatch ${preset ? '' : 'on'}`}>
          <span className="theme-dot theme-dot-custom" style={preset ? undefined : { background: color }}>
            <input type="color" value={color} onChange={(e) => pick(e.target.value)} aria-label="Chọn màu khác" />
            {!preset && <Icon name="check" size={16} />}
          </span>
          <span>Màu khác</span>
        </label>
      </div>
    </section>
  );
}

export function Settings() {
  return (
    <div className="settings-page">
      <PageHeader title="Cài đặt" sub="Thông tin cá nhân, lớp học và bảo mật tài khoản."
        actions={<Button variant="ghost" icon="user" onClick={() => navigate('/profile')}>Về hồ sơ</Button>} />
      <div className="settings-body"><AppearanceSection /><AccountSection /></div>
    </div>
  );
}
