import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PageHeader } from '../../components/AppShell';
import { Icon } from '../../components/Icon';
import { activeCaption, CaptionSettings, useVideoCaptions, VideoCaption } from '../../components/VideoCaptions';
import { Badge, Button, confirmDialog, Empty, ErrorBox, Field, IconButton, Modal, Spinner, useToast } from '../../components/ui';
import { api, errorText, fmtTime, mediaUrl, type Job, type TranscriptSegment } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { Link, navigate } from '../../lib/router';
import { FilterPills, SearchBox, StatusTag, Toolbar } from '../../components/Manage';
import { CourseScope, UNASSIGNED, useCourseTrees, useScope } from '../../components/CourseScope';
import { Select } from '../../components/Select';

interface VideoRow {
  video_id: string; title: string; has_file: boolean; source_url: string | null; duration_seconds: number | null; size_mb: number | null;
  class_id: string | null; transcript: { version: number; source: string } | null; questions: { approved: number; draft: number }; created_at: string | null;
}
interface TQuestion {
  question_id: string; timestamp: number; type: string; difficulty: string; question: string; options: string[] | null;
  correct_answer: string | null; correct_index: number | null; explanation: string | null; origin: string; status: string; edited: boolean;
}
interface Transcript { version: number; source: string; language: string; segments: TranscriptSegment[] }
interface Version { version: number; is_active: boolean; source: string; model_version: string; created_at: string }
interface CourseChoice { course_id: string; title: string }
interface CourseDestination extends CourseChoice {
  chapters: { chapter_id: string; title: string; lessons: { lesson_id: string; title: string }[] }[];
}

// ---------------------------------------------------------------- Danh sách video

type VFilter = '' | 'no-sub' | 'draft' | 'no-file';
/** Hỏi xác nhận rồi xóa video (kèm phụ đề, câu hỏi trong video và mục bài học dùng video). Trả về true nếu đã xóa. */
async function confirmDeleteVideo(v: { video_id: string; title: string }, toast: ReturnType<typeof useToast>): Promise<boolean> {
  const ok = await confirmDialog(`Xóa video “${v.title || v.video_id}”? Phụ đề, các câu hỏi trong video và mục bài học đang dùng video này cũng bị xóa. Không hoàn tác được.`,
    { title: 'Xóa video', okLabel: 'Xóa', danger: true });
  if (!ok) return false;
  try {
    await api(`/ai/media/videos/${encodeURIComponent(v.video_id)}`, { method: 'DELETE' });
    toast('Đã xóa video', 'success');
    return true;
  } catch (e) { toast(errorText(e), 'error'); return false; }
}

export function Videos() {
  const toast = useToast();
  const list = useAsync((s) => api<VideoRow[]>('/ai/media/videos', { signal: s }), [], 'teach/videos');
  const [open, setOpen] = useState(false);
  const [dropped, setDropped] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<VFilter>('');
  const trees = useCourseTrees();
  const [scope, setScope] = useScope('videos');
  const everything = list.data || [];
  // video thuộc bài nào: lấy từ các mục video trong cây khóa học (item.video_id)
  const inAnyLesson = new Set((trees.data || []).flatMap((c) => [...c.videoIds]));
  const course = trees.data?.find((c) => c.course_id === scope.course);
  const scopeIds = course ? new Set((scope.lesson ? course.lessons.filter((l) => l.code === scope.lesson) : course.lessons).flatMap((l) => l.videoIds)) : null;
  const all = scope.course === UNASSIGNED ? everything.filter((v) => !inAnyLesson.has(v.video_id)) : scopeIds ? everything.filter((v) => scopeIds.has(v.video_id)) : everything;
  const known = new Set(everything.map((v) => v.video_id));
  const test = (v: VideoRow, f: VFilter) => f === 'no-sub' ? !v.transcript : f === 'draft' ? v.questions.draft > 0 : f === 'no-file' ? !v.has_file && !v.source_url : true;
  const rows = all.filter((v) => test(v, filter) && (!q || v.title.toLowerCase().includes(q.toLowerCase())));
  // Kéo thả file video vào bất kỳ đâu trên trang để mở hộp tải lên.
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('video/') || /\.(mp4|webm|mov|mkv)$/i.test(x.name));
    if (f) { setDropped(f); setOpen(true); }
  };
  return (
    <div className="videos-page" onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }} onDrop={onDrop}>
      <PageHeader title="Video bài giảng" sub="Tải video, tạo phụ đề và đặt câu hỏi dừng video cho học sinh. Có thể kéo thả file video vào trang."
        actions={<Button icon="upload" onClick={() => { setDropped(null); setOpen(true); }}>Thêm video</Button>} />
      <CourseScope courses={trees.data} loading={trees.loading || list.loading} error={trees.error || list.error} onRetry={() => { trees.reload(); list.reload(); }}
        scope={scope} onChange={setScope} unit="video"
        compactLessons
        countLesson={(l) => l.videoIds.filter((id) => known.has(id)).length}
        countCourse={(c) => [...c.videoIds].filter((id) => known.has(id)).length}
        unassigned={everything.filter((v) => !inAnyLesson.has(v.video_id)).length}>
      <Toolbar>
        <SearchBox value={q} onChange={setQ} placeholder="Tìm video…" />
        <FilterPills<VFilter> label="Lọc video" value={filter} onChange={setFilter} options={[
          { id: '', label: 'Tất cả', count: all.length }, { id: 'no-sub', label: 'Chưa có phụ đề', count: all.filter((v) => test(v, 'no-sub')).length },
          { id: 'draft', label: 'Câu hỏi chờ duyệt', count: all.filter((v) => test(v, 'draft')).length }, { id: 'no-file', label: 'Chưa có file', count: all.filter((v) => test(v, 'no-file')).length }]} />
      </Toolbar>
      {list.data && !all.length && <Empty title="Chưa có video nào ở đây">Bấm “Thêm video” hoặc kéo thả file .mp4 vào trang này, rồi chọn bài để gắn video vào.</Empty>}
      {!!all.length && !rows.length && <Empty title="Không có video nào khớp">Thử bỏ bớt bộ lọc hoặc từ khóa.</Empty>}
      <div className="video-grid">
        {rows.map((v) => (
          <Link key={v.video_id} to={`/teach/videos/${encodeURIComponent(v.video_id)}`} className="vcard">
            <span className="vcard-thumb">
              <span className="vcard-play"><Icon name="play" size={22} /></span>
              {v.duration_seconds ? <span className="vcard-dur">{fmtTime(v.duration_seconds)}</span> : null}
              {!v.has_file && !v.source_url && <span className="vcard-flag">Chưa có file</span>}
              {v.source_url && !v.has_file && <span className="vcard-flag">Link ngoài</span>}
              <button type="button" className="iconbtn vcard-del" aria-label="Xóa video" title="Xóa video"
                onClick={async (e) => { e.preventDefault(); e.stopPropagation(); if (await confirmDeleteVideo(v, toast)) list.reload(); }}>
                <Icon name="trash" size={18} />
              </button>
            </span>
            <span className="vcard-body">
              <strong>{v.title}</strong>
              <span className="vcard-tags">
                {v.transcript ? <StatusTag tone="ok">Có phụ đề</StatusTag> : <StatusTag tone="muted">Chưa có phụ đề</StatusTag>}
                {v.questions.approved > 0 && <StatusTag tone="ai">{v.questions.approved} câu hỏi</StatusTag>}
                {v.questions.draft > 0 && <StatusTag tone="wait">{v.questions.draft} chờ duyệt</StatusTag>}
              </span>
            </span>
          </Link>
        ))}
      </div>
      </CourseScope>
      {dragging && <div className="drop-hint" aria-hidden="true"><Icon name="upload" size={32} /><strong>Thả file video để tải lên</strong></div>}
      {open && <UploadDialog initialFile={dropped} initialCourse={course?.course_id} initialLesson={course?.lessons.find((l) => l.code === scope.lesson)?.lesson_id} onClose={() => setOpen(false)} onDone={(id) => { setOpen(false); navigate(`/teach/videos/${encodeURIComponent(id)}`); }} />}
    </div>
  );
}

