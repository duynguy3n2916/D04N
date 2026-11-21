import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { PageHeader } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { Mascot } from '../components/Mascot';
import { Button, useToast } from '../components/ui';
import { api, errorText, fmtTime, storage, type Source } from '../lib/api';
import { navigate } from '../lib/router';

interface CoachStep { tool: string; arguments: string; ok: boolean; writes: boolean }
interface CoachAction { type: 'item' | 'flashcards'; label: string; item_id?: string; lesson_id?: string; lesson_code?: string }
interface CoachResponse { answer: string; steps: CoachStep[]; sources: Source[]; actions: CoachAction[]; guarded: boolean; stopped: string | null; llm_calls: number }
interface Msg { role: 'user' | 'assistant'; content: string; res?: CoachResponse; error?: boolean }

const KEY = 'mam.coach.msgs';
const TOOL_LABEL: Record<string, string> = {
  get_progress: 'Xem tiến độ',
  get_weak_points: 'Tìm câu hay sai',
  get_due_flashcards: 'Kiểm tra thẻ đến hạn',
  search_materials: 'Tìm học liệu',
  get_practice_quiz: 'Tìm bài luyện tập',
  queue_flashcards: 'Thêm thẻ vào lịch ôn',
};
const SUGGESTIONS = [
  'Mình nên ôn gì cho bài kiểm tra sắp tới?',
  'Mình đang yếu phần nào?',
  'Lập kế hoạch học 30 phút hôm nay giúp mình',
  'Đưa các câu mình hay sai vào thẻ ôn',
];

function loadMsgs(): Msg[] {
  try { return JSON.parse(storage.get(KEY) || '[]'); } catch { return []; }
}

function sourceText(s: Source) {
  if (s.source_type === 'video') return `${s.label} · ${s.display} · tua tới ${fmtTime(s.start_time)}`;
  if (s.page) return `${s.label} · ${s.document_title || 'Tài liệu'} · trang ${s.page}`;
  return `${s.label} · ${s.display}`;
}

