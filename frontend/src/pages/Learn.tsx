import { Fragment, useMemo, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { Icon, type IconName } from '../components/Icon';
import { Badge, Button, CountUp, Empty, ErrorBox, Spinner, useToast } from '../components/ui';
import { api, apiBlob, errorText, mediaUrl, type CourseSummary, type CourseTree, type ItemSummary, type Stats } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useNotifications } from '../lib/notifications';
import { useAsync } from '../lib/hooks';
import { Link, navigate } from '../lib/router';

export const TYPE_ICON: Record<string, IconName> = { video: 'play', slide: 'slide', reading: 'book', quiz: 'star' };
export const TYPE_LABEL: Record<string, string> = { video: 'Video', slide: 'Slide', reading: 'Bài đọc', quiz: 'Kiểm tra' };

/** Lối tắt: diễn đàn lớp và tải báo cáo tiến độ (DOCX) cho học sinh / phụ huynh. */
function StudyTools() {
  const toast = useToast();
  const noti = useNotifications();
  const download = async () => {
    try {
      const { blob, filename } = await apiBlob('/ai/learn/progress-report');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) { toast(errorText(e), 'error'); }
  };
  return (
    <section className="col study-tools" style={{ gap: 10 }}>
      {!!noti?.flashcards.length && (
        <div className="card col" style={{ gap: 4 }}>
          <strong className="small">Thẻ cần ôn hôm nay</strong>
          {noti.flashcards.map((f) => (
            <Link key={f.lesson_code} to={`/flashcards/${encodeURIComponent(f.lesson_code)}`} className="small" style={{ fontWeight: 700 }}>{f.lesson_title} · {f.due} thẻ</Link>
          ))}
        </div>
      )}
      <div className="study-tools-row">
        <Button variant="ghost" icon="note" onClick={() => navigate('/forum')}>Diễn đàn{noti?.forum_new ? ` (${noti.forum_new})` : ''}</Button>
        <Button variant="ghost" icon="doc" onClick={download}>Báo cáo</Button>
      </div>
    </section>
  );
}

/** Nhắc học trong giao diện: sắp mất chuỗi ngày học hoặc chưa đạt mục tiêu hôm nay (chưa gửi email). */
function StudyReminder({ stats }: { stats: Stats }) {
  const left = Math.max(0, stats.daily_goal_xp - stats.today_xp);
  if (left === 0) return null;
  let text: string;
  if (!stats.studied_today && stats.streak_days > 0) text = `Chuỗi ${stats.streak_days} ngày sẽ mất nếu hôm nay bạn chưa học. Hoàn thành một mục để giữ chuỗi.`;
  else if (!stats.studied_today) text = 'Hôm nay bạn chưa học. Hoàn thành một mục để bắt đầu chuỗi ngày mới.';
  else text = `Còn ${left} XP nữa để đạt mục tiêu hôm nay.`;
  return <div className="notice" role="status" style={{ fontWeight: 700 }}>{text}</div>;
}

/** Vòng tròn tiến độ (SVG), màu theo màu chủ đạo. */
function Ring({ value, size = 64, stroke = 7, label }: { value: number; size?: number; stroke?: number; label?: string }) {
  const v = Math.max(0, Math.min(1, value || 0));
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  return (
    <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label ?? `${Math.round(v * 100)}%`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} style={{ stroke: 'var(--brand-soft)' }} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${c * v} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ stroke: 'var(--brand)', transition: 'stroke-dasharray .5s ease' }} />
      <text x="50%" y="52%" textAnchor="middle" dominantBaseline="middle" style={{ fill: 'var(--ink)', fontWeight: 800, fontSize: size / 4.2 }}>{Math.round(v * 100)}%</text>
    </svg>
  );
}