function UploadDialog({ onClose, onDone, initialFile, initialCourse, initialLesson }: {
  onClose: () => void; onDone: (videoId: string) => void; initialFile?: File | null; initialCourse?: string; initialLesson?: string;
}) {
  const [mode, setMode] = useState<'file' | 'url'>('file');
  const [f, setF] = useState({ title: initialFile ? initialFile.name.replace(/\.[^.]+$/, '') : '', class_id: '', course_id: initialCourse || '', target_lesson_id: initialLesson || '', url: '', transcribe: true });
  const courses = useAsync((s) => api<CourseChoice[]>('/ai/courses', { signal: s }), []);
  const destination = useAsync((s) => f.course_id
    ? api<CourseDestination>(`/ai/courses/${f.course_id}`, { signal: s }) : Promise.resolve(null), [f.course_id]);
  const selectedCourse = destination.data?.course_id === f.course_id ? destination.data : null;
  const lessonExists = !!selectedCourse?.chapters.some((ch) => ch.lessons.some((ls) => ls.lesson_id === f.target_lesson_id));
  const [file, setFile] = useState<File | null>(initialFile || null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      let videoId: string;
      if (mode === 'url') {
        const r = await api<VideoRow>('/ai/media/videos/url', { json: { title: f.title.trim(), source_url: f.url,
          target_lesson_id: f.target_lesson_id || null, class_id: f.course_id ? null : f.class_id || null } });
        videoId = r.video_id;
      } else {
        const fd = new FormData();
        fd.append('file', file!);
        if (f.title) fd.append('title', f.title);
        if (!f.course_id && f.class_id) fd.append('class_id', f.class_id);
        if (f.target_lesson_id) fd.append('target_lesson_id', f.target_lesson_id);
        fd.append('transcribe', String(f.transcribe));
        setMsg('Đang tải lên…');
        const r = await api<VideoRow & { job_id?: string }>('/ai/media/videos', { form: fd });
        videoId = r.video_id;
        if (r.job_id) setMsg('Đã tải lên. Phiên âm đang chạy nền — xem tiến độ ở trang video.');
      }
      onDone(videoId);
    } catch (e) { setErr(errorText(e)); setMsg(null); } finally { setBusy(false); }
  };
  const valid = !!f.title.trim() && (!f.course_id || lessonExists) && (mode === 'url' ? /^https?:\/\//.test(f.url) : !!file);

  return (
    <Modal open onClose={onClose} title="Thêm video" dismissable={!busy}>
      <form className="modal-body" onSubmit={(e) => { e.preventDefault(); if (valid) submit(); }}>
        <div className="seg" role="group" aria-label="Nguồn video" style={{ alignSelf: 'flex-start' }}>
          <button type="button" className={mode === 'file' ? 'on' : ''} onClick={() => setMode('file')}>Tải file lên</button>
          <button type="button" className={mode === 'url' ? 'on' : ''} onClick={() => setMode('url')}>Link .mp4</button>
        </div>
        <Field label="Tiêu đề video"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Khóa học" hint="Chọn khóa học để thêm video vào một bài, hoặc lưu vào thư viện trước.">
          <Select value={f.course_id} disabled={courses.loading || busy}
            onChange={(v) => setF({ ...f, course_id: v, target_lesson_id: '' })}>
            <option value="">Lưu vào thư viện video</option>
            {courses.data?.map((c) => <option key={c.course_id} value={c.course_id}>{c.title}</option>)}
          </Select>
        </Field>
        {courses.error && <ErrorBox message={courses.error} onRetry={courses.reload} />}
        {f.course_id ? (
          <>
            <Field label="Bài học" hint="Video sẽ được thêm vào cuối bài học đã chọn.">
              <Select value={f.target_lesson_id} disabled={destination.loading || busy}
                onChange={(v) => setF({ ...f, target_lesson_id: v })}>
                <option value="">— Chọn bài học —</option>
                {selectedCourse?.chapters.map((ch) => <optgroup key={ch.chapter_id} label={ch.title}>
                  {ch.lessons.map((ls) => <option key={ls.lesson_id} value={ls.lesson_id}>{ls.title}</option>)}
                </optgroup>)}
              </Select>
            </Field>
            {!destination.loading && selectedCourse && !selectedCourse.chapters.some((ch) => ch.lessons.length) &&
              <p className="small muted">Khóa học chưa có bài. Thêm chương và bài học trong mục Khóa học trước.</p>}
            {destination.error && <ErrorBox message={destination.error} onRetry={destination.reload} />}
          </>
        ) : <Field label="Lớp (tùy chọn)" hint="Để trống = mọi lớp"><input value={f.class_id} onChange={(e) => setF({ ...f, class_id: e.target.value })} /></Field>}
        {mode === 'file' ? (
          <>
            <Field label="File video/audio" hint="mp4, webm, mov, mp3, m4a, wav…"><input type="file" accept="video/*,audio/*" onChange={(e) => {
              const selected = e.target.files?.[0] || null; setFile(selected);
              if (selected && !f.title.trim()) setF({ ...f, title: selected.name.replace(/\.[^.]+$/, '') });
            }} /></Field>
            <label className="check"><input type="checkbox" checked={f.transcribe} onChange={(e) => setF({ ...f, transcribe: e.target.checked })} />Tự phiên âm bằng Whisper sau khi tải lên</label>
          </>
        ) : (
          <Field label="Link video trực tiếp"><input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://…/bai-giang.mp4" /></Field>
        )}
        {msg && <p className="small" style={{ fontWeight: 600 }}>{msg}</p>}
        {err && <ErrorBox message={err} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Hủy</Button>
          <Button type="submit" loading={busy} disabled={!valid}>Lưu video</Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Chi tiết video

export function VideoDetail({ videoId }: { videoId: string }) {
  const toast = useToast();
  const info = useAsync((s) => api<VideoRow[]>('/ai/media/videos', { signal: s }).then((xs) => xs.find((x) => x.video_id === videoId) || null), [videoId]);
  const tr = useAsync((s) => api<Transcript>(`/ai/videos/${encodeURIComponent(videoId)}/transcript`, { signal: s }).catch((e) => { if (e?.status === 404) return null; throw e; }), [videoId]);
  const transcriptionJob = useAsync((s) => api<Job | null>(`/ai/media/videos/${encodeURIComponent(videoId)}/transcription-job`, { signal: s }), [videoId]);
  const qs = useAsync((s) => api<TQuestion[]>(`/ai/videos/${encodeURIComponent(videoId)}/questions/manage`, { signal: s }), [videoId]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const workspaceMainRef = useRef<HTMLDivElement>(null);
  const workspaceSideRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const questionContentRef = useRef<HTMLDivElement>(null);
  const captionPreferences = useVideoCaptions();
  const [captionMenu, setCaptionMenu] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [now, setNow] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [workspaceMode, setWorkspaceMode] = useState<'watch' | 'edit'>('watch');
  const [tab, setTab] = useState<'questions' | 'transcript'>('questions');
  const [questionFilter, setQuestionFilter] = useState<'all' | 'draft' | 'approved' | 'rejected'>('all');
  const [focusQuestionId, setFocusQuestionId] = useState<string | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const [editQ, setEditQ] = useState<TQuestion | 'new' | null>(null);
  const [gen, setGen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [suggestionNotice, setSuggestionNotice] = useState<string | null>(null);
  const handledJob = useRef<string | null>(null);
  const didAutoScroll = useRef(false);

  const v = info.data;
  const src = v?.has_file ? mediaUrl(`/ai/media/videos/${encodeURIComponent(videoId)}/file`) : v?.source_url || null;
  const duration = v?.duration_seconds || mediaDuration;
  const questions = qs.data || [];
  const visibleQuestions = questionFilter === 'all' ? questions : questions.filter((q) => q.status === questionFilter);
  const seek = (t: number) => { const el = videoRef.current; if (el) { el.currentTime = t; setNow(t); el.play().catch(() => {}); } };
  const currentCaption = activeCaption(tr.data?.segments || [], now);
  const scrollToVideo = () => {
    const main = workspaceMainRef.current;
    if (!main) return;
    const start = window.scrollY;
    const target = Math.max(0, start + main.getBoundingClientRect().top - 8);
    const distance = target - start;
    if (Math.abs(distance) < 2) return;
    const startedAt = performance.now();
    const durationMs = 1100;
    const animate = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / durationMs);
      const eased = progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2;
      window.scrollTo(0, start + distance * eased);
      if (progress < 1) window.requestAnimationFrame(animate);
    };
    window.requestAnimationFrame(animate);
  };
  useLayoutEffect(() => {
    const main = workspaceMainRef.current;
    const side = workspaceSideRef.current;
    if (!main || !side) return;
    const syncHeight = () => {
      if (workspaceMode !== 'watch' || window.matchMedia('(max-width: 700px)').matches) {
        side.style.removeProperty('height');
        return;
      }
      side.style.height = `${main.getBoundingClientRect().height}px`;
    };
    const observer = new ResizeObserver(syncHeight);
    observer.observe(main);
    window.addEventListener('resize', syncHeight);
    syncHeight();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncHeight);
      side.style.removeProperty('height');
    };
  }, [workspaceMode, src, duration]);
  useEffect(() => {
    if (!focusQuestionId || tab !== 'questions' || editQ || createOpen || !qs.data) return;
    const cards = questionContentRef.current?.querySelectorAll<HTMLElement>('[data-question-id]');
    const card = cards && Array.from(cards).find((item) => item.dataset.questionId === focusQuestionId);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setFocusQuestionId(null);
  }, [focusQuestionId, tab, editQ, createOpen, questionFilter, qs.data]);
  const fullscreen = () => {
    const action = document.fullscreenElement ? document.exitFullscreen() : playerRef.current?.requestFullscreen();
    action?.catch(() => toast('Trình duyệt không cho bật toàn màn hình', 'error'));
  };
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === playerRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  useEffect(() => { setNow(0); setCaptionMenu(false); }, [videoId]);
  useEffect(() => {
    setWorkspaceMode('watch');
    setTab('questions');
    setCreateOpen(false);
    setEditQ(null);
    didAutoScroll.current = false;
  }, [videoId]);
  useEffect(() => {
    if (info.loading || didAutoScroll.current) return;
    const frame = window.requestAnimationFrame(() => {
      if (didAutoScroll.current) return;
      didAutoScroll.current = true;
      scrollToVideo();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [videoId, info.loading]);

  useEffect(() => {
    const j = transcriptionJob.data;
    if (!j) return;
    if (j.status === 'queued' || j.status === 'running') {
      setJob(`Đang phiên âm… ${j.progress != null ? Math.round(j.progress * 100) + '%' : ''} ${j.message || ''}`);
      const timer = window.setTimeout(transcriptionJob.reload, 1500);
      return () => window.clearTimeout(timer);
    }
    if (handledJob.current === j.job_id) return;
    handledJob.current = j.job_id;
    if (j.status === 'succeeded') {
      setJob(null);
      tr.reload(); info.reload();
    } else {
      setJob(`Phiên âm lỗi: ${j.error || j.message || 'Không rõ nguyên nhân'}`);
    }
  }, [transcriptionJob.data]);

  const transcribe = async () => {
    try {
      await api<{ job_id: string }>(`/ai/media/videos/${encodeURIComponent(videoId)}/transcribe`, { method: 'POST' });
      setJob('Đang phiên âm…');
      setTab('transcript');
      transcriptionJob.reload();
    } catch (e) { setJob(null); toast(errorText(e), 'error'); }
  };

  const generateAt = async () => {
    setGen(true);
    try {
      await api(`/ai/videos/${encodeURIComponent(videoId)}/generate-question`, { json: { timestamp: Math.floor(now), use_lesson_context: false } });
      toast(`AI đã soạn câu hỏi nháp tại ${fmtTime(now)}`, 'success');
      setTab('questions'); setCreateOpen(false); setQuestionFilter('draft'); setSuggestionNotice(null); qs.reload();
    } catch (e) { toast(errorText(e), 'error'); } finally { setGen(false); }
  };
  const suggest = async () => {
    setGen(true);
    try {
      const r = await api<{ suggestions: { time: string; concept: string }[]; warnings?: string[] }>(`/ai/videos/${encodeURIComponent(videoId)}/suggest-timestamps`, { json: { max_suggestions: 3 } });
      const summary = r.suggestions.length ? `AI đã đề xuất ${r.suggestions.length} câu tại ${r.suggestions.map((s) => s.time).join(', ')}.` : 'AI chưa tìm được mốc phù hợp.';
      setSuggestionNotice([summary, ...(r.warnings || [])].join(' '));
      toast(r.suggestions.length ? `Đã tạo ${r.suggestions.length} câu nháp từ video` : 'Không tìm được mốc phù hợp', r.suggestions.length ? 'success' : 'error');
      setTab('questions'); setCreateOpen(false); setQuestionFilter('draft'); qs.reload();
    } catch (e) { toast(errorText(e), 'error'); } finally { setGen(false); }
  };
  const setStatus = async (q: TQuestion, status: string) => {
    try { await api(`/ai/video-questions/${q.question_id}`, { method: 'PATCH', json: { status } }); setQuestionFilter('all'); qs.reload(); info.reload(); } catch (e) { toast(errorText(e), 'error'); }
  };
  const archive = async (q: TQuestion) => {
    if (!await confirmDialog('Xóa câu hỏi này?', { danger: true, okLabel: 'Xóa' })) return;
    try { await api(`/ai/video-questions/${q.question_id}`, { method: 'DELETE' }); setQuestionFilter('all'); qs.reload(); } catch (e) { toast(errorText(e), 'error'); }
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}><Link to="/teach/videos" className="muted small" style={{ fontWeight: 600 }}>← Tất cả video</Link></div>
      <PageHeader title={v?.title || videoId} sub={videoId}
        actions={<Button variant="red" icon="trash" onClick={async () => {
          if (await confirmDeleteVideo({ video_id: videoId, title: v?.title || videoId }, toast)) navigate('/teach/videos');
        }}>Xóa video</Button>} />
      {info.error && <ErrorBox message={info.error} onRetry={info.reload} />}
      <div ref={workspaceRef} className={`split video-editor-workspace ${workspaceMode === 'watch' ? 'watch-mode' : 'edit-mode'}`}>
        <div className="main" ref={workspaceMainRef}>
          {src ? (
            <div className="teacher-player" ref={playerRef} onKeyDown={(e) => {
              if ((e.target as HTMLElement).closest('button, input, select')) return;
              if ((e.key === 'c' || e.key === 'C') && tr.data?.segments.length) { e.preventDefault(); captionPreferences.setEnabled(!captionPreferences.enabled); }
              if (e.key === 'Escape') setCaptionMenu(false);
            }}>
              <div className="teacher-video-stage">
                <video ref={videoRef} src={src} controls controlsList="nofullscreen" playsInline onLoadedMetadata={(e) => setMediaDuration(e.currentTarget.duration)}
                  onClick={(e) => {
                    const video = e.currentTarget;
                    if (e.clientY >= video.getBoundingClientRect().bottom - 48) return;
                    if (video.paused) video.play().catch(() => {}); else video.pause();
                  }}
                  onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} onSeeked={(e) => setNow(e.currentTarget.currentTime)} />
                <VideoCaption text={currentCaption?.text} preferences={captionPreferences} />
              </div>
              <div className="teacher-player-tools">
                <span>{tr.data?.segments.length ? 'Phụ đề từ bản phiên âm' : 'Video chưa có phụ đề'}</span>
                <button type="button" className={`ctl ${captionPreferences.enabled && tr.data?.segments.length ? 'ctl-on' : ''}`}
                  aria-label="Bật/tắt phụ đề (C)" title="Bật/tắt phụ đề (C)" aria-pressed={captionPreferences.enabled}
                  disabled={!tr.data?.segments.length} onClick={() => captionPreferences.setEnabled(!captionPreferences.enabled)}><Icon name="captions" size={24} /></button>
                <button type="button" className="ctl" aria-label="Cài đặt phụ đề" title="Cài đặt phụ đề" aria-expanded={captionMenu}
                  onClick={() => setCaptionMenu(!captionMenu)}><Icon name="settings" size={22} /></button>
                <button type="button" className="ctl" aria-label={isFullscreen ? 'Thoát toàn màn hình' : 'Toàn màn hình'} title="Toàn màn hình" onClick={fullscreen}>
                  <Icon name={isFullscreen ? 'fullscreenExit' : 'fullscreen'} size={22} /></button>
              </div>
              {captionMenu && <div className="menu video-settings" role="group" aria-label="Cài đặt phụ đề"
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setCaptionMenu(false); }}>
                <div className="menu-row"><strong>Cài đặt phụ đề</strong><button type="button" className="pill" aria-label="Đóng cài đặt phụ đề" onClick={() => setCaptionMenu(false)}>Đóng</button></div>
                <CaptionSettings preferences={captionPreferences} available={!!tr.data?.segments.length} />
              </div>}
            </div>
          ) : info.loading ? <Spinner /> : <Empty title="Video chưa có file">Tải file lên ở trang danh sách (cùng mã video).</Empty>}
          {src && duration > 0 && <TeacherTimeline duration={duration} now={now} segments={tr.data?.segments || []} questions={qs.data || []}
            onSeek={(time, kind, questionId) => {
              if (kind === 'subtitle') setTab('transcript');
              else { setTab('questions'); setQuestionFilter('all'); setCreateOpen(false); if (questionId) setFocusQuestionId(questionId); }
              seek(time);
            }} />}
        </div>
        <div className="side" ref={workspaceSideRef}>
          <div className="teacher-panel-navigation">
            <div className="video-panel-tabs" role="tablist" aria-label="Nội dung video">
              <button role="tab" aria-selected={tab === 'questions'} className={tab === 'questions' ? 'on' : ''} onClick={() => { setTab('questions'); setCreateOpen(false); }}>Câu hỏi</button>
              <button role="tab" aria-selected={tab === 'transcript'} className={tab === 'transcript' ? 'on' : ''} onClick={() => { setTab('transcript'); setCreateOpen(false); }}>Phụ đề</button>
            </div>
            <IconButton icon={workspaceMode === 'watch' ? 'zoomIn' : 'zoomOut'}
              label={workspaceMode === 'watch' ? 'Phóng to khu vực thao tác' : 'Thu nhỏ khu vực thao tác'}
              onClick={() => setWorkspaceMode((mode) => mode === 'watch' ? 'edit' : 'watch')} />
          </div>
          {tab === 'questions' && !editQ && !createOpen && <>
            <div className="teacher-panel-actions">
              <span>Đang xem <strong>{fmtTime(now)}</strong></span>
              <Button size="sm" icon="plus" onClick={() => setCreateOpen(true)}>Tạo câu hỏi</Button>
            </div>
          </>}
          {tab === 'questions' && createOpen && !editQ && <section className="teacher-create-mode">
            <div className="teacher-create-mode-head">
              <div><strong>Tạo câu hỏi</strong><span>Chọn cách bạn muốn bắt đầu.</span></div>
              <Button size="sm" variant="ghost" onClick={() => setCreateOpen(false)}>Quay lại danh sách</Button>
            </div>
            <div className="teacher-create-options">
              <button type="button" className="teacher-create-option" onClick={() => { setCreateOpen(false); setEditQ('new'); }}>
                <strong>Tự soạn tại mốc đang xem</strong><span>Bạn tự nhập câu hỏi và đáp án.</span>
              </button>
              <button type="button" className="teacher-create-option" disabled={!tr.data?.segments.length || gen} onClick={generateAt}>
                <strong>AI soạn quanh mốc đang xem</strong><span>{tr.data?.segments.length ? 'Tạo một câu nháp dựa trên phụ đề đoạn này.' : 'Cần phụ đề video để AI hiểu nội dung.'}</span>
              </button>
              <button type="button" className="teacher-create-option" disabled={!tr.data?.segments.length || gen} onClick={suggest}>
                <strong>AI tìm đoạn quan trọng</strong><span>{tr.data?.segments.length ? 'Tạo tối đa 3 câu nháp ở các mốc phù hợp.' : 'Cần phụ đề video để AI tìm mốc.'}</span>
              </button>
            </div>
            {tr.error && <ErrorBox message={tr.error} onRetry={tr.reload} />}
          </section>}
          {tab === 'questions' && !createOpen && (
            <div className="teacher-question-panel">
              {!editQ && qs.data && <div className="teacher-question-filters" role="group" aria-label="Lọc câu hỏi theo trạng thái">
                {([
                  ['all', 'Tất cả', questions.length], ['draft', 'Câu nháp', questions.filter((q) => q.status === 'draft').length],
                  ['approved', 'Đã duyệt', questions.filter((q) => q.status === 'approved').length], ['rejected', 'Từ chối', questions.filter((q) => q.status === 'rejected').length],
                ] as const).map(([key, label, count]) => <button key={key} type="button" className={questionFilter === key ? 'on' : ''}
                  aria-pressed={questionFilter === key} onClick={() => setQuestionFilter(key)}>{label}<span>{count}</span></button>)}
              </div>}
              <div ref={questionContentRef} className="col teacher-question-content" style={{ gap: 12 }}>
              {editQ ? <QuestionEditor inline videoId={videoId} q={editQ === 'new' ? null : editQ} defaultTime={now} maxDuration={duration} onPreview={seek}
                onClose={() => setEditQ(null)} onSaved={() => { setEditQ(null); setQuestionFilter('all'); qs.reload(); info.reload(); }} /> : <>
              {suggestionNotice && <div className="video-suggestion-notice" role="status">{suggestionNotice}</div>}
              {qs.loading && !qs.data && <Spinner />}
              {qs.error && <ErrorBox message={qs.error} onRetry={qs.reload} />}
              {qs.data && !questions.length && <Empty title="Chưa có câu hỏi">Tua video đến đoạn cần kiểm tra rồi chọn Tạo câu hỏi.</Empty>}
              {qs.data && questions.length > 0 && !visibleQuestions.length && <Empty title="Không có câu hỏi ở trạng thái này">
                <Button size="sm" variant="ghost" onClick={() => setQuestionFilter('all')}>Xem tất cả câu hỏi</Button>
              </Empty>}
              {visibleQuestions.map((q) => (
                <div key={q.question_id} data-question-id={q.question_id} className={`qcard ${Math.abs(q.timestamp - now) < 1 ? 'qcard-at-time' : ''}`}>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="src" onClick={() => seek(q.timestamp)}><Icon name="play" size={14} />{fmtTime(q.timestamp)}</button>
                    <Badge tone={q.status === 'approved' ? 'green' : q.status === 'rejected' ? 'red' : 'yellow'}>{q.status === 'approved' ? 'Đã duyệt' : q.status === 'rejected' ? 'Từ chối' : 'Nháp'}</Badge>
                    <Badge>{q.origin === 'teacher' ? 'GV/AI' : q.origin === 'ai_suggest' ? 'AI đề xuất' : q.origin}</Badge>
                    {q.edited && <Badge tone="blue">Đã sửa</Badge>}
                  </div>
                  <h3>{q.question}</h3>
                  {q.options && (
                    <div className="qcard-opts">
                      {q.options.map((o, i) => <div key={i} className={`qcard-opt ${i === q.correct_index ? 'ok' : ''}`}>{o}</div>)}
                    </div>
                  )}
                  {!q.options && q.correct_answer && <p className="small"><b>Đáp án:</b> {q.correct_answer}</p>}
                  {q.explanation && <p className="muted small" style={{ fontWeight: 600 }}>{q.explanation}</p>}
                  <div className="row">
                    {q.status !== 'approved' && <Button size="sm" icon="check" onClick={() => setStatus(q, 'approved')}>Duyệt</Button>}
                    {q.status === 'draft' && <Button size="sm" variant="danger-ghost" onClick={() => setStatus(q, 'rejected')}>Từ chối</Button>}
                    {q.status === 'approved' && <Button size="sm" variant="ghost" onClick={() => setStatus(q, 'draft')}>Bỏ duyệt</Button>}
                    <IconButton icon="edit" label="Sửa câu hỏi" onClick={() => setEditQ(q)} />
                    <IconButton icon="trash" label="Xóa câu hỏi" onClick={() => archive(q)} />
                  </div>
                </div>
              ))}
              </>}
              </div>
            </div>
          )}
          {tab === 'transcript' && (
            <>
            {tr.error && <ErrorBox message={tr.error} onRetry={tr.reload} />}
            <TranscriptEditor videoId={videoId} tr={tr.data} loading={tr.loading} now={now} onSeek={seek} hasFile={!!v?.has_file}
              job={job} transcribing={transcriptionJob.data?.status === 'queued' || transcriptionJob.data?.status === 'running'}
              onTranscribe={transcribe} onSaved={() => { tr.reload(); info.reload(); }} />
            </>
          )}
        </div>
      </div>
    </>
  );
}