/** Trợ lý học tập: agent tự xem tiến độ, câu hay sai, thẻ đến hạn, học liệu rồi lập kế hoạch ôn có nút bấm. */
export function Coach() {
  const toast = useToast();
  const [msgs, setMsgs] = useState<Msg[]>(loadMsgs);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { storage.set(KEY, JSON.stringify(msgs.slice(-20))); }, [msgs]);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); }, [msgs, busy]);

  const send = async (raw?: string) => {
    const message = (raw ?? text).trim();
    if (!message || busy) return;
    const history = msgs.filter((m) => !m.error).slice(-8).map((m) => ({ role: m.role, content: m.content }));
    setMsgs((m) => [...m, { role: 'user', content: message }]);
    setText('');
    setBusy(true);
    try {
      const res = await api<CoachResponse>('/ai/coach/chat', { json: { message, history } });
      setMsgs((m) => [...m, { role: 'assistant', content: res.answer, res }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: errorText(e), error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const openSource = async (s: Source) => {
    try {
      if (s.source_type === 'video' && s.source_id) {
        const loc = await api<{ lesson_id: string; item_id: string }>(`/ai/learn/locate?video_id=${encodeURIComponent(s.source_id)}`);
        navigate(`/lesson/${loc.lesson_id}/${loc.item_id}?t=${Math.floor(s.start_time || 0)}`);
      } else if (s.document_id) {
        const loc = await api<{ lesson_id: string; item_id: string }>(`/ai/learn/locate?document_id=${s.document_id}`);
        navigate(`/lesson/${loc.lesson_id}/${loc.item_id}${s.page ? `?page=${s.page}` : ''}`);
      }
    } catch (e) {
      toast('Nguồn này không nằm trong mục học nào: ' + errorText(e), 'error');
    }
  };

  const runAction = (a: CoachAction) => {
    if (a.type === 'flashcards' && a.lesson_code) navigate(`/flashcards/${encodeURIComponent(a.lesson_code)}`);
    else if (a.item_id && a.lesson_id) navigate(`/lesson/${a.lesson_id}/${a.item_id}`);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className="coach-page">
      <PageHeader title="Trợ lý học tập" sub="Trợ lý xem tiến độ, các câu bạn hay sai và thẻ đến hạn của bạn, rồi lập kế hoạch ôn."
        actions={msgs.length > 0 ? <Button variant="soft" size="sm" icon="plus" onClick={() => setMsgs([])}>Cuộc trò chuyện mới</Button> : undefined} />
      <div className="coach">
        <div className="tutor-msgs" ref={listRef}>
          {msgs.length === 0 && !busy && (
            <div className="empty" style={{ padding: '24px 8px' }}>
              <Mascot size={88} mood="wave" />
              <strong>Hôm nay mình ôn gì nhỉ?</strong>
              <span>Mình dùng dữ liệu học tập thật của bạn để gợi ý. Mình không nói đáp án bài kiểm tra.</span>
            </div>
          )}
          {msgs.map((m, i) => m.role === 'user' ? (
            <div key={i} className="bubble-user">{m.content}</div>
          ) : (
            <div key={i} className={`bubble-bot ${m.res?.guarded ? 'bubble-hint' : ''}`}
              style={m.error ? { borderColor: 'var(--red-line)', color: 'var(--red-text)' } : undefined}>
              {!!m.res?.steps.length && (
                <div className="coach-steps" aria-label="Các bước trợ lý đã làm">
                  {m.res.steps.map((s, j) => (
                    <span key={j} className={`coach-step ${s.ok ? '' : 'coach-step-fail'}`} title={s.arguments}>
                      <Icon name={s.ok ? (s.writes ? 'edit' : 'check') : 'x'} size={12} /> {TOOL_LABEL[s.tool] || s.tool}
                    </span>
                  ))}
                </div>
              )}
              <Markdown source={m.content} />
              {!!m.res?.sources.length && (
                <div className="src-chips">
                  {m.res.sources.map((s) => (
                    <button key={s.label} className="src" onClick={() => openSource(s)} title={s.display}>
                      <Icon name={s.source_type === 'video' ? 'play' : s.page ? 'slide' : 'book'} size={14} />
                      <span>{sourceText(s)}</span>
                    </button>
                  ))}
                </div>
              )}
              {!!m.res?.actions.length && (
                <div className="coach-actions">
                  {m.res.actions.map((a, j) => (
                    <Button key={j} size="sm" variant={a.type === 'flashcards' ? 'blue' : 'green'}
                      icon={a.type === 'flashcards' ? 'copy' : 'play'} onClick={() => runAction(a)}>{a.label}</Button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {busy && <div className="bubble-bot" style={{ alignSelf: 'flex-start' }}><span className="typing" aria-label="Trợ lý đang xem dữ liệu"><i /><i /><i /></span></div>}
        </div>
        {!busy && msgs.length < 2 && (
          <div className="tutor-sugg">{SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => send(s)}>{s}</button>)}</div>
        )}
        <form className="tutor-form" onSubmit={(e) => { e.preventDefault(); send(); }} aria-label="Gửi tin cho trợ lý">
          <label className="sr-only" htmlFor="coach-input">Tin nhắn cho trợ lý học tập</label>
          <textarea id="coach-input" rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
            placeholder="Ví dụ: Mai kiểm tra chương 1, giúp mình ôn" />
          <button type="submit" className="send" aria-label="Gửi" disabled={busy || !text.trim()}><Icon name="send" size={22} stroke={2.6} /></button>
        </form>
        <p className="tutor-foot">Trợ lý dựa trên tiến độ và học liệu của bạn, có thể sai. Hãy đối chiếu với bài giảng.</p>
      </div>
    </div>
  );
}
