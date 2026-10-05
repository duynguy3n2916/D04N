import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../components/Icon';
import { Button, Empty, useToast } from '../../components/ui';
import { api, ApiError, errorText, fmtTime, mediaUrl, storage, type AnswerResult, type PublicQuestion, type SessionStatus,
  type TranscriptSegment } from '../../lib/api';
import type { ItemProps } from '../Lesson';
import { QuestionPopup } from './QuestionPopup';

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
const HEARTBEAT_EVERY = 45;

type Popup = { question: PublicQuestion | null; deadlineAt: number | null; result: AnswerResult | null };

export function VideoItem({ item, onCompleted, setContext, registerNav, askTutor, goNext, query, wide, setWide }: ItemProps) {
  const v = item.video!;
  const vid = v.video_id;
  const toast = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const prevT = useRef(0);
  const playedSinceBeat = useRef(0);
  const completedRef = useRef(item.completed);
  const busyRef = useRef(false);
  const doneKey = `mam.vq.done.${vid}`;
  const doneSet = useRef<Set<string>>(new Set(JSON.parse(storage.get(doneKey) || '[]')));

  const [t, setT] = useState(0);
  const [duration, setDuration] = useState(v.duration_seconds || 0);
  const [buffered, setBuffered] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [captions, setCaptions] = useState(storage.get('mam.captions') !== '0');
  const [speed, setSpeed] = useState(1);
  const [menu, setMenu] = useState(false);
  const [advanced, setAdvanced] = useState(storage.get('mam.advanced') === '1');
  const [tab, setTab] = useState<'subs' | 'notes' | 'questions'>('subs');
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [questions, setQuestions] = useState<PublicQuestion[]>([]);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [notes, setNotes] = useState(storage.get(`mam.notes.${item.item_id}`) || '');
  const [, force] = useState(0);
  const [isFs, setIsFs] = useState(false);
  const src = v.stream_path ? mediaUrl(v.stream_path) : v.source_url;

  // ---------------------------------------------------------------- dữ liệu
  useEffect(() => {
    api<{ segments: TranscriptSegment[] }>(`/ai/videos/${encodeURIComponent(vid)}/transcript`).then((r) => setSegments(r.segments)).catch(() => setSegments([]));
    api<PublicQuestion[]>(`/ai/videos/${encodeURIComponent(vid)}/questions`).then((qs) => setQuestions(qs.sort((a, b) => a.timestamp - b.timestamp))).catch(() => setQuestions([]));
  }, [vid]);

  const markDone = (qid: string) => {
    doneSet.current.add(qid);
    storage.set(doneKey, JSON.stringify([...doneSet.current]));
    force((x) => x + 1);
  };

  // khôi phục phiên: đang dở câu hỏi / đang xem phản hồi
  useEffect(() => {
    api<SessionStatus>(`/ai/workflow/session?video_id=${encodeURIComponent(vid)}`).then((s) => {
      if (s.state === 'WAITING_FOR_STUDENT' && s.active_question) {
        const el = videoRef.current;
        if (el) el.currentTime = s.current_video_time || s.active_question.timestamp;
        setPopup({ question: s.active_question, deadlineAt: Date.now() + (s.deadline_remaining_seconds ?? 120) * 1000, result: null });
      } else if (s.can_resume && s.last_result) {
        setPopup({ question: null, deadlineAt: null, result: s.last_result });
      }
    }).catch(() => {});
  }, [vid]);

  // vị trí bắt đầu
  const onLoaded = () => {
    const el = videoRef.current!;
    setDuration(el.duration || v.duration_seconds || 0);
    const start = Number(query.get('t') ?? item.progress_position ?? 0);
    if (start > 0 && start < (el.duration || Infinity) - 3) { el.currentTime = start; prevT.current = start; }
  };

  // ---------------------------------------------------------------- điều hướng từ Tutor
  const seek = useCallback((sec: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, sec);
    prevT.current = el.currentTime;
    setT(el.currentTime);
    boxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);
  useEffect(() => { registerNav({ seek }); }, [registerNav, seek]);

  // ngữ cảnh cho Tutor (nhãn cập nhật mỗi 5 giây)
  const bucket = Math.floor(t / 5);
  useEffect(() => {
    setContext({
      label: `Video ${item.title} · ${fmtTime(t)}`, videoId: vid, getVideoTime: () => videoRef.current?.currentTime || 0,
      suggestions: ['Tóm tắt đoạn vừa xem', 'Giải thích lại chậm hơn', 'Cho mình một ví dụ'],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucket, vid, item.title, setContext]);

  // ---------------------------------------------------------------- câu hỏi
  const openScheduled = async (q: PublicQuestion) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const el = videoRef.current;
    el?.pause();
    try {
      const r = await api<SessionStatus & { question: PublicQuestion }>('/ai/workflow/question-start',
        { json: { video_id: vid, question_id: q.question_id, current_time: el?.currentTime ?? q.timestamp } });
      setPopup({ question: r.question, deadlineAt: Date.now() + (r.deadline_remaining_seconds ?? 120) * 1000, result: null });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'INTERACTION_IN_PROGRESS') {
        const s = await api<SessionStatus>(`/ai/workflow/session?video_id=${encodeURIComponent(vid)}`);
        if (s.active_question) setPopup({ question: s.active_question, deadlineAt: Date.now() + (s.deadline_remaining_seconds ?? 120) * 1000, result: null });
      } else {
        toast(errorText(e), 'error');
        markDone(q.question_id);
        el?.play().catch(() => {});
      }
    } finally {
      busyRef.current = false;
    }
  };

  const heartbeat = async () => {
    if (busyRef.current || !advanced) return;
    busyRef.current = true;
    try {
      const el = videoRef.current;
      const r = await api<SessionStatus & { triggered: boolean; question?: PublicQuestion }>('/ai/question-agent/trigger',
        { json: { video_id: vid, current_time: el?.currentTime || 0, advanced_mode: true } });
      if (r.triggered && r.question) {
        el?.pause();
        setPopup({ question: r.question, deadlineAt: Date.now() + (r.deadline_remaining_seconds ?? 120) * 1000, result: null });
      }
    } catch { /* bỏ qua: agent là tính năng phụ */ } finally { busyRef.current = false; }
  };

  const nextUndone = (from: number, to: number) => questions.find((q) => !doneSet.current.has(q.question_id) && q.timestamp > from && q.timestamp <= to);

  const onTime = () => {
    const el = videoRef.current!;
    const cur = el.currentTime;
    setT(cur);
    if (el.buffered.length) setBuffered(el.buffered.end(el.buffered.length - 1));
    const prev = prevT.current;
    prevT.current = cur;
    if (!popup && !el.paused && cur > prev && cur - prev < 3) {
      const q = nextUndone(prev, cur);
      if (q) { openScheduled(q); return; }
      playedSinceBeat.current += cur - prev;
      if (playedSinceBeat.current >= HEARTBEAT_EVERY) { playedSinceBeat.current = 0; heartbeat(); }
    }
    if (!completedRef.current && el.duration && cur >= el.duration * 0.9) complete();
  };

  const onSeeked = () => {
    const el = videoRef.current!;
    const target = el.currentTime;
    const q = nextUndone(prevT.current, target);
    if (q && target - prevT.current >= 3) {
      // tua qua câu hỏi chưa làm: dừng đúng mốc câu hỏi
      el.currentTime = q.timestamp;
      prevT.current = q.timestamp;
      openScheduled(q);
      return;
    }
    prevT.current = target;
  };

  const complete = async () => {
    if (completedRef.current) return;
    completedRef.current = true;
    try { const r = await api<{ xp_awarded: number }>(`/ai/learn/items/${item.item_id}/complete`, { method: 'POST' }); onCompleted(r.xp_awarded); }
    catch { completedRef.current = false; }
  };

  // lưu vị trí xem
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const el = videoRef.current;
      if (el) api(`/ai/learn/items/${item.item_id}/position`, { json: { position: Math.floor(el.currentTime) } }).catch(() => {});
    }, 15000);
    return () => clearInterval(id);
  }, [playing, item.item_id]);

  const submit = async (selected: number | null, text: string | null) => {
    if (!popup?.question) return;
    try {
      const r = await api<AnswerResult>(`/ai/video-questions/${popup.question.question_id}/answer`,
        { json: { selected_index: selected, student_answer: text, video_time: videoRef.current?.currentTime } });
      markDone(popup.question.question_id);
      setPopup({ ...popup, result: r });
      if (r.xp_awarded) onCompleted(0);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'QUESTION_EXPIRED') { markDone(popup.question.question_id); setPopup({ ...popup, result: e.details?.last_result }); }
      else toast(errorText(e), 'error');
    }
  };

  const popupRef = useRef(popup);
  popupRef.current = popup;

  // Tutor AI đang soạn lời giải thích (chạy nền) -> thăm dò phiên tới khi có kết quả (tối đa ~40 giây)
  const tutorPending = popup?.result?.tutor_status === 'pending';
  useEffect(() => {
    if (!tutorPending) return;
    let tries = 0;
    const id = setInterval(async () => {
      tries += 1;
      try {
        const s = await api<SessionStatus>(`/ai/workflow/session?video_id=${encodeURIComponent(vid)}`);
        const lr = s.last_result;
        if (lr && lr.tutor_status && lr.tutor_status !== 'pending') {
          setPopup((p) => (p?.result && p.result.question_id === lr.question_id
            ? { ...p, result: { ...p.result, tutor_status: lr.tutor_status, tutor_explanation: lr.tutor_explanation, tutor_sources: lr.tutor_sources } } : p));
        }
      } catch { /* thử lại lần sau */ }
      if (tries >= 27) setPopup((p) => (p?.result?.tutor_status === 'pending' ? { ...p, result: { ...p.result, tutor_status: 'failed' } } : p));
    }, 1500);
    return () => clearInterval(id);
  }, [tutorPending, vid]);
  const onTimeout = useCallback(async () => {
    try {
      const r = await api<SessionStatus>('/ai/workflow/timeout', { json: { video_id: vid } });
      setPopup((p) => (p ? { ...p, result: r.last_result } : p));
      if (popupRef.current?.question) markDone(popupRef.current.question.question_id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TOO_EARLY') {
        const left = e.details?.remaining_seconds ?? 2;
        setPopup((p) => (p ? { ...p, deadlineAt: Date.now() + left * 1000 } : p));
      } else toast(errorText(e), 'error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vid]);
  const resume = async () => {
    try { await api('/ai/workflow/resume', { json: { video_id: vid, current_time: videoRef.current?.currentTime } }); }
    catch (e) { if (!(e instanceof ApiError && e.code === 'ANSWER_REQUIRED')) toast(errorText(e), 'error'); else return; }
    setPopup(null);
    videoRef.current?.play().catch(() => {});
  };

  // ---------------------------------------------------------------- điều khiển
  const toggle = () => {
    const el = videoRef.current;
    if (!el || popup) return;
    if (el.paused) el.play().catch(() => {}); else el.pause();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (popup || (e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seek(t + 5); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(t - 5); }
    else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); fullscreen(); }
    else if (e.key === 't' || e.key === 'T') { e.preventDefault(); toggleWide(); }
  };
  const onTimelineClick = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left - 6) / (r.width - 12)));
    const el = videoRef.current;
    if (el && duration) el.currentTime = ratio * duration;
  };
  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else boxRef.current?.requestFullscreen?.().catch(() => toast('Trình duyệt không cho bật toàn màn hình', 'error'));
  };
  useEffect(() => {
    const on = () => setIsFs(document.fullscreenElement === boxRef.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggleWide = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setWide(!wide);
    setTimeout(() => boxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
  };

  const curSeg = useMemo(() => segments.find((s) => t >= s.start_time && t <= s.end_time + 0.3), [segments, t]);
  const curIdx = curSeg ? segments.indexOf(curSeg) : -1;
  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = transcriptRef.current;
    const el = box?.querySelector<HTMLElement>('.tline-on');
    if (box && el && playing) box.scrollTo({ top: el.offsetTop - box.offsetTop - 60, behavior: 'smooth' });
  }, [curIdx, playing]);

  if (!src) {
    return <Empty title="Video chưa có file để phát">Giáo viên cần tải file video lên (mục Video). Bạn vẫn có thể đọc phụ đề và hỏi Tutor.</Empty>;
  }

  const pct = (x: number) => (duration ? `${(x / duration) * 100}%` : '0%');

  return (
    <>
      <div className="player" ref={boxRef} tabIndex={0} onKeyDown={onKey} aria-label="Trình phát video">
        <video ref={videoRef} src={src} preload="metadata" playsInline onClick={toggle} onDoubleClick={fullscreen}
          onLoadedMetadata={onLoaded} onTimeUpdate={onTime} onSeeked={onSeeked}
          onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); complete(); }} />
        {captions && curSeg && <div className="player-caption">{curSeg.text}</div>}
        {!playing && !popup && (
          <button className="player-bigplay" onClick={toggle} aria-label="Phát video"><span><Icon name="play" size={40} /></span></button>
        )}
        <div className="player-bar">
          <div className="timeline" onClick={onTimelineClick} role="slider" aria-label="Thanh thời gian" aria-valuemin={0}
            aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(t)} aria-valuetext={fmtTime(t)} tabIndex={-1}>
            <div className="timeline-track">
              <div className="timeline-buf" style={{ width: pct(buffered) }} />
              <div className="timeline-fill" style={{ width: pct(t) }} />
              <span className="timeline-knob" style={{ left: pct(t) }} />
              {questions.map((q) => (
                <span key={q.question_id} className={`timeline-mark ${doneSet.current.has(q.question_id) ? 'done' : ''}`} style={{ left: pct(q.timestamp) }}
                  title={`Câu hỏi tại ${fmtTime(q.timestamp)}`} />
              ))}
            </div>
          </div>
          <div className="controls">
            <button className="ctl" onClick={toggle} aria-label={playing ? 'Tạm dừng' : 'Phát'}><Icon name={playing ? 'pause' : 'play'} size={22} /></button>
            <button className="ctl" onClick={() => seek(t - 10)} aria-label="Lùi 10 giây"><Icon name="rewind" size={22} /></button>
            <span className="time">{fmtTime(t)} / {fmtTime(duration)}</span>
            <span style={{ flex: 1 }} />
            {advanced && <span className="badge badge-purple" title="Question Agent đang bật">AI hỏi mở rộng</span>}
            <button className={`ctl ${captions ? 'ctl-on' : ''}`} aria-pressed={captions} aria-label="Phụ đề"
              onClick={() => { setCaptions(!captions); storage.set('mam.captions', captions ? '0' : '1'); }}><Icon name="captions" size={24} /></button>
            <button className="ctl ctl-text" onClick={() => setMenu(!menu)} aria-expanded={menu} aria-label="Cài đặt phát">{speed}x</button>
            <button className={`ctl ${wide ? 'ctl-on' : ''}`} onClick={toggleWide} aria-pressed={wide}
              aria-label={wide ? 'Thoát chế độ rộng (T)' : 'Chế độ rộng (T)'} title={wide ? 'Thoát chế độ rộng (T)' : 'Chế độ rộng (T)'}><Icon name="theater" size={24} /></button>
            <button className="ctl" onClick={fullscreen} aria-label={isFs ? 'Thoát toàn màn hình (F)' : 'Toàn màn hình (F)'}
              title={isFs ? 'Thoát toàn màn hình (F)' : 'Toàn màn hình (F)'}><Icon name={isFs ? 'fullscreenExit' : 'fullscreen'} size={22} /></button>
          </div>
        </div>
        {menu && (
          <div className="menu" role="menu">
            <div className="menu-row"><span>Tốc độ</span>
              <span className="row" style={{ gap: 4 }}>{SPEEDS.map((s) => (
                <button key={s} className={`pill ${s === speed ? 'pill-on' : ''}`} style={{ padding: '4px 8px', minHeight: 32 }}
                  onClick={() => { setSpeed(s); if (videoRef.current) videoRef.current.playbackRate = s; }}>{s}x</button>
              ))}</span>
            </div>
            <div className="menu-row"><span>Khung hình</span>
              <span className="row" style={{ gap: 4 }}>
                <button className={`pill ${!wide && !isFs ? 'pill-on' : ''}`} style={{ padding: '4px 8px', minHeight: 32 }}
                  onClick={() => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); setWide(false); }}>Vừa</button>
                <button className={`pill ${wide && !isFs ? 'pill-on' : ''}`} style={{ padding: '4px 8px', minHeight: 32 }}
                  onClick={() => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); setWide(true); }}>Rộng</button>
                <button className={`pill ${isFs ? 'pill-on' : ''}`} style={{ padding: '4px 8px', minHeight: 32 }}
                  onClick={() => { setMenu(false); if (!isFs) fullscreen(); }}>Toàn màn hình</button>
              </span>
            </div>
            <label className="menu-row check"><span>Câu hỏi mở rộng của AI</span>
              <input type="checkbox" checked={advanced} onChange={(e) => { setAdvanced(e.target.checked); storage.set('mam.advanced', e.target.checked ? '1' : '0'); }} />
            </label>
            <p className="muted small" style={{ padding: '0 10px 6px' }}>Khi bật, thỉnh thoảng AI sẽ dừng video hỏi một câu vận dụng (tối đa mỗi 5 phút).</p>
          </div>
        )}
      </div>

      <div className="content-head">
        <div>
          <h1>{item.title}</h1>
          <span className="muted">{fmtTime(duration)} · {questions.length} câu hỏi trong video · video tự dừng khi tới câu hỏi</span>
        </div>
        {goNext && <Button onClick={goNext} icon="chevronRight">Mục tiếp theo</Button>}
      </div>

      <div className="tabs" role="tablist">
        <button className={`tab ${tab === 'subs' ? 'tab-on' : ''}`} role="tab" aria-selected={tab === 'subs'} onClick={() => setTab('subs')}>Phụ đề</button>
        <button className={`tab ${tab === 'questions' ? 'tab-on' : ''}`} role="tab" aria-selected={tab === 'questions'} onClick={() => setTab('questions')}>Câu hỏi ({questions.length})</button>
        <button className={`tab ${tab === 'notes' ? 'tab-on' : ''}`} role="tab" aria-selected={tab === 'notes'} onClick={() => setTab('notes')}>Ghi chú của tôi</button>
      </div>
      {tab === 'subs' && (
        segments.length ? (
          <div className="transcript" ref={transcriptRef}>
            {segments.map((s, i) => (
              <button key={i} className={`tline ${i === curIdx ? 'tline-on' : ''}`} onClick={() => seek(s.start_time)}>
                <span className="ts">{fmtTime(s.start_time)}</span><span>{s.text}</span>
              </button>
            ))}
          </div>
        ) : <p className="muted">Video chưa có phụ đề.</p>
      )}
      {tab === 'questions' && (
        <div className="col" style={{ gap: 8 }}>
          {questions.length === 0 && <p className="muted">Giáo viên chưa đặt câu hỏi cho video này.</p>}
          {questions.map((q) => (
            <div key={q.question_id} className="row" style={{ flexWrap: 'nowrap' }}>
              <button className="tline" style={{ flex: 1 }} onClick={() => seek(Math.max(0, q.timestamp - 15))}>
                <span className="ts">{fmtTime(q.timestamp)}</span><span>{q.question}</span>
              </button>
              {doneSet.current.has(q.question_id) && <span className="badge badge-green">Đã trả lời</span>}
            </div>
          ))}
        </div>
      )}
      {tab === 'notes' && (
        <div className="col">
          <div className="row">
            <Button size="sm" variant="ghost" icon="clock" onClick={() => {
              const v2 = `${notes}${notes && !notes.endsWith('\n') ? '\n' : ''}[${fmtTime(t)}] `;
              setNotes(v2); storage.set(`mam.notes.${item.item_id}`, v2);
            }}>Thêm mốc {fmtTime(t)}</Button>
            <span className="muted small">Ghi chú lưu trên trình duyệt này.</span>
          </div>
          <textarea className="input note-area" value={notes} aria-label="Ghi chú của tôi"
            onChange={(e) => { setNotes(e.target.value); storage.set(`mam.notes.${item.item_id}`, e.target.value); }} />
        </div>
      )}

      {popup && (() => {
        const el = (
          <QuestionPopup question={popup.question} deadlineAt={popup.deadlineAt} result={popup.result}
            onSubmit={submit} onTimeout={onTimeout} onContinue={resume} onSeek={(s) => { if (s != null) seek(s); }}
            onAskTutor={() => {
              if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
              askTutor(`${popup.question?.question || ''}\nĐáp án đúng: ${popup.result?.correct_answer || ''}`);
            }} />
        );
        // Đang toàn màn hình: chỉ phần tử toàn màn hình được hiển thị, nên đặt popup vào trong khung video.
        return isFs && boxRef.current ? createPortal(el, boxRef.current) : el;
      })()}
    </>
  );
}