export function StatsAside({ stats, compact }: { stats: Stats | null; compact?: boolean }) {
  const { data: board } = useAsync((s) => api<{ scope: string; rows: { rank: number; name: string; xp: number; me: boolean }[] }>('/ai/learn/leaderboard', { signal: s }), []);
  const goal = stats?.daily_goal_xp || 50;
  const today = stats?.today_xp ?? 0;
  return (
    <>
      <div className="kpi-pair">
        <div className="kpi kpi-brand" title="Chuỗi ngày học">
          <span className="kpi-label"><Icon name="star" size={16} /> Chuỗi</span>
          <strong><CountUp value={stats?.streak_days ?? 0} /> ngày</strong>
        </div>
        <div className="kpi" title="Tổng điểm kinh nghiệm">
          <span className="kpi-label"><Icon name="sparkle" size={16} /> Tổng XP</span>
          <strong><CountUp value={stats?.total_xp ?? 0} /></strong>
        </div>
      </div>
      <section className="card goal-card">
        <Ring value={today / goal} size={76} stroke={9} label={`Mục tiêu hôm nay: ${today}/${goal} XP`} />
        <div className="col grow" style={{ gap: 2 }}>
          <h2>Mục tiêu hôm nay</h2>
          <span className="muted">{today} / {goal} XP{today < goal ? ` · còn ${goal - today} XP` : ' · đã đạt'}</span>
          <Link to="/profile" className="goal-edit">Sửa mục tiêu</Link>
        </div>
      </section>
      {stats && <StudyReminder stats={stats} />}
      {!compact && (
        <section className="card col" style={{ gap: 4 }}>
          <h2 style={{ marginBottom: 6 }}>Bảng xếp hạng tuần</h2>
          {board?.rows?.length ? board.rows.map((r) => (
            <div key={r.rank} className={`leader ${r.me ? 'leader-me' : ''}`}>
              <span style={{ width: 18, color: 'var(--muted)' }}>{r.rank}</span>
              <span className="avatar" aria-hidden="true" style={r.me ? undefined : { background: 'var(--ink)' }}>{r.name.slice(0, 1).toUpperCase()}</span>
              <span className="grow">{r.me ? `${r.name} (bạn)` : r.name}</span>
              <span className="muted">{r.xp} XP</span>
            </div>
          )) : <p className="muted small">Chưa ai có XP tuần này. Học một mục để mở màn nhé!</p>}
        </section>
      )}
      <StudyTools />
    </>
  );
}

const isDone = (it: ItemSummary) => it.completed || it.status === 'done' || it.status === 'completed';
type Filter = 'all' | 'current' | 'todo';

function ItemRow({ item, isCurrent }: { item: ItemSummary; isCurrent: boolean }) {
  const locked = item.status === 'locked';
  const done = isDone(item);
  const icon: IconName = locked ? 'lock' : done ? 'check' : TYPE_ICON[item.type];
  const state = locked ? 'locked' : done ? 'done' : isCurrent ? 'current' : 'open';
  const label = locked ? 'Khóa' : done ? 'Đã xong' : isCurrent ? 'Đang học' : 'Chưa học';
  const inner = (
    <>
      <span className={`oi-ico oi-${state}`}><Icon name={icon} size={18} /></span>
      <span className="oi-title">{item.title}</span>
      <span className="oi-meta">{TYPE_LABEL[item.type]}{item.meta_text ? ` · ${item.meta_text}` : ''}</span>
      <span className={`oi-chip oi-chip-${state}`}>{label}</span>
    </>
  );
  return locked
    ? <div className={`oi oi-row-${state}`} aria-disabled="true">{inner}</div>
    : <a className={`oi oi-row-${state}`} href={`#/lesson/${item.lesson_id}/${item.item_id}`} aria-current={isCurrent ? 'step' : undefined}>{inner}</a>;
}

