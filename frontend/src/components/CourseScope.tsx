import { useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Icon } from './Icon';
import { ErrorBox, Spinner } from './ui';

/** Phạm vi đang xem ở các trang giáo viên: một khóa học (hoặc nhóm "Chưa gắn bài") và có thể một bài. */
export interface Scope { course: string; lesson: string }
export const UNASSIGNED = '__none__';

export interface ScopeLesson { lesson_id: string; code: string; title: string; videoIds: string[] }
export interface ScopeChapter { title: string; lessons: ScopeLesson[] }
export interface ScopeCourse {
  course_id: string; code: string; title: string; chapters: ScopeChapter[];
  lessons: ScopeLesson[]; lessonCodes: Set<string>; videoIds: Set<string>;
}

interface TreeLesson { lesson_id: string; code: string; title: string; items: { video_id: string | null }[] }
interface Tree { course_id: string; code: string; title: string; chapters: { title: string; lessons: TreeLesson[] }[] }

/** Tải danh sách khóa học kèm cây chương → bài (để biết bài nào thuộc khóa nào, video nào nằm trong bài nào). */
export function useCourseTrees() {
  return useAsync(async (s) => {
    const list = await api<{ course_id: string }[]>('/ai/courses', { signal: s });
    const trees = await Promise.allSettled(list.map((c) => api<Tree>(`/ai/courses/${c.course_id}`, { signal: s })));
    return trees.flatMap((t): ScopeCourse[] => {
      if (t.status !== 'fulfilled') return [];
      const chapters = t.value.chapters.map((ch) => ({
        title: ch.title,
        lessons: ch.lessons.map((l) => ({ lesson_id: l.lesson_id, code: l.code, title: l.title, videoIds: l.items.map((i) => i.video_id).filter(Boolean) as string[] })),
      }));
      const lessons = chapters.flatMap((ch) => ch.lessons);
      return [{ course_id: t.value.course_id, code: t.value.code, title: t.value.title, chapters, lessons,
        lessonCodes: new Set(lessons.map((l) => l.code).filter(Boolean)), videoIds: new Set(lessons.flatMap((l) => l.videoIds)) }];
    });
  }, [], 'teach/course-trees');
}

/** Nhớ phạm vi đã chọn của từng trang trong phiên (quay lại không phải chọn lại). */
export function useScope(pageKey: string): [Scope, (s: Scope) => void] {
  const key = `mam.scope.${pageKey}`;
  const [scope, setScope] = useState<Scope>(() => {
    try { const v = JSON.parse(sessionStorage.getItem(key) || 'null'); if (v && typeof v.course === 'string') return { course: v.course, lesson: v.lesson || '' }; } catch { /* bỏ qua */ }
    return { course: '', lesson: '' };
  });
  const set = (s: Scope) => { setScope(s); try { sessionStorage.setItem(key, JSON.stringify(s)); } catch { /* bỏ qua */ } };
  return [scope, set];
}

/** Mã bài thuộc phạm vi đang chọn; null = chưa chọn khóa. */
export function scopeLessons(courses: ScopeCourse[] | null, scope: Scope): ScopeLesson[] | null {
  const c = courses?.find((x) => x.course_id === scope.course);
  if (!c) return null;
  return scope.lesson ? c.lessons.filter((l) => l.code === scope.lesson) : c.lessons;
}

/** Mã bài có thuộc khóa học nào không (dùng để xếp nội dung vào nhóm "Chưa gắn bài"). */
export function knownLesson(courses: ScopeCourse[] | null, code: string | null | undefined) {
  return !!code && !!courses?.some((c) => c.lessonCodes.has(code));
}

/**
 * Khung chọn từng bước: (1) lưới khóa học → (2) chương/bài bên trái, nội dung bên phải.
 * Trang chỉ hiện nội dung (children) khi đã chọn khóa, để không đổ hết mọi thứ ra cùng lúc.
 */
