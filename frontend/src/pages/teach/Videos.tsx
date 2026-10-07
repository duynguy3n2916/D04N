import { useEffect, useRef, useState } from 'react';
import { PageHeader } from '../../components/AppShell';
import { Icon } from '../../components/Icon';
import { activeCaption, CaptionSettings, useVideoCaptions, VideoCaption } from '../../components/VideoCaptions';
import { Badge, Button, Empty, ErrorBox, Field, IconButton, Modal, Spinner, useToast } from '../../components/ui';
import { api, errorText, fmtTime, mediaUrl, type Job, type TranscriptSegment } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { Link, navigate } from '../../lib/router';

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

export function Videos() {
  const list = useAsync((s) => api<VideoRow[]>('/ai/media/videos', { signal: s }), []);
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader title="Video bài giảng" sub="Tải video, tạo phụ đề và đặt câu hỏi dừng video cho học sinh."
        actions={<Button icon="upload" onClick={() => setOpen(true)}>Thêm video</Button>} />
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.data && !list.data.length && <Empty title="Chưa có video nào" />}
      <div className="col" style={{ gap: 12 }}>
        {list.data?.map((v) => (
          <Link key={v.video_id} to={`/teach/videos/${encodeURIComponent(v.video_id)}`} className="video-card">
            <span className="video-thumb"><Icon name="play" size={24} /></span>
            <span className="col" style={{ gap: 4, flex: 1, minWidth: 0 }}>
              <strong style={{ fontSize: 17 }}>{v.title}</strong>
              <span className="row" style={{ gap: 6 }}>
                <span className="muted small">{v.video_id}{v.duration_seconds ? ` · ${fmtTime(v.duration_seconds)}` : ''}{v.size_mb ? ` · ${v.size_mb} MB` : ''}</span>
                {!v.has_file && !v.source_url && <Badge tone="red">Chưa có file</Badge>}
                {v.source_url && !v.has_file && <Badge tone="blue">Link ngoài</Badge>}
                {v.transcript ? <Badge tone="green">Phụ đề v{v.transcript.version}</Badge> : <Badge tone="orange">Chưa có phụ đề</Badge>}
                <Badge tone="purple">{v.questions.approved} câu hỏi</Badge>
                {v.questions.draft > 0 && <Badge tone="yellow">{v.questions.draft} nháp chờ duyệt</Badge>}
              </span>
            </span>
            <Icon name="chevronRight" />
          </Link>
        ))}
      </div>
      {open && <UploadDialog onClose={() => setOpen(false)} onDone={(id) => { setOpen(false); navigate(`/teach/videos/${encodeURIComponent(id)}`); }} />}
    </>
  );
}

