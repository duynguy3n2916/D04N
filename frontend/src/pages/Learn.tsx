import { Fragment, useMemo } from 'react';
import { AppShell } from '../components/AppShell';
import { Bolt, Flame, Gem, Icon, type IconName } from '../components/Icon';
import { Mascot } from '../components/Mascot';
import { Badge, Empty, ErrorBox, Progress, Spinner } from '../components/ui';
import { api, type CourseSummary, type CourseTree, type ItemSummary, type Stats } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync } from '../lib/hooks';
import { Link, navigate } from '../lib/router';

export const TYPE_ICON: Record<string, IconName> = { video: 'play', slide: 'slide', reading: 'book', quiz: 'star' };
export const TYPE_LABEL: Record<string, string> = { video: 'Video', slide: 'Slide', reading: 'Bài đọc', quiz: 'Kiểm tra' };
const OFFSETS = [0, -90, -130, -70, 30, 90, 50, -20];

export function StatsAside({ stats, compact }: { stats: Stats | null; compact?: boolean }) {
  const { data: board } = useAsync((s) => api<{ scope: string; rows: { rank: number; name: string; xp: number; me: boolean }[] }>('/ai/learn/leaderboard', { signal: s }), []);
  return (
    <>
      <div className="stat-row">
        <span className="stat" title="Chuỗi ngày học"><Flame size={30} dim={!stats?.studied_today} />{stats?.streak_days ?? 0} ngày</span>
        <span className="stat" title="Tổng điểm kinh nghiệm"><Gem size={26} />{stats?.total_xp ?? 0} XP</span>
      </div>
      <section className="card col">
        <div className="card-title" style={{ marginBottom: 0 }}><h2>Mục tiêu hôm nay</h2><Link to="/profile" style={{ fontWeight: 800, fontSize: 14, textTransform: 'uppercase', textDecoration: 'none' }}>Sửa</Link></div>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <Bolt size={40} />
          <div className="col grow" style={{ gap: 6 }}>
            <strong>Học {stats?.daily_goal_xp ?? 50} XP</strong>
            <Progress value={(stats?.today_xp ?? 0) / (stats?.daily_goal_xp || 50)} tone="yellow" height={16} label="Mục tiêu hôm nay" />
            <span className="muted small">{stats?.today_xp ?? 0} / {stats?.daily_goal_xp ?? 50} XP</span>
          </div>
        </div>
      </section>
      {!compact && (
        <section className="card col">
          <h2>Bảng xếp hạng tuần</h2>
          <span className="muted small" style={{ marginTop: -8 }}>{board?.scope}</span>
          {board?.rows?.length ? board.rows.map((r) => (
            <div key={r.rank} className={`leader ${r.me ? 'leader-me' : ''}`}>
              <span style={{ width: 22, color: 'var(--muted)' }}>{r.rank}</span>
              <span className="avatar" aria-hidden="true" style={{ background: ['#CE5DAE', '#1683C9', '#E8590C', '#34A30F', '#6B3FA0'][r.rank % 5] }}>{r.name.slice(0, 1).toUpperCase()}</span>
              <span className="grow">{r.me ? `${r.name} (bạn)` : r.name}</span>
              <span className="muted">{r.xp} XP</span>
            </div>
          )) : <p className="muted small">Chưa ai có XP tuần này. Học một mục để mở màn nhé!</p>}
        </section>
      )}
    </>
  );
}

function Node({ item, offset, isCurrent }: { item: ItemSummary; offset: number; isCurrent: boolean }) {
  const locked = item.status === 'locked';
  const done = item.status === 'done';
  const cls = locked ? 'node-locked' : done ? 'node-done' : isCurrent ? 'node-current' : `node-${item.type}`;
  const icon: IconName = locked ? 'lock' : done ? 'check' : TYPE_ICON[item.type];
  const href = `/lesson/${item.lesson_id}/${item.item_id}`;
  const node = locked ? (
    <span className={`node ${cls}`} role="img" aria-label={`${item.title} — chưa mở khóa`}><Icon name={icon} size={30} stroke={2.6} /></span>
  ) : (
    <a className={`node ${cls}`} href={'#' + href} aria-label={`${TYPE_LABEL[item.type]}: ${item.title}${done ? ' — đã xong' : ''}`}>
      <Icon name={icon} size={done ? 34 : 32} stroke={3.2} />
    </a>
  );
  return (
    <div className="node-wrap" style={{ marginLeft: offset }}>
      {isCurrent && <span className="node-start">BẮT ĐẦU</span>}
      {isCurrent ? <div className="node-ring">{node}</div> : node}
      <span className="node-label">{item.title}</span>
    </div>
  );
}

