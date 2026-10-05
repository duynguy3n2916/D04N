import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Flame, Gem, Icon } from '../components/Icon';
import { TutorPanel, type TutorContext } from '../components/TutorPanel';
import { Button, ErrorBox, IconButton, Progress, Spinner, useToast } from '../components/ui';
import { api, errorText, storage, type ItemDetail, type LessonView, type Source, type Stats } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { navigate, useLocation } from '../lib/router';
import { QuizItem } from './items/QuizItem';
import { ReadingItem } from './items/ReadingItem';
import { SlideItem } from './items/SlideItem';
import { VideoItem } from './items/VideoItem';
import { TYPE_ICON, TYPE_LABEL } from './Learn';

export interface ItemProps {
  item: ItemDetail;
  lesson: LessonView;
  onCompleted: (xp?: number) => void;
  setContext: (c: TutorContext) => void;
  registerNav: (fns: { seek?: (t: number) => void; page?: (p: number) => void }) => void;
  askTutor: (quote: string) => void;
  goNext: (() => void) | null;
  query: URLSearchParams;
  /** Chế độ rộng: ẩn mục lục, nội dung (video) trải hết bề ngang. */
  wide: boolean;
  setWide: (v: boolean) => void;
}

export function LessonPage({ lessonId, itemId }: { lessonId: string; itemId?: string }) {
  const path = useLocation();
  const query = useMemo(() => new URLSearchParams(path.split('?')[1] || ''), [path]);
  const toast = useToast();
  const lesson = useAsync((s) => api<LessonView>(`/ai/learn/lessons/${lessonId}`, { signal: s }), [lessonId]);
  const me = useAsync((s) => api<{ stats: Stats }>('/ai/learn/me', { signal: s }), []);
  const activeId = itemId || lesson.data?.items.find((i) => i.status === 'current')?.item_id || lesson.data?.items[0]?.item_id;
  const item = useAsync((s) => (activeId ? api<ItemDetail>(`/ai/learn/items/${activeId}`, { signal: s }) : Promise.resolve(null)), [activeId]);
  const [tutorOpen, setTutorOpen] = useState(() => storage.get('mam.tutorOpen') !== '0' && window.innerWidth > 900);
  const [ctx, setCtx] = useState<TutorContext>({ label: '' });
  const [quote, setQuote] = useState<string | null>(null);
  const [wide, setWideState] = useState(() => storage.get('mam.wide') === '1');
  const setWide = useCallback((v: boolean) => { setWideState(v); storage.set('mam.wide', v ? '1' : '0'); }, []);
  const nav = useRef<{ seek?: (t: number) => void; page?: (p: number) => void }>({});

  useEffect(() => { storage.set('mam.tutorOpen', tutorOpen ? '1' : '0'); }, [tutorOpen]);
  useEffect(() => { nav.current = {}; }, [activeId]);

  const items = lesson.data?.items || [];
  const idx = items.findIndex((i) => i.item_id === activeId);
  const next = idx >= 0 && idx < items.length - 1 ? items[idx + 1] : null;

  const goNext = next ? () => navigate(`/lesson/${lessonId}/${next.item_id}`) : null;

  const reloads = useRef({ lesson: lesson.reload, me: me.reload });
  reloads.current = { lesson: lesson.reload, me: me.reload };
  const onCompleted = useCallback((xp?: number) => {
    reloads.current.lesson();
    reloads.current.me();
    if (xp) toast(`+${xp} XP`, 'xp');
  }, [toast]);

  const setContext = useCallback((c: TutorContext) => setCtx(c), []);
  const registerNav = useCallback((fns: { seek?: (t: number) => void; page?: (p: number) => void }) => { nav.current = { ...nav.current, ...fns }; }, []);
  const askTutor = useCallback((q: string) => { setQuote(q); setTutorOpen(true); }, []);

  const onSource = async (s: Source) => {
    try {
      const cur = item.data;
      if (s.source_type === 'video' && s.source_id) {
        if (cur?.type === 'video' && cur.video?.video_id === s.source_id && nav.current.seek) { nav.current.seek(s.start_time || 0); return; }
        const loc = await api<{ lesson_id: string; item_id: string }>(`/ai/learn/locate?video_id=${encodeURIComponent(s.source_id)}&lesson_id=${lessonId}`);
        navigate(`/lesson/${loc.lesson_id}/${loc.item_id}?t=${Math.floor(s.start_time || 0)}`);
        return;
      }
      if (s.document_id) {
        if (cur?.type === 'slide' && cur.slide?.document_id === s.document_id && s.page && nav.current.page) { nav.current.page(s.page); return; }
        const loc = await api<{ lesson_id: string; item_id: string; type: string }>(`/ai/learn/locate?document_id=${s.document_id}&lesson_id=${lessonId}`);
        navigate(`/lesson/${loc.lesson_id}/${loc.item_id}${s.page ? `?page=${s.page}` : ''}`);
      }
    } catch (e) {
      toast('Nguồn này không nằm trong mục học nào: ' + errorText(e), 'error');
    }
  };

  const stats = me.data?.stats;
  const courseId = lesson.data?.course_id;

  return (
    <div className={`lesson ${wide ? 'lesson-wide' : ''}`}>
      <header className="lesson-top">
        <IconButton icon="chevronLeft" label="Về lộ trình học" onClick={() => navigate(courseId ? `/learn/${courseId}` : '/learn')} />
        <div className="lesson-title">
          <small>{lesson.data?.chapter_title || ' '}</small>
          <strong>{lesson.data?.title || 'Đang tải…'}</strong>
        </div>
        <div className="lesson-top-stats">
          {lesson.data && (
            <>
              <span className="muted" style={{ fontWeight: 800, fontSize: 15 }}>{lesson.data.items_done}/{lesson.data.items_total} mục</span>
              <div style={{ width: 150 }}><Progress value={lesson.data.items_done / Math.max(1, lesson.data.items_total)} label="Tiến độ bài học" /></div>
            </>
          )}
          <span className="stat" style={{ fontSize: 16 }}><Flame size={22} dim={!stats?.studied_today} />{stats?.streak_days ?? 0}</span>
          <span className="stat" style={{ fontSize: 16 }}><Gem size={20} />{stats?.total_xp ?? 0}</span>
        </div>
        <Button variant={tutorOpen ? 'soft' : 'blue'} icon="sparkle" aria-pressed={tutorOpen} onClick={() => setTutorOpen((v) => !v)}>Hỏi Tutor AI</Button>
      </header>

      <div className="lesson-body">
        <nav className="outline" aria-label="Nội dung bài học" hidden={wide}>
          <span className="outline-title">NỘI DUNG BÀI HỌC</span>
          {items.map((it) => {
            const locked = it.status === 'locked';
            const on = it.item_id === activeId;
            const inner = (
              <>
                <span className={`type-ico type-${it.type}`}><Icon name={locked ? 'lock' : TYPE_ICON[it.type]} size={19} /></span>
                <span style={{ minWidth: 0 }}><strong>{it.title}</strong><span className="sub">{it.meta_text}</span></span>
                {it.status === 'done' && <span className="done-dot" aria-label="Đã xong"><Icon name="check" size={14} stroke={3.4} /></span>}
              </>
            );
            return locked ? (
              <span key={it.item_id} className="outline-item outline-locked" title="Hoàn thành mục trước để mở">{inner}</span>
            ) : (
              <a key={it.item_id} href={`#/lesson/${lessonId}/${it.item_id}`} className={`outline-item ${on ? 'outline-on' : ''}`} aria-current={on ? 'page' : undefined}>{inner}</a>
            );
          })}
        </nav>

        <main className="lesson-content" id="lesson-content">
          {(lesson.loading && !lesson.data) || (item.loading && !item.data) ? <Spinner /> : null}
          {lesson.error && <ErrorBox message={lesson.error} onRetry={lesson.reload} />}
          {item.error && <ErrorBox message={item.error} onRetry={item.reload} />}
          {lesson.data && !items.length && <p className="muted">Bài học chưa có nội dung.</p>}
          {item.data && lesson.data && item.data.item_id === activeId && (() => {
            const props: ItemProps = { item: item.data, lesson: lesson.data, onCompleted, setContext, registerNav, askTutor, goNext, query, wide, setWide };
            const locked = items.find((i) => i.item_id === activeId)?.status === 'locked';
            if (locked) return <ErrorBox message="Mục này chưa mở khóa. Hãy hoàn thành các mục phía trước." />;
            switch (item.data.type) {
              case 'video': return <VideoItem key={item.data.item_id} {...props} />;
              case 'slide': return <SlideItem key={item.data.item_id} {...props} />;
              case 'reading': return <ReadingItem key={item.data.item_id} {...props} />;
              default: return <QuizItem key={item.data.item_id} {...props} />;
            }
          })()}
        </main>

        {tutorOpen && lesson.data && (
          <TutorPanel lessonCode={lesson.data.code} context={ctx.label ? ctx : { label: item.data ? `${TYPE_LABEL[item.data.type]} · ${item.data.title}` : lesson.data.title }}
            quote={quote} onClearQuote={() => setQuote(null)} onSource={onSource} onClose={() => setTutorOpen(false)} />
        )}
      </div>
    </div>
  );
}
