import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { useConfirm, useToast } from '../components/ui';
import { api, errorText, fmtTime, storage, type Source } from '../lib/api';
import { useAuth } from '../lib/auth';
import { navigate } from '../lib/router';

interface CoachStep { tool: string; arguments: string; ok: boolean; writes: boolean }
interface CoachAction { type: 'item' | 'flashcards'; label: string; item_id?: string; lesson_id?: string; lesson_code?: string }
interface CoachResult { answer: string; steps: CoachStep[]; sources: Source[]; actions: CoachAction[]; guarded: boolean; stopped: string | null }
interface ConvSummary { id: string; title: string; created_at: string; updated_at: string }
interface ChatResponse extends CoachResult { llm_calls: number; conversation: ConvSummary }
interface Msg { role: 'user' | 'assistant'; content: string; res?: CoachResult | null; error?: boolean }

const SIDE_KEY = 'mam.coach.side';
const TOOL_LABEL: Record<string, string> = {
  get_progress: 'Xem tiến độ',
  get_weak_points: 'Tìm câu hay sai',
  get_due_flashcards: 'Kiểm tra thẻ đến hạn',
  search_materials: 'Tìm học liệu',
  get_practice_quiz: 'Tìm bài luyện tập',
  queue_flashcards: 'Thêm thẻ vào lịch ôn',
};
const SUGGESTIONS: { icon: IconName; title: string; text: string }[] = [
  { icon: 'list', title: 'Ôn cho bài kiểm tra', text: 'Mình nên ôn gì cho bài kiểm tra sắp tới?' },
  { icon: 'chart', title: 'Tìm phần còn yếu', text: 'Mình đang yếu phần nào?' },
  { icon: 'clock', title: 'Kế hoạch 30 phút', text: 'Lập kế hoạch học 30 phút hôm nay giúp mình' },
  { icon: 'copy', title: 'Đưa câu sai vào thẻ ôn', text: 'Đưa các câu mình hay sai vào thẻ ôn' },
];
const THINKING = ['Đang xem tiến độ của bạn', 'Đang tìm các câu bạn hay sai', 'Đang lập kế hoạch ôn'];

function sourceText(s: Source) {
  if (s.source_type === 'video') return `${s.label} · ${s.display} · ${fmtTime(s.start_time)}`;
  if (s.page) return `${s.label} · ${s.document_title || 'Tài liệu'} · trang ${s.page}`;
  return `${s.label} · ${s.display}`;
}