function CourseOutline({ tree, filter }: { tree: CourseTree; filter: Filter }) {
  const lessons = tree.chapters.flatMap((c) => c.lessons);
  const currentLesson = lessons.find((l) => l.items.some((i) => i.item_id === tree.current_item_id));
  const [open, setOpen] = useState<Set<string>>(() => new Set(currentLesson ? [currentLesson.lesson_id] : lessons[0] ? [lessons[0].lesson_id] : []));
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <div className="col" style={{ gap: 16 }}>
      {tree.chapters.map((ch, ci) => {
        const visible = ch.lessons.filter((ls) => filter === 'all' ? true
          : filter === 'current' ? ls.lesson_id === currentLesson?.lesson_id
          : ls.items_done < ls.items_total);
        if (!visible.length) return null;
        const chDone = ch.lessons.reduce((a, l) => a + l.items_done, 0);
        const chTotal = ch.lessons.reduce((a, l) => a + l.items_total, 0);
        return (
          <section key={ch.chapter_id} className="card outline-card">
            <header className="oc-head">
              <div><span className="oc-kicker">Chương {ci + 1}</span><h2>{ch.title}</h2></div>
              <span className="muted">{chDone}/{chTotal} mục</span>
            </header>
            {visible.map((ls) => {
              const isOpen = open.has(ls.lesson_id) || filter === 'current';
              const p = ls.items_done / Math.max(1, ls.items_total);
              const locked = ls.items.length > 0 && ls.items.every((i) => i.status === 'locked');
              return (
                <Fragment key={ls.lesson_id}>
                  <button type="button" className={`ol ${isOpen ? 'ol-open' : ''}`} aria-expanded={isOpen} onClick={() => toggle(ls.lesson_id)}>
                    <span className="ol-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                    <span className="ol-title">{ls.title}</span>
                    <span className="ol-bar" aria-hidden="true"><i style={{ width: `${p * 100}%` }} /></span>
                    <span className="ol-count">{ls.items_done}/{ls.items_total}</span>
                    {locked ? <span className="oi-chip oi-chip-locked"><Icon name="lock" size={13} /></span> : <span className="ol-spacer" />}
                  </button>
                  {isOpen && (ls.items.length
                    ? <div className="ol-items">{ls.items.map((it) => <ItemRow key={it.item_id} item={it} isCurrent={it.item_id === tree.current_item_id} />)}</div>
                    : <p className="muted small ol-empty">Bài này chưa có nội dung.</p>)}
                </Fragment>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

type CourseFilter = 'all' | 'doing' | 'new' | 'done';
const courseState = (c: CourseSummary): Exclude<CourseFilter, 'all'> =>
  c.items_total > 0 && c.items_done >= c.items_total ? 'done' : c.items_done > 0 ? 'doing' : 'new';
const STATE_LABEL: Record<Exclude<CourseFilter, 'all'>, string> = { doing: 'Đang học', new: 'Chưa bắt đầu', done: 'Đã xong' };

/** Ảnh bìa khóa học; chưa có ảnh thì hiện nền màu chủ đạo kèm mã khóa học. */
export function CourseCoverArt({ course, className = '' }: { course: Pick<CourseSummary, 'cover_url' | 'title' | 'code'>; className?: string }) {
  return (
    <span className={`lc-cover ${course.cover_url ? '' : 'lc-cover-blank'} ${className}`}>
      {course.cover_url
        ? <img src={mediaUrl(course.cover_url)} alt="" loading="lazy" />
        : <span className="lc-cover-text" aria-hidden="true"><Icon name="book" size={30} /><b>{course.title}</b></span>}
    </span>
  );
}

function CourseCard({ c }: { c: CourseSummary }) {
  const st = courseState(c);
  const p = c.items_done / Math.max(1, c.items_total);
  return (
    <Link to={`/learn/${c.course_id}`} className="lc-card">
      <CourseCoverArt course={c} />
      <span className={`lc-state lc-state-${st}`}>{STATE_LABEL[st]}</span>
      <div className="lc-body">
        <h3>{c.title}</h3>
        {c.description && <p className="lc-desc">{c.description}</p>}
        <div className="lc-progress">
          <span className="lc-bar" aria-hidden="true"><i style={{ width: `${p * 100}%` }} /></span>
          <span className="muted small">{c.items_done}/{c.items_total} mục</span>
        </div>
        <span className="lc-cta">{st === 'done' ? 'Ôn lại' : st === 'doing' ? 'Học tiếp' : 'Bắt đầu học'} <Icon name="chevronRight" size={16} /></span>
      </div>
    </Link>
  );
}

/** Trang Học khi chưa chọn khóa: danh mục khóa học dạng thẻ có ảnh bìa, khóa đang học nổi bật ở đầu. */
function CourseCatalog({ courses }: { courses: CourseSummary[] }) {
  const { user } = useAuth();
  const [filter, setFilter] = useState<CourseFilter>('all');
  const resume = courses.find((c) => courseState(c) === 'doing');
  const shown = courses.filter((c) => filter === 'all' || courseState(c) === filter);
  const count = (f: CourseFilter) => f === 'all' ? courses.length : courses.filter((c) => courseState(c) === f).length;
  const name = (user?.display_name || user?.name || '').trim().split(/\s+/).pop();
  return (
    <>
      <header className="learn-head">
        <div className="grow">
          <span className="oc-kicker" style={{ color: 'var(--brand)' }}>Học</span>
          <h1>{name ? `Chào ${name}, học gì hôm nay?` : 'Khóa học của bạn'}</h1>
        </div>
      </header>
      {resume && (
        <Link to={`/learn/${resume.course_id}`} className="lc-resume card">
          <CourseCoverArt course={resume} className="lc-resume-cover" />
          <div className="lc-resume-body">
            <span className="oc-kicker">Đang học dở</span>
            <h2>{resume.title}</h2>
            <div className="lc-progress">
              <span className="lc-bar" aria-hidden="true"><i style={{ width: `${(resume.items_done / Math.max(1, resume.items_total)) * 100}%` }} /></span>
              <span className="muted small">{resume.items_done}/{resume.items_total} mục · {Math.round((resume.items_done / Math.max(1, resume.items_total)) * 100)}%</span>
            </div>
          </div>
          <span className="btn btn-md btn-green"><Icon name="play" size={16} /> Học tiếp</span>
        </Link>
      )}
      <div className="learn-toolbar">
        <div className="row" role="group" aria-label="Lọc khóa học">
          {([['all', 'Tất cả'], ['doing', 'Đang học'], ['new', 'Chưa bắt đầu'], ['done', 'Đã xong']] as [CourseFilter, string][]).map(([k, l]) => (
            <button key={k} type="button" className={`pill ${filter === k ? 'pill-on' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {l} <span className="lc-count">{count(k)}</span>
            </button>
          ))}
        </div>
      </div>
      {shown.length
        ? <div className="lc-grid">{shown.map((c) => <CourseCard key={c.course_id} c={c} />)}</div>
        : <p className="muted">Không có khóa học nào ở mục này.</p>}
    </>
  );
}

export function Learn({ path, courseId }: { path: string; courseId?: string }) {
  const { user } = useAuth();
  const me = useAsync((s) => api<{ stats: Stats }>('/ai/learn/me', { signal: s }), [path]);
  const courses = useAsync((s) => api<CourseSummary[]>('/ai/learn/courses', { signal: s }), [path]);
  const selected = courseId;
  const tree = useAsync((s) => (selected ? api<CourseTree>(`/ai/learn/courses/${selected}`, { signal: s }) : Promise.resolve(null)), [selected, path]);
  const [filter, setFilter] = useState<Filter>('all');

  const progress = useMemo(() => tree.data ? tree.data.items_done / Math.max(1, tree.data.items_total) : 0, [tree.data]);
  const current = useMemo(() => tree.data?.chapters.flatMap((c) => c.lessons.flatMap((l) => l.items)).find((i) => i.item_id === tree.data?.current_item_id), [tree.data]);

  return (
    <AppShell path={path} aside={<StatsAside stats={me.data?.stats ?? null} />}>
      <div className="learn-page">
        {!selected && courses.data && courses.data.length > 0 && <CourseCatalog courses={courses.data} />}
        {selected && (
          <Link to="/learn" className="lc-back"><Icon name="chevronLeft" size={16} /> Tất cả khóa học</Link>
        )}
        {tree.data && (
          <header className="learn-head lc-detail-head">
            <CourseCoverArt course={tree.data} className="lc-detail-cover" />
            <div className="grow">
              <span className="oc-kicker" style={{ color: 'var(--brand)' }}>Khóa học</span>
              <h1>{tree.data.title}</h1>
              {tree.data.description && <p className="muted lc-detail-desc">{tree.data.description}</p>}
            </div>
            <div className="learn-head-stat">
              <div><strong>{tree.data.items_done}/{tree.data.items_total}</strong><span className="muted small">mục đã xong</span></div>
              <Ring value={progress} label="Tiến độ khóa học" />
            </div>
          </header>
        )}
        {tree.data && (
          <div className="learn-toolbar">
            <div className="row" role="group" aria-label="Lọc bài học">
              {([['all', 'Tất cả'], ['current', 'Đang học'], ['todo', 'Chưa xong']] as [Filter, string][]).map(([k, l]) => (
                <button key={k} type="button" className={`pill ${filter === k ? 'pill-on' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>
              ))}
            </div>
            {current && (
              <a className="btn btn-md btn-green" href={`#/lesson/${current.lesson_id}/${current.item_id}`}>
                <Icon name="play" size={16} /> Học tiếp: {current.title}
              </a>
            )}
          </div>
        )}
        {(courses.loading || tree.loading) && !tree.data && <Spinner />}
        {courses.error && <ErrorBox message={courses.error} onRetry={courses.reload} />}
        {tree.error && <ErrorBox message={tree.error} onRetry={tree.reload} />}
        {courses.data && !courses.data.length && (
          <Empty title="Chưa có khóa học nào">
            {user?.role === 'student' ? 'Giáo viên chưa mở khóa học cho lớp của bạn.' : <Link to="/teach/courses">Tạo khóa học đầu tiên</Link>}
          </Empty>
        )}
        {tree.data && tree.data.items_total > 0 && tree.data.items_done === tree.data.items_total && (
          <div className="card row">
            <span className="oi-ico oi-done" style={{ width: 44, height: 44 }}><Icon name="trophy" size={22} /></span>
            <div className="grow"><h2>Hoàn thành khóa học!</h2><p className="muted">Bạn đã học hết các mục. <Badge tone="green">Tuyệt vời</Badge></p></div>
          </div>
        )}
        {tree.data && <CourseOutline key={tree.data.course_id} tree={tree.data} filter={filter} />}
      </div>
    </AppShell>
  );
}