function TeacherTimeline({ duration, now, segments, questions, onSeek }: {
  duration: number; now: number; segments: TranscriptSegment[]; questions: TQuestion[];
  onSeek: (time: number, kind: 'subtitle' | 'question', questionId?: string) => void;
}) {
  const position = (time: number) => `${Math.max(0, Math.min(100, (time / duration) * 100))}%`;
  const coverage = [...segments].sort((a, b) => a.start_time - b.start_time).reduce<{ start: number; end: number }[]>((ranges, segment) => {
    const last = ranges[ranges.length - 1];
    if (last && segment.start_time <= last.end + 0.5) last.end = Math.max(last.end, segment.end_time);
    else ranges.push({ start: segment.start_time, end: segment.end_time });
    return ranges;
  }, []);
  return <div className="teacher-timeline" aria-label="Mốc phụ đề và câu hỏi trong video">
    <div className="teacher-timeline-head"><strong>Phụ đề và câu hỏi</strong><span>Thời lượng {fmtTime(duration)}</span></div>
    <div className="teacher-timeline-track">
      <div className="teacher-timeline-progress" style={{ width: position(now) }} />
      <button type="button" className="teacher-timeline-subtitle-lane" disabled={!segments.length} aria-label="Tua video theo phụ đề"
        onClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          onSeek(Math.max(0, Math.min(duration, ((event.clientX - bounds.left) / bounds.width) * duration)), 'subtitle');
        }}>
        {coverage.map((range, i) => <span key={`coverage-${i}`} style={{ left: position(range.start), width: `${Math.max(0, (range.end - range.start) / duration * 100)}%` }} />)}
      </button>
      {questions.map((question) => <button key={question.question_id} type="button" className={`teacher-timeline-question ${question.status === 'approved' ? 'approved' : question.status === 'rejected' ? 'rejected' : 'draft'}`}
        style={{ left: position(question.timestamp) }} title={`${fmtTime(question.timestamp)} · ${question.question}`}
        aria-label={`Câu hỏi ${fmtTime(question.timestamp)}: ${question.question}`} onClick={() => onSeek(question.timestamp, 'question', question.question_id)} />)}
      <div className="teacher-timeline-cursor" style={{ left: position(now) }} />
    </div>
    <div className="teacher-timeline-legend"><span><i className="caption-key" /> Phụ đề</span><span><i className="question-key" /> Câu hỏi nháp</span><span><i className="question-key approved" /> Câu đã duyệt</span><span><i className="question-key rejected" /> Từ chối</span></div>
  </div>;
}