function groupOf(iso: string): string {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.floor((today.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  if (days <= 0) return 'Hôm nay';
  if (days === 1) return 'Hôm qua';
  if (days < 7) return '7 ngày qua';
  if (days < 30) return '30 ngày qua';
  return 'Cũ hơn';
}

/** Trợ lý học tập kiểu ChatGPT/Claude: lịch sử trò chuyện bên trái, khung chat ở giữa, chat tiếp được cuộc cũ. */
export function Coach({ conversationId }: { conversationId?: string }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const [convs, setConvs] = useState<ConvSummary[] | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [loadingConv, setLoadingConv] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(0);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [sideOpen, setSideOpen] = useState(() => storage.get(SIDE_KEY) !== '0');
  const [drawer, setDrawer] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const justCreated = useRef<string | null>(null);

  const firstName = (user?.display_name || user?.name || '').trim().split(/\s+/).pop() || '';
  const active = convs?.find((c) => c.id === conversationId);

  useEffect(() => {
    api<ConvSummary[]>('/ai/coach/conversations').then(setConvs).catch((e) => { setConvs([]); toast(errorText(e), 'error'); });
  }, []);

  useEffect(() => {
    setDrawer(false);
    setEditing(null);
    if (!conversationId) { setMsgs([]); inputRef.current?.focus(); return; }
    if (justCreated.current === conversationId) { justCreated.current = null; return; }
    let alive = true;
    setLoadingConv(true);
    api<{ messages: Msg[] }>(`/ai/coach/conversations/${conversationId}`)
      .then((d) => { if (alive) setMsgs(d.messages.map((m) => ({ role: m.role, content: m.content, res: m.res }))); })
      .catch((e) => { if (alive) { toast(errorText(e), 'error'); navigate('/coach', true); } })
      .finally(() => { if (alive) { setLoadingConv(false); inputRef.current?.focus(); } });
    return () => { alive = false; };
  }, [conversationId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: msgs.length > 2 ? 'smooth' : 'auto' });
  }, [msgs, busy]);

  useEffect(() => {
    if (!busy) return;
    setThinking(0);
    const t = window.setInterval(() => setThinking((i) => (i + 1) % THINKING.length), 2200);
    return () => window.clearInterval(t);
  }, [busy]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [text]);

  const toggleSide = () => {
    if (window.matchMedia('(max-width: 900px)').matches) { setDrawer((v) => !v); return; }
    setSideOpen((v) => { storage.set(SIDE_KEY, v ? '0' : '1'); return !v; });
  };

  const send = async (raw?: string, retry = false) => {
    const message = (raw ?? text).trim();
    if (!message || busy) return;
    setMsgs((m) => retry ? [...m.slice(0, -1)] : [...m, { role: 'user', content: message }]);
    if (!retry) setText('');
    setBusy(true);
    try {
      const res = await api<ChatResponse>('/ai/coach/chat', { json: { message, conversation_id: conversationId || null } });
      setMsgs((m) => [...m, { role: 'assistant', content: res.answer, res }]);
      const conv = res.conversation;
      setConvs((list) => [conv, ...(list || []).filter((c) => c.id !== conv.id)]);
      if (!conversationId) { justCreated.current = conv.id; navigate(`/coach/${conv.id}`, true); }
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: errorText(e), error: true }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');

  const saveTitle = async () => {
    if (!editing) return;
    const { id, title } = editing;
    setEditing(null);
    const old = convs?.find((c) => c.id === id);
    if (!title.trim() || title.trim() === old?.title) return;
    try {
      const c = await api<ConvSummary>(`/ai/coach/conversations/${id}`, { method: 'PATCH', json: { title } });
      setConvs((list) => (list || []).map((x) => (x.id === id ? { ...x, title: c.title } : x)));
    } catch (e) { toast(errorText(e), 'error'); }
  };

  const remove = async (c: ConvSummary) => {
    if (!await confirm(`Xóa cuộc trò chuyện "${c.title}"? Không khôi phục được.`, { title: 'Xóa cuộc trò chuyện', okLabel: 'Xóa', danger: true })) return;
    try {
      await api(`/ai/coach/conversations/${c.id}`, { method: 'DELETE' });
      setConvs((list) => (list || []).filter((x) => x.id !== c.id));
      if (c.id === conversationId) navigate('/coach', true);
    } catch (e) { toast(errorText(e), 'error'); }
  };

  const copy = async (s: string) => {
    try { await navigator.clipboard.writeText(s); toast('Đã chép câu trả lời', 'success'); }
    catch { toast('Không chép được', 'error'); }
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
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: { label: string; items: ConvSummary[] }[] = [];
    for (const c of convs || []) {
      if (q && !c.title.toLowerCase().includes(q)) continue;
      const label = groupOf(c.updated_at);
      const g = out.find((x) => x.label === label);
      if (g) g.items.push(c); else out.push({ label, items: [c] });
    }
    return out;
  }, [convs, query]);

  const empty = !conversationId && msgs.length === 0 && !busy;

  const composer = (
    <form className="cc-composer" onSubmit={(e) => { e.preventDefault(); send(); }} aria-label="Gửi tin cho trợ lý">
      <label className="sr-only" htmlFor="coach-input">Tin nhắn cho trợ lý học tập</label>
      <textarea id="coach-input" ref={inputRef} rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
        placeholder={empty ? 'Hỏi trợ lý, ví dụ: Mai kiểm tra chương 1, giúp mình ôn' : 'Nhắn tiếp cho trợ lý…'} autoFocus />
      <button type="submit" className="cc-send" aria-label="Gửi" disabled={busy || !text.trim()}>
        <Icon name="send" size={18} stroke={2.4} />
      </button>
    </form>
  );

  return (
    <div className={`cc ${sideOpen ? '' : 'cc-side-closed'} ${drawer ? 'cc-drawer-open' : ''}`}>
      <div className="cc-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />
      <aside className="cc-side" aria-label="Lịch sử trò chuyện">
        <div className="cc-side-head">
          <span className="cc-side-title">Lịch sử</span>
          <button type="button" className="cc-icon" onClick={toggleSide} aria-label="Ẩn lịch sử" title="Ẩn lịch sử"><Icon name="x" size={18} /></button>
        </div>
        <button type="button" className="cc-new" onClick={() => navigate('/coach')}>
          <Icon name="edit" size={18} /> Cuộc trò chuyện mới
        </button>
        <div className="cc-search">
          <Icon name="search" size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm cuộc trò chuyện" aria-label="Tìm cuộc trò chuyện" />
        </div>
        <nav className="cc-list">
          {convs === null && <div className="cc-list-note">Đang tải…</div>}
          {convs?.length === 0 && <div className="cc-list-note">Chưa có cuộc trò chuyện nào. Hỏi trợ lý một câu để bắt đầu.</div>}
          {convs && convs.length > 0 && groups.length === 0 && <div className="cc-list-note">Không tìm thấy.</div>}
          {groups.map((g) => (
            <div key={g.label} className="cc-group">
              <div className="cc-group-label">{g.label}</div>
              {g.items.map((c) => editing?.id === c.id ? (
                <input key={c.id} className="cc-rename" autoFocus value={editing.title} maxLength={200}
                  onChange={(e) => setEditing({ id: c.id, title: e.target.value })} onBlur={saveTitle}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') setEditing(null); }}
                  aria-label="Tên cuộc trò chuyện" />
              ) : (
                <div key={c.id} className={`cc-item ${c.id === conversationId ? 'cc-item-on' : ''}`}>
                  <button type="button" className="cc-item-title" onClick={() => navigate(`/coach/${c.id}`)} title={c.title}
                    aria-current={c.id === conversationId ? 'page' : undefined}>{c.title}</button>
                  <span className="cc-item-tools">
                    <button type="button" onClick={() => setEditing({ id: c.id, title: c.title })} aria-label="Đổi tên" title="Đổi tên"><Icon name="edit" size={15} /></button>
                    <button type="button" onClick={() => remove(c)} aria-label="Xóa" title="Xóa"><Icon name="trash" size={15} /></button>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <section className="cc-main">
        <header className="cc-top">
          <button type="button" className="cc-icon cc-toggle" onClick={toggleSide} aria-label="Lịch sử trò chuyện" title="Lịch sử trò chuyện">
            <Icon name="history" size={20} />
          </button>
          <span className="cc-top-title">{active?.title || 'Trợ lý học tập'}</span>
          {!empty && <button type="button" className="cc-icon" onClick={() => navigate('/coach')} aria-label="Cuộc trò chuyện mới" title="Cuộc trò chuyện mới"><Icon name="edit" size={19} /></button>}
        </header>

        {empty ? (
          <div className="cc-hero">
            <span className="cc-hero-mark" aria-hidden="true"><Icon name="sparkle" size={28} /></span>
            <h1>{firstName ? `Chào ${firstName}, hôm nay mình ôn gì?` : 'Hôm nay mình ôn gì nhỉ?'}</h1>
            <p>Trợ lý xem tiến độ, các câu bạn hay sai và thẻ đến hạn của bạn, rồi lập kế hoạch ôn. Trợ lý không nói đáp án bài kiểm tra.</p>
            {composer}
            <div className="cc-sugg">
              {SUGGESTIONS.map((s) => (
                <button key={s.text} type="button" className="cc-sugg-card" onClick={() => send(s.text)}>
                  <Icon name={s.icon} size={18} />
                  <span><strong>{s.title}</strong><small>{s.text}</small></span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="cc-scroll" ref={scrollRef} aria-live="polite">
              <div className="cc-thread">
                {loadingConv && <div className="cc-loading"><span className="typing" aria-label="Đang tải"><i /><i /><i /></span></div>}
                {!loadingConv && msgs.map((m, i) => m.role === 'user' ? (
                  <div key={i} className="cc-msg cc-msg-user"><div className="cc-bubble">{m.content}</div></div>
                ) : (
                  <div key={i} className={`cc-msg cc-msg-bot ${m.error ? 'cc-msg-error' : ''} ${m.res?.guarded ? 'cc-msg-guard' : ''}`}>
                    <span className="cc-avatar" aria-hidden="true"><Icon name={m.error ? 'x' : 'sparkle'} size={16} /></span>
                    <div className="cc-body">
                      {!!m.res?.steps?.length && (
                        <details className="cc-steps">
                          <summary>Đã dùng {m.res.steps.length} công cụ: {[...new Set(m.res.steps.map((s) => TOOL_LABEL[s.tool] || s.tool))].join(', ')}</summary>
                          <div className="cc-step-list">
                            {m.res.steps.map((s, j) => (
                              <span key={j} className={`cc-step ${s.ok ? '' : 'cc-step-fail'}`} title={s.arguments}>
                                <Icon name={s.ok ? (s.writes ? 'edit' : 'check') : 'x'} size={12} /> {TOOL_LABEL[s.tool] || s.tool}
                              </span>
                            ))}
                          </div>
                        </details>
                      )}
                      {m.error ? <p>{m.content}</p> : <Markdown source={m.content} />}
                      {!!m.res?.sources?.length && (
                        <div className="cc-sources">
                          {m.res.sources.map((s) => (
                            <button key={s.label} type="button" className="src" onClick={() => openSource(s)} title={s.display}>
                              <Icon name={s.source_type === 'video' ? 'play' : s.page ? 'slide' : 'book'} size={14} />
                              <span>{sourceText(s)}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {!!m.res?.actions?.length && (
                        <div className="cc-actions">
                          {m.res.actions.map((a, j) => (
                            <button key={j} type="button" className="cc-action" onClick={() => runAction(a)}>
                              <Icon name={a.type === 'flashcards' ? 'copy' : 'play'} size={15} /> {a.label}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="cc-tools">
                        {m.error ? (
                          i === msgs.length - 1 && lastUser && <button type="button" onClick={() => send(lastUser.content, true)} disabled={busy}><Icon name="refresh" size={15} /> Thử lại</button>
                        ) : (
                          <button type="button" onClick={() => copy(m.content)} aria-label="Chép câu trả lời" title="Chép"><Icon name="copy" size={15} /></button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                {busy && (
                  <div className="cc-msg cc-msg-bot">
                    <span className="cc-avatar cc-avatar-busy" aria-hidden="true"><Icon name="sparkle" size={16} /></span>
                    <div className="cc-body cc-thinking">{THINKING[thinking]}<span className="typing" aria-hidden="true"><i /><i /><i /></span></div>
                  </div>
                )}
              </div>
            </div>
            <div className="cc-bottom">
              {composer}
              <p className="cc-foot">Trợ lý dựa trên tiến độ và học liệu của bạn, có thể sai. Hãy đối chiếu với bài giảng.</p>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
