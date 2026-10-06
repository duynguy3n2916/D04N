import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, ApiError, errorText, fmtTime, storage, type ChatResponse, type Source, type TutorQuota } from '../lib/api';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { Mascot } from './Mascot';
import { IconButton } from './ui';

export interface TutorContext {
  label: string;
  videoId?: string;
  getVideoTime?: () => number;
  focusDocumentId?: string | null;
  focusPage?: number | null;
  suggestions?: string[];
}

interface Msg { role: 'user' | 'assistant'; content: string; sources?: Source[]; hint?: boolean; refused?: boolean; quote?: string; error?: boolean }

function sourceText(s: Source) {
  if (s.source_type === 'video') return `${s.label} · tua tới ${fmtTime(s.start_time)}`;
  if (s.source_type === 'selection') return `${s.label} · đoạn đang chọn`;
  if (s.page) return `${s.label} · ${s.document_title || 'Tài liệu'} · trang ${s.page}`;
  return `${s.label} · ${s.display}`;
}

export function TutorPanel({ lessonCode, context, quote, onClearQuote, onSource, onClose }: {
  lessonCode: string;
  context: TutorContext;
  quote: string | null;
  onClearQuote: () => void;
  onSource: (s: Source) => void;
  onClose: () => void;
}) {
  const convKey = `mam.conv.${lessonCode}`;
  const [convId, setConvId] = useState<string | null>(storage.get(convKey));
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [quota, setQuota] = useState<TutorQuota | null>(null);
  const [history, setHistory] = useState<{ conversation_id: string; created_at: string; lesson_id: string }[] | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // khôi phục cuộc trò chuyện gần nhất của bài
  useEffect(() => {
    if (!convId) { setMsgs([]); return; }
    let alive = true;
    api<{ messages: { role: 'user' | 'assistant'; content: string; sources: Source[] | null; meta: any }[] }>(`/ai/conversations/${convId}`)
      .then((c) => alive && setMsgs(c.messages.map((m) => ({ role: m.role, content: m.content, sources: m.sources || undefined,
        hint: !!m.meta?.hint_mode, refused: !!m.meta?.refused }))))
      .catch(() => { if (alive) { setConvId(null); storage.set(convKey, null); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId]);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); }, [msgs, busy]);

  // số lượt hỏi còn lại cho bài này hôm nay
  useEffect(() => {
    let alive = true;
    api<{ quota: TutorQuota | null }>(`/ai/chat/quota?lesson_id=${encodeURIComponent(lessonCode)}`)
      .then((r) => alive && setQuota(r.quota)).catch(() => {});
    return () => { alive = false; };
  }, [lessonCode]);
  useEffect(() => { if (quote) inputRef.current?.focus(); }, [quote]);

  const send = async (raw?: string) => {
    const question = (raw ?? text).trim() || (quote ? 'Giải thích giúp mình đoạn này.' : '');
    if (!question || busy) return;
    if (quota && quota.remaining <= 0) return;
    const q = quote;
    setMsgs((m) => [...m, { role: 'user', content: question, quote: q || undefined }]);
    setText('');
    onClearQuote();
    setBusy(true);
    try {
      const r = await api<ChatResponse>('/ai/chat', { json: {
        question, conversation_id: convId, lesson_id: lessonCode,
        video_id: context.videoId || null,
        video_time: context.getVideoTime ? Math.floor(context.getVideoTime()) : null,
        focus_document_id: context.focusDocumentId || null, focus_page: context.focusPage || null,
        selected_text: q || null,
      } });
      if (r.conversation_id !== convId) { setConvId(r.conversation_id); storage.set(convKey, r.conversation_id); }
      setMsgs((m) => [...m, { role: 'assistant', content: r.answer, sources: r.sources, hint: r.hint_mode, refused: r.refused }]);
      if (r.quota) setQuota(r.quota);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TUTOR_QUOTA_EXCEEDED') {
        if (e.details) setQuota(e.details as TutorQuota);
        setMsgs((m) => [...m, { role: 'assistant', content: e.message, hint: true }]);
      } else {
        setMsgs((m) => [...m, { role: 'assistant', content: errorText(e), error: true }]);
      }
    } finally {
      setBusy(false);
    }
  };

  const newChat = () => { setConvId(null); storage.set(convKey, null); setMsgs([]); setHistory(null); };
  const openHistory = async () => {
    if (history) { setHistory(null); return; }
    try {
      const rows = await api<{ conversation_id: string; created_at: string; lesson_id: string }[]>('/ai/conversations');
      setHistory(rows.filter((r) => r.lesson_id === lessonCode));
    } catch { setHistory([]); }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <aside className="tutor" aria-label="Tutor AI">
      <div className="tutor-head">
        <Mascot size={34} />
        <strong>Tutor AI</strong>
        <IconButton icon="plus" label="Cuộc trò chuyện mới" onClick={newChat} />
        <IconButton icon="history" label="Lịch sử trò chuyện" onClick={openHistory} active={!!history} />
        <IconButton icon="x" label="Đóng Tutor" onClick={onClose} />
      </div>
      <div className="tutor-ctx">
        <span>Đang xem: <b>{context.label}</b></span>
        {quota && <span className={`quota-pill ${quota.remaining === 0 ? 'quota-out' : quota.remaining <= 5 ? 'quota-low' : ''}`}
          title="Số lượt hỏi Tutor còn lại cho bài này hôm nay">{quota.remaining}/{quota.limit} lượt hỏi</span>}
      </div>
      {history && (
        <div className="col" style={{ padding: 12, gap: 6, borderBottom: '2px solid var(--line)' }}>
          <strong className="small">Các cuộc trò chuyện của bài này</strong>
          {history.length === 0 && <span className="muted small">Chưa có.</span>}
          {history.map((h) => (
            <button key={h.conversation_id} className="chip" onClick={() => { setConvId(h.conversation_id); storage.set(convKey, h.conversation_id); setHistory(null); }}>
              {new Date(h.created_at).toLocaleString('vi-VN')}
            </button>
          ))}
        </div>
      )}
      <div className="tutor-msgs" ref={listRef}>
        {msgs.length === 0 && !busy && (
          <div className="empty" style={{ padding: '24px 8px' }}>
            <Mascot size={88} mood="wave" />
            <strong>Hỏi mình bất cứ điều gì về bài này</strong>
            <span>Mình trả lời dựa trên video, slide và bài đọc của bài, kèm nguồn để bạn xem lại.</span>
          </div>
        )}
        {msgs.map((m, i) => m.role === 'user' ? (
          <div key={i} className="bubble-user">{m.quote && <span className="bubble-quote">“{m.quote.slice(0, 160)}{m.quote.length > 160 ? '…' : ''}”</span>}{m.content}</div>
        ) : (
          <div key={i} className={`bubble-bot ${m.hint ? 'bubble-hint' : ''}`} style={m.error ? { borderColor: 'var(--red-line)', color: 'var(--red-text)' } : undefined}>
            {m.hint && <span className="bubble-kicker">Chế độ gợi ý · bạn đang làm bài</span>}
            <Markdown source={m.content} />
            {!!m.sources?.length && (
              <div className="src-chips">
                {m.sources.map((s) => (
                  <button key={s.label} className="src" onClick={() => onSource(s)} title={s.display}>
                    <Icon name={s.source_type === 'video' ? 'play' : s.page ? 'slide' : 'book'} size={14} />
                    <span>{sourceText(s)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="bubble-bot" style={{ alignSelf: 'flex-start' }}><span className="typing" aria-label="Tutor đang trả lời"><i /><i /><i /></span></div>}
      </div>
      {!busy && quota?.remaining !== 0 && (context.suggestions?.length ?? 0) > 0 && msgs.length < 2 && (
        <div className="tutor-sugg">{context.suggestions!.map((s) => <button key={s} className="chip" onClick={() => send(s)}>{s}</button>)}</div>
      )}
      {quote && (
        <div className="tutor-quote"><Icon name="note" size={16} /><span>“{quote}”</span>
          <button className="iconbtn" style={{ width: 24, height: 24 }} aria-label="Bỏ đoạn trích" onClick={onClearQuote}><Icon name="x" size={14} /></button>
        </div>
      )}
      <form className="tutor-form" onSubmit={(e) => { e.preventDefault(); send(); }} aria-label="Gửi câu hỏi cho Tutor">
        <label className="sr-only" htmlFor="tutor-input">Câu hỏi cho Tutor</label>
        <textarea id="tutor-input" ref={inputRef} rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
          disabled={quota?.remaining === 0}
          placeholder={quota?.remaining === 0 ? 'Đã hết lượt hỏi hôm nay' : quote ? 'Hỏi về đoạn đã chọn…' : 'Hỏi về nội dung đang xem…'} />
        <button type="submit" className="send" aria-label="Gửi" disabled={busy || quota?.remaining === 0 || (!text.trim() && !quote)}><Icon name="send" size={22} stroke={2.6} /></button>
      </form>
      <p className="tutor-foot">Tutor chỉ dùng tài liệu của bài và có thể sai — hãy đối chiếu với bài giảng.</p>
    </aside>
  );
}