export function CourseScope({ courses, loading, error, onRetry, scope, onChange, unit, countLesson, countCourse, unassigned = 0, children }: {
  courses: ScopeCourse[] | null; loading: boolean; error: string | null; onRetry: () => void;
  scope: Scope; onChange: (s: Scope) => void; unit: string;
  countLesson: (l: ScopeLesson) => number | null; countCourse?: (c: ScopeCourse) => number | null; unassigned?: number; children: ReactNode;
}) {
  if (error && !courses) return <ErrorBox message={error} onRetry={onRetry} />;
  if (loading && !courses) return <Spinner />;
  const list = courses || [];
  const course = list.find((c) => c.course_id === scope.course);
  const none = scope.course === UNASSIGNED;
  const lesson = course?.lessons.find((l) => l.code === scope.lesson);
  const sum = (c: ScopeCourse) => countCourse ? countCourse(c) : c.lessons.reduce<number | null>((n, l) => { const v = countLesson(l); return v == null || n == null ? null : n + v; }, 0);
  const fmt = (n: number | null) => (n == null ? '' : `${n} ${unit}`);

  const crumbs = (
    <nav className="cs-crumbs" aria-label="Phạm vi">
      <button type="button" onClick={() => onChange({ course: '', lesson: '' })} disabled={!course && !none}>Tất cả khóa học</button>
      {(course || none) && <><Icon name="chevronRight" size={14} /><button type="button" onClick={() => onChange({ course: scope.course, lesson: '' })} disabled={!lesson}>{none ? 'Chưa gắn bài' : course!.title}</button></>}
      {lesson && <><Icon name="chevronRight" size={14} /><span>{lesson.title}</span></>}
    </nav>
  );

  if (!course && !none) {
    return (
      <>
        {crumbs}
        <p className="muted small" style={{ margin: '0 0 12px' }}>Chọn một khóa học để xem {unit} theo từng bài.</p>
        <div className="cs-grid">
          {list.map((c) => (
            <button key={c.course_id} type="button" className="cs-card" onClick={() => onChange({ course: c.course_id, lesson: '' })}>
              <span className="cs-card-ico"><Icon name="book" size={20} /></span>
              <strong>{c.title}</strong>
              <span className="muted small">{c.lessons.length} bài{fmt(sum(c)) ? ` · ${fmt(sum(c))}` : ''}</span>
            </button>
          ))}
          {unassigned > 0 && (
            <button type="button" className="cs-card cs-card-none" onClick={() => onChange({ course: UNASSIGNED, lesson: '' })}>
              <span className="cs-card-ico"><Icon name="tag" size={20} /></span>
              <strong>Chưa gắn bài</strong>
              <span className="muted small">{fmt(unassigned)} chưa thuộc bài nào</span>
            </button>
          )}
        </div>
        {!list.length && <p className="muted">Chưa có khóa học nào. Tạo khóa học ở trang Khóa học.</p>}
      </>
    );
  }

  if (none) return <>{crumbs}{children}</>;

  return (
    <>
      {crumbs}
      <div className="cs-layout">
        <aside className="cs-side" aria-label="Bài học trong khóa">
          <button type="button" className={`cs-lesson ${!scope.lesson ? 'on' : ''}`} onClick={() => onChange({ course: scope.course, lesson: '' })}>
            <span>Tất cả bài trong khóa</span><b>{sum(course!) ?? ''}</b>
          </button>
          {course!.chapters.map((ch, i) => (
            <div key={i} className="cs-chapter">
              <span className="cs-chapter-title">{ch.title}</span>
              {ch.lessons.map((l) => (
                <button key={l.lesson_id} type="button" className={`cs-lesson ${scope.lesson === l.code ? 'on' : ''}`} title={l.code}
                  onClick={() => onChange({ course: scope.course, lesson: l.code })}>
                  <span>{l.title}</span><b>{countLesson(l) ?? ''}</b>
                </button>
              ))}
            </div>
          ))}
          {!course!.lessons.length && <p className="muted small">Khóa này chưa có bài nào.</p>}
        </aside>
        <section className="cs-main">{children}</section>
      </div>
    </>
  );
}