function TranscriptEditor({ videoId, tr, loading, now, onSeek, hasFile, job, transcribing, onTranscribe, onSaved }: {
  videoId: string; tr: Transcript | null; loading: boolean; now: number; onSeek: (t: number) => void; hasFile: boolean;
  job: string | null; transcribing: boolean; onTranscribe: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const [segs, setSegs] = useState<TranscriptSegment[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const versions = useAsync((s) => (showVersions ? api<Version[]>(`/ai/videos/${encodeURIComponent(videoId)}/transcript/versions`, { signal: s }) : Promise.resolve([] as Version[])), [showVersions, tr?.version]);
  const fileRef = useRef<HTMLInputElement>(null);
  const activeSegRef = useRef<HTMLDivElement>(null);
  const activeSegIndex = segs.findIndex((segment) => now >= segment.start_time && now < segment.end_time);

  useEffect(() => { setSegs(tr?.segments || []); setDirty(false); }, [tr]);
  useEffect(() => { activeSegRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [activeSegIndex]);

  const save = async () => {
    setBusy(true);
    try { await api(`/ai/videos/${encodeURIComponent(videoId)}/transcript`, { method: 'PUT', json: { segments: segs, language: tr?.language || 'vi' } }); toast('Đã lưu phiên bản phụ đề mới', 'success'); onSaved(); }
    catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  const importFile = async (file: File) => {
    const fd = new FormData(); fd.append('video_id', videoId); fd.append('file', file);
    setBusy(true);
    try { const r = await api<{ message: string }>('/ai/videos/import-transcript', { form: fd }); toast(r.message, 'success'); onSaved(); }
    catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const rollback = async (ver: number) => {
    try { await api(`/ai/videos/${encodeURIComponent(videoId)}/transcript/rollback/${ver}`, { method: 'POST' }); toast(`Đã khôi phục từ phiên bản ${ver}`, 'success'); onSaved(); }
    catch (e) { toast(errorText(e), 'error'); }
  };

  return (
    <div className="card col teacher-transcript-card" style={{ gap: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{tr ? `Phiên bản ${tr.version} · ${tr.source}` : 'Chưa có phụ đề'}</strong>
        <div className="row">
          <input ref={fileRef} type="file" accept=".srt,.vtt,.json,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); }} />
          <Button size="sm" variant="ghost" icon="upload" onClick={() => fileRef.current?.click()} disabled={busy}>Nhập .srt/.vtt</Button>
          {hasFile && <Button size="sm" variant="ghost" icon="wand" onClick={onTranscribe} disabled={transcribing}>Phiên âm lại</Button>}
          {tr && <IconButton icon="history" label="Các phiên bản" active={showVersions} onClick={() => setShowVersions((x) => !x)} />}
        </div>
      </div>
      {job && <p className="small" style={{ fontWeight: 600, color: 'var(--blue-dark)' }} aria-live="polite">{job}</p>}
      {showVersions && (
        <div className="col" style={{ gap: 6 }}>
          {versions.data?.map((x) => (
            <div key={x.version} className="row small" style={{ justifyContent: 'space-between', fontWeight: 600 }}>
              <span>v{x.version} · {x.model_version || x.source} · {x.created_at ? new Date(x.created_at).toLocaleString('vi-VN') : ''}</span>
              {x.is_active ? <Badge tone="green">Đang dùng</Badge> : <Button size="sm" variant="ghost" onClick={() => rollback(x.version)}>Khôi phục</Button>}
            </div>
          ))}
        </div>
      )}
      {loading && <Spinner />}
      <div className="col teacher-transcript-segments" style={{ gap: 6 }}>
        {segs.map((s, i) => (
          <div key={i} ref={i === activeSegIndex ? activeSegRef : undefined} className={`seg-edit ${i === activeSegIndex ? 'seg-edit-on' : ''}`}>
            <button className="ts" onClick={() => onSeek(s.start_time)}>{fmtTime(s.start_time)}</button>
            <input aria-label={`Đoạn ${fmtTime(s.start_time)}`} value={s.text} onChange={(e) => { const n = [...segs]; n[i] = { ...s, text: e.target.value }; setSegs(n); setDirty(true); }} />
          </div>
        ))}
      </div>
      {dirty && <div className="row" style={{ justifyContent: 'flex-end' }}><Button variant="ghost" size="sm" onClick={() => { setSegs(tr?.segments || []); setDirty(false); }}>Hoàn tác</Button><Button size="sm" loading={busy} onClick={save}>Lưu thành phiên bản mới</Button></div>}
    </div>
  );
}

function QuestionEditor({ videoId, q, defaultTime, maxDuration, onPreview, inline = false, onClose, onSaved }: {
  videoId: string; q: TQuestion | null; defaultTime: number; maxDuration?: number; onPreview: (time: number) => void; inline?: boolean; onClose: () => void; onSaved: () => void;
}) {
  const initialTime = Math.floor(q?.timestamp ?? defaultTime);
  const [f, setF] = useState({
    timestamp: initialTime, type: q?.type || 'multiple_choice', difficulty: q?.difficulty || 'medium',
    question: q?.question || '', options: q?.options?.length ? q.options : ['', '', '', ''], correct_index: q?.correct_index ?? 0,
    correct_answer: q?.correct_answer || '', explanation: q?.explanation || '',
  });
  const [timestampInput, setTimestampInput] = useState(fmtTime(initialTime));
  const [timestampValid, setTimestampValid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mc = f.type === 'multiple_choice' || f.type === 'true_false';
  const opts = f.type === 'true_false' ? ['Đúng', 'Sai'] : f.options;

  const save = async () => {
    setBusy(true); setErr(null);
    const body: any = { timestamp: f.timestamp, type: f.type, difficulty: f.difficulty, question: f.question, explanation: f.explanation };
    if (mc) { const o = opts.map((x) => x.trim()).filter(Boolean); body.options = o; body.correct_index = Math.min(f.correct_index, o.length - 1); body.correct_answer = o[body.correct_index]; }
    else { body.options = null; body.correct_answer = f.correct_answer; body.correct_index = null; }
    try {
      if (q) await api(`/ai/video-questions/${q.question_id}`, { method: 'PATCH', json: body });
      else await api(`/ai/videos/${encodeURIComponent(videoId)}/questions`, { json: { ...body, status: 'approved' } });
      onSaved();
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  const correctChoice = mc && opts[f.correct_index]?.trim();
  const valid = timestampValid && f.question.trim() && (mc
    ? opts.filter((x) => x.trim()).length >= 2 && !!correctChoice
    : f.correct_answer.trim());

  const form = (
      <form className={`modal-body ${inline ? 'teacher-question-form' : ''}`} onSubmit={(e) => { e.preventDefault(); if (valid) save(); }}>
        <div className="form-grid">
          <Field label="Mốc câu hỏi (mm:ss)" hint={maxDuration ? `Nhập mm:ss hoặc hh:mm:ss · video dài ${fmtTime(maxDuration)}` : 'Nhập mm:ss hoặc hh:mm:ss'}>
            <div className="teacher-question-time-control">
            <input inputMode="numeric" value={timestampInput} aria-invalid={!timestampValid} placeholder="00:00" onChange={(e) => {
              const value = e.target.value.trim();
              setTimestampInput(value);
              const parts = value.split(':');
              if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) { setTimestampValid(false); return; }
              const values = parts.map(Number);
              const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
              const validTime = values[values.length - 1] < 60 && (parts.length !== 3 || values[1] < 60)
                && (!maxDuration || seconds <= maxDuration);
              if (!validTime) { setTimestampValid(false); return; }
              setTimestampValid(true); setF({ ...f, timestamp: seconds });
            }} />
            {inline && <div className="teacher-question-time-actions">
              <Button size="sm" variant="ghost" onClick={() => { setTimestampInput(fmtTime(Math.floor(defaultTime))); setTimestampValid(true); setF((current) => ({ ...current, timestamp: Math.floor(defaultTime) })); }}>Dùng mốc đang xem</Button>
              <Button size="sm" variant="ghost" icon="play" disabled={!timestampValid} onClick={() => onPreview(f.timestamp)}>Phát từ mốc này</Button>
            </div>}
            </div>
          </Field>
          <Field label="Loại">
            <Select value={f.type} onChange={(v) => setF({ ...f, type: v })}>
              <option value="multiple_choice">Trắc nghiệm</option><option value="true_false">Đúng / Sai</option><option value="short_answer">Tự luận ngắn</option>
            </Select>
          </Field>
          <Field label="Độ khó">
            <Select value={f.difficulty} onChange={(v) => setF({ ...f, difficulty: v })}>
              <option value="easy">Dễ</option><option value="medium">Vừa</option><option value="hard">Khó</option>
            </Select>
          </Field>
        </div>
        <Field label="Câu hỏi"><textarea value={f.question} onChange={(e) => setF({ ...f, question: e.target.value })} /></Field>
        {mc ? (
          <fieldset className="col" style={{ gap: 8, border: 'none', padding: 0 }}>
            <legend className="field-label" style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>Lựa chọn (chọn đáp án đúng)</legend>
            {opts.map((o, i) => (
              <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
                <input type="radio" name="correct" aria-label={`Đáp án đúng là lựa chọn ${i + 1}`} checked={f.correct_index === i} onChange={() => setF({ ...f, correct_index: i })} style={{ width: 20, height: 20, accentColor: 'var(--green)' }} />
                <input className="input" value={o} disabled={f.type === 'true_false'} aria-label={`Lựa chọn ${i + 1}`}
                  onChange={(e) => { const n = [...f.options]; n[i] = e.target.value; setF({ ...f, options: n }); }} />
              </div>
            ))}
          </fieldset>
        ) : (
          <Field label="Đáp án mẫu"><textarea value={f.correct_answer} onChange={(e) => setF({ ...f, correct_answer: e.target.value })} /></Field>
        )}
        <Field label="Giải thích (hiện sau khi học sinh trả lời)"><textarea value={f.explanation} onChange={(e) => setF({ ...f, explanation: e.target.value })} /></Field>
        {err && <ErrorBox message={err} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Hủy</Button>
          <Button type="submit" loading={busy} disabled={!valid}>{q ? 'Lưu' : 'Lưu & duyệt'}</Button>
        </div>
      </form>
  );
  if (inline) return <section className="teacher-question-editor">
    <div className="teacher-question-editor-head"><strong>{q ? 'Sửa câu hỏi' : 'Soạn câu hỏi'}</strong><IconButton icon="x" label="Đóng phần soạn" onClick={onClose} /></div>
    {form}
  </section>;
  return <Modal open onClose={onClose} title={q ? 'Sửa câu hỏi' : 'Soạn câu hỏi'} wide dismissable={!busy}>{form}</Modal>;
}