function UploadDialog({ onClose, onDone }: { onClose: () => void; onDone: (videoId: string) => void }) {
  const [mode, setMode] = useState<'file' | 'url'>('file');
  const [f, setF] = useState({ title: '', class_id: '', course_id: '', target_lesson_id: '', url: '', transcribe: true });
  const courses = useAsync((s) => api<CourseChoice[]>('/ai/courses', { signal: s }), []);
  const destination = useAsync((s) => f.course_id
    ? api<CourseDestination>(`/ai/courses/${f.course_id}`, { signal: s }) : Promise.resolve(null), [f.course_id]);
  const selectedCourse = destination.data?.course_id === f.course_id ? destination.data : null;
  const lessonExists = !!selectedCourse?.chapters.some((ch) => ch.lessons.some((ls) => ls.lesson_id === f.target_lesson_id));
  const [file, setFile] = useState<File | null>(null);
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
          <select value={f.course_id} disabled={courses.loading || busy}
            onChange={(e) => setF({ ...f, course_id: e.target.value, target_lesson_id: '' })}>
            <option value="">Lưu vào thư viện video</option>
            {courses.data?.map((c) => <option key={c.course_id} value={c.course_id}>{c.title}</option>)}
          </select>
        </Field>
        {courses.error && <ErrorBox message={courses.error} onRetry={courses.reload} />}
        {f.course_id ? (
          <>
            <Field label="Bài học" hint="Video sẽ được thêm vào cuối bài học đã chọn.">
              <select value={f.target_lesson_id} disabled={destination.loading || busy}
                onChange={(e) => setF({ ...f, target_lesson_id: e.target.value })}>
                <option value="">— Chọn bài học —</option>
                {selectedCourse?.chapters.map((ch) => <optgroup key={ch.chapter_id} label={ch.title}>
                  {ch.lessons.map((ls) => <option key={ls.lesson_id} value={ls.lesson_id}>{ls.title}</option>)}
                </optgroup>)}
              </select>
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
        {msg && <p className="small" style={{ fontWeight: 700 }}>{msg}</p>}
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
  const captionPreferences = useVideoCaptions();
  const [captionMenu, setCaptionMenu] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [now, setNow] = useState(0);
  const [tab, setTab] = useState<'questions' | 'transcript'>('questions');
  const [job, setJob] = useState<string | null>(null);
  const [editQ, setEditQ] = useState<TQuestion | 'new' | null>(null);
  const [gen, setGen] = useState(false);
  const handledJob = useRef<string | null>(null);

  const v = info.data;
  const src = v?.has_file ? mediaUrl(`/ai/media/videos/${encodeURIComponent(videoId)}/file`) : v?.source_url || null;
  const seek = (t: number) => { const el = videoRef.current; if (el) { el.currentTime = t; setNow(t); el.play().catch(() => {}); } };
  const currentCaption = activeCaption(tr.data?.segments || [], now);
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
    const j = transcriptionJob.data;
    if (!j) return;
    if (j.status === 'queued' || j.status === 'running') {
      setJob(`Đang phiên âm… ${j.progress != null ? Math.round(j.progress * 100) + '%' : ''} ${j.message || ''}`);
      setTab('transcript');
      const timer = window.setTimeout(transcriptionJob.reload, 1500);
      return () => window.clearTimeout(timer);
    }
    if (handledJob.current === j.job_id) return;
    handledJob.current = j.job_id;
    if (j.status === 'succeeded') {
      setJob(null);
      tr.reload(); info.reload(); setTab('transcript');
    } else {
      setJob(`Phiên âm lỗi: ${j.error || j.message || 'Không rõ nguyên nhân'}`);
      setTab('transcript');
    }
  }, [transcriptionJob.data]);

  const transcribe = async () => {
    try {
      await api<{ job_id: string }>(`/ai/media/videos/${encodeURIComponent(videoId)}/transcribe`, { method: 'POST' });
      setJob('Đang phiên âm…');
      transcriptionJob.reload();
    } catch (e) { setJob(null); toast(errorText(e), 'error'); }
  };

  const generateAt = async () => {
    setGen(true);
    try {
      await api(`/ai/videos/${encodeURIComponent(videoId)}/generate-question`, { json: { timestamp: Math.floor(now), use_lesson_context: false } });
      toast(`AI đã soạn câu hỏi nháp tại ${fmtTime(now)}`, 'success'); qs.reload();
    } catch (e) { toast(errorText(e), 'error'); } finally { setGen(false); }
  };
  const suggest = async () => {
    setGen(true);
    try {
      const r = await api<{ suggestions: { time: string; concept: string }[]; warnings?: string[] }>(`/ai/videos/${encodeURIComponent(videoId)}/suggest-timestamps`, { json: { max_suggestions: 3 } });
      toast(r.suggestions.length ? `Đề xuất ${r.suggestions.length} mốc: ${r.suggestions.map((s) => s.time).join(', ')}` : 'Không tìm được mốc phù hợp', 'success');
      qs.reload();
    } catch (e) { toast(errorText(e), 'error'); } finally { setGen(false); }
  };
  const setStatus = async (q: TQuestion, status: string) => {
    try { await api(`/ai/video-questions/${q.question_id}`, { method: 'PATCH', json: { status } }); qs.reload(); info.reload(); } catch (e) { toast(errorText(e), 'error'); }
  };
  const archive = async (q: TQuestion) => {
    if (!window.confirm('Xóa câu hỏi này?')) return;
    try { await api(`/ai/video-questions/${q.question_id}`, { method: 'DELETE' }); qs.reload(); } catch (e) { toast(errorText(e), 'error'); }
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}><Link to="/teach/videos" className="muted small" style={{ fontWeight: 800 }}>← Tất cả video</Link></div>
      <PageHeader title={v?.title || videoId} sub={`${videoId}${v?.duration_seconds ? ` · ${fmtTime(v.duration_seconds)}` : ''}`} />
      {info.error && <ErrorBox message={info.error} onRetry={info.reload} />}
      <div className="split">
        <div className="main">
          {src ? (
            <div className="teacher-player" ref={playerRef} onKeyDown={(e) => {
              if ((e.target as HTMLElement).closest('button, input, select')) return;
              if ((e.key === 'c' || e.key === 'C') && tr.data?.segments.length) { e.preventDefault(); captionPreferences.setEnabled(!captionPreferences.enabled); }
              if (e.key === 'Escape') setCaptionMenu(false);
            }}>
              <div className="teacher-video-stage">
                <video ref={videoRef} src={src} controls controlsList="nofullscreen" playsInline
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
          <div className="card col" style={{ gap: 10 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>Đang ở {fmtTime(now)}</strong>
              <div className="row">
                <Button size="sm" variant="blue" icon="wand" loading={gen} disabled={!tr.data} onClick={generateAt}>AI soạn câu hỏi tại đây</Button>
                <Button size="sm" variant="ghost" icon="plus" onClick={() => setEditQ('new')}>Tự soạn câu hỏi</Button>
                <Button size="sm" variant="ghost" icon="sparkle" loading={gen} disabled={!tr.data} onClick={suggest}>AI đề xuất mốc</Button>
              </div>
            </div>
            <p className="muted small" style={{ fontWeight: 700 }}>
              {tr.data ? 'AI soạn câu hỏi tại đây chỉ dùng lời giảng của video đang xem. Muốn kết hợp slide hoặc bài đọc, chọn nguồn ở mục Câu hỏi.'
                : !tr.loading ? 'Cần có phụ đề trước khi AI soạn câu hỏi.' : 'Đang tải phụ đề…'}
            </p>
            {tr.error && <ErrorBox message={tr.error} onRetry={tr.reload} />}
          </div>
        </div>
        <div className="side">
          <div className="seg" role="tablist" style={{ alignSelf: 'flex-start' }}>
            <button role="tab" aria-selected={tab === 'questions'} className={tab === 'questions' ? 'on' : ''} onClick={() => setTab('questions')}>Câu hỏi ({qs.data?.length ?? 0})</button>
            <button role="tab" aria-selected={tab === 'transcript'} className={tab === 'transcript' ? 'on' : ''} onClick={() => setTab('transcript')}>Phụ đề</button>
          </div>
          {tab === 'questions' && (
            <div className="col" style={{ gap: 12 }}>
              {qs.loading && !qs.data && <Spinner />}
              {qs.error && <ErrorBox message={qs.error} onRetry={qs.reload} />}
              {qs.data && !qs.data.length && <Empty title="Chưa có câu hỏi">Tua tới đoạn quan trọng rồi bấm “AI soạn câu hỏi tại đây”.</Empty>}
              {qs.data?.map((q) => (
                <div key={q.question_id} className="qcard">
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
                  {q.explanation && <p className="muted small" style={{ fontWeight: 700 }}>{q.explanation}</p>}
                  <div className="row">
                    {q.status !== 'approved' && <Button size="sm" icon="check" onClick={() => setStatus(q, 'approved')}>Duyệt</Button>}
                    {q.status === 'draft' && <Button size="sm" variant="danger-ghost" onClick={() => setStatus(q, 'rejected')}>Từ chối</Button>}
                    {q.status === 'approved' && <Button size="sm" variant="ghost" onClick={() => setStatus(q, 'draft')}>Bỏ duyệt</Button>}
                    <IconButton icon="edit" label="Sửa câu hỏi" onClick={() => setEditQ(q)} />
                    <IconButton icon="trash" label="Xóa câu hỏi" onClick={() => archive(q)} />
                  </div>
                </div>
              ))}
            </div>
          )}
          {tab === 'transcript' && (
            <TranscriptEditor videoId={videoId} tr={tr.data} loading={tr.loading} now={now} onSeek={seek} hasFile={!!v?.has_file}
              job={job} transcribing={transcriptionJob.data?.status === 'queued' || transcriptionJob.data?.status === 'running'}
              onTranscribe={transcribe} onSaved={() => { tr.reload(); info.reload(); }} />
          )}
        </div>
      </div>
      {editQ && <QuestionEditor videoId={videoId} q={editQ === 'new' ? null : editQ} defaultTime={now} onClose={() => setEditQ(null)} onSaved={() => { setEditQ(null); qs.reload(); info.reload(); }} />}
    </>
  );
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

  useEffect(() => { setSegs(tr?.segments || []); setDirty(false); }, [tr]);

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
    <div className="card col" style={{ gap: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{tr ? `Phiên bản ${tr.version} · ${tr.source}` : 'Chưa có phụ đề'}</strong>
        <div className="row">
          <input ref={fileRef} type="file" accept=".srt,.vtt,.json,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); }} />
          <Button size="sm" variant="ghost" icon="upload" onClick={() => fileRef.current?.click()} disabled={busy}>Nhập .srt/.vtt</Button>
          {hasFile && <Button size="sm" variant="ghost" icon="wand" onClick={onTranscribe} disabled={transcribing}>Phiên âm lại</Button>}
          {tr && <IconButton icon="history" label="Các phiên bản" active={showVersions} onClick={() => setShowVersions((x) => !x)} />}
        </div>
      </div>
      {job && <p className="small" style={{ fontWeight: 800, color: 'var(--blue-dark)' }} aria-live="polite">{job}</p>}
      {showVersions && (
        <div className="col" style={{ gap: 6 }}>
          {versions.data?.map((x) => (
            <div key={x.version} className="row small" style={{ justifyContent: 'space-between', fontWeight: 700 }}>
              <span>v{x.version} · {x.model_version || x.source} · {x.created_at ? new Date(x.created_at).toLocaleString('vi-VN') : ''}</span>
              {x.is_active ? <Badge tone="green">Đang dùng</Badge> : <Button size="sm" variant="ghost" onClick={() => rollback(x.version)}>Khôi phục</Button>}
            </div>
          ))}
        </div>
      )}
      {loading && <Spinner />}
      <div className="col" style={{ gap: 6, maxHeight: 460, overflowY: 'auto' }}>
        {segs.map((s, i) => (
          <div key={i} className="seg-edit" style={now >= s.start_time && now < s.end_time ? { background: 'var(--green-soft)', borderRadius: 8 } : undefined}>
            <button className="ts" onClick={() => onSeek(s.start_time)}>{fmtTime(s.start_time)}</button>
            <input aria-label={`Đoạn ${fmtTime(s.start_time)}`} value={s.text} onChange={(e) => { const n = [...segs]; n[i] = { ...s, text: e.target.value }; setSegs(n); setDirty(true); }} />
          </div>
        ))}
      </div>
      {dirty && <div className="row" style={{ justifyContent: 'flex-end' }}><Button variant="ghost" size="sm" onClick={() => { setSegs(tr?.segments || []); setDirty(false); }}>Hoàn tác</Button><Button size="sm" loading={busy} onClick={save}>Lưu thành phiên bản mới</Button></div>}
    </div>
  );
}

function QuestionEditor({ videoId, q, defaultTime, onClose, onSaved }: { videoId: string; q: TQuestion | null; defaultTime: number; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    timestamp: Math.floor(q?.timestamp ?? defaultTime), type: q?.type || 'multiple_choice', difficulty: q?.difficulty || 'medium',
    question: q?.question || '', options: q?.options?.length ? q.options : ['', '', '', ''], correct_index: q?.correct_index ?? 0,
    correct_answer: q?.correct_answer || '', explanation: q?.explanation || '',
  });
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
  const valid = f.question.trim() && (mc ? opts.filter((x) => x.trim()).length >= 2 : f.correct_answer.trim());

  return (
    <Modal open onClose={onClose} title={q ? 'Sửa câu hỏi' : 'Soạn câu hỏi'} wide dismissable={!busy}>
      <form className="modal-body" onSubmit={(e) => { e.preventDefault(); if (valid) save(); }}>
        <div className="form-grid">
          <Field label="Thời điểm (giây)" hint={fmtTime(f.timestamp)}><input type="number" min={0} value={f.timestamp} onChange={(e) => setF({ ...f, timestamp: Number(e.target.value) })} /></Field>
          <Field label="Loại">
            <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
              <option value="multiple_choice">Trắc nghiệm</option><option value="true_false">Đúng / Sai</option><option value="short_answer">Tự luận ngắn</option>
            </select>
          </Field>
          <Field label="Độ khó">
            <select value={f.difficulty} onChange={(e) => setF({ ...f, difficulty: e.target.value })}>
              <option value="easy">Dễ</option><option value="medium">Vừa</option><option value="hard">Khó</option>
            </select>
          </Field>
        </div>
        <Field label="Câu hỏi"><textarea value={f.question} onChange={(e) => setF({ ...f, question: e.target.value })} /></Field>
        {mc ? (
          <fieldset className="col" style={{ gap: 8, border: 'none', padding: 0 }}>
            <legend className="field-label" style={{ fontWeight: 800, fontSize: 14, marginBottom: 6 }}>Lựa chọn (chọn đáp án đúng)</legend>
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
    </Modal>
  );
}