function CoursePath({ tree }: { tree: CourseTree }) {
  let idx = 0;
  const currentLesson = tree.chapters.flatMap((c) => c.lessons).find((l) => l.items.some((i) => i.item_id === tree.current_item_id));
  return (
    <div className="path-wrap">
      {tree.chapters.map((ch) => {
        const lessonInChapter = ch.lessons.find((l) => l.lesson_id === currentLesson?.lesson_id) || ch.lessons[0];
        return (
          <Fragment key={ch.chapter_id}>
            <section className="course-banner">
              <div>
                <small>{ch.title}</small>
                <strong>{lessonInChapter?.title || 'Chưa có bài học'}</strong>
              </div>
              {lessonInChapter && lessonInChapter.items[0] && (
                <a className="btn btn-md btn-green" href={`#/lesson/${lessonInChapter.lesson_id}`}>Mở bài</a>
              )}
            </section>
            <div className="path">
              {ch.lessons.map((ls, li) => (
                <Fragment key={ls.lesson_id}>
                  {li > 0 && <div className="lesson-sep">{ls.title}</div>}
                  {ls.items.map((it) => <Node key={it.item_id} item={it} offset={OFFSETS[idx++ % OFFSETS.length]} isCurrent={it.item_id === tree.current_item_id} />)}
                  {!ls.items.length && <p className="muted small">Bài này chưa có nội dung.</p>}
                </Fragment>
              ))}
              {tree.current_item_id && ch.lessons.some((l) => l.items.some((i) => i.item_id === tree.current_item_id)) && (
                <div className="path-mascot">
                  <div className="speech">Mình học tiếp nhé! Có gì khó cứ bấm “Hỏi Tutor AI”.</div>
                  <Mascot size={110} />
                </div>
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

export function Learn({ path, courseId }: { path: string; courseId?: string }) {
  const { user } = useAuth();
  const me = useAsync((s) => api<{ stats: Stats }>('/ai/learn/me', { signal: s }), [path]);
  const courses = useAsync((s) => api<CourseSummary[]>('/ai/learn/courses', { signal: s }), [path]);
  const selected = courseId || courses.data?.[0]?.course_id;
  const tree = useAsync((s) => (selected ? api<CourseTree>(`/ai/learn/courses/${selected}`, { signal: s }) : Promise.resolve(null)), [selected, path]);

  const progress = useMemo(() => tree.data ? tree.data.items_done / Math.max(1, tree.data.items_total) : 0, [tree.data]);

  return (
    <AppShell path={path} aside={<StatsAside stats={me.data?.stats ?? null} />}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18 }}>
        {courses.data && courses.data.length > 1 && (
          <div className="row" style={{ width: '100%', maxWidth: 620 }}>
            {courses.data.map((c) => (
              <button key={c.course_id} className={`pill ${c.course_id === selected ? 'pill-on' : ''}`} onClick={() => navigate(`/learn/${c.course_id}`)}>{c.title}</button>
            ))}
          </div>
        )}
        {tree.data && (
          <div className="row" style={{ width: '100%', maxWidth: 620, justifyContent: 'space-between' }}>
            <div>
              <h1 style={{ fontSize: 26 }}>{tree.data.title}</h1>
              <span className="muted small">{tree.data.items_done}/{tree.data.items_total} mục đã hoàn thành</span>
            </div>
            <div style={{ width: 200 }}><Progress value={progress} label="Tiến độ khóa học" /></div>
          </div>
        )}
        {(courses.loading || tree.loading) && !tree.data && <Spinner />}
        {courses.error && <ErrorBox message={courses.error} onRetry={courses.reload} />}
        {courses.data && !courses.data.length && (
          <Empty title="Chưa có khóa học nào">
            {user?.role === 'student' ? 'Giáo viên chưa mở khóa học cho lớp của bạn.' : <Link to="/teach/courses">Tạo khóa học đầu tiên</Link>}
          </Empty>
        )}
        {tree.data && <CoursePath tree={tree.data} />}
        {tree.data && tree.data.items_total > 0 && tree.data.items_done === tree.data.items_total && (
          <div className="card row" style={{ maxWidth: 620, width: '100%' }}>
            <Mascot size={72} mood="wave" />
            <div className="grow"><h2>Hoàn thành khóa học!</h2><p className="muted">Bạn đã học hết các mục. <Badge tone="green">Tuyệt vời</Badge></p></div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
