import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { Avatar, timeAgo } from '../components/Social';
import { Badge, Button, confirmDialog, Empty, ErrorBox, Modal, Spinner, useToast } from '../components/ui';
import { api, ApiError, errorText, getToken, mediaUrl } from '../lib/api';
import { useAsync, useInterval } from '../lib/hooks';
import { refreshNotifications } from '../lib/notifications';
import { Link, navigate } from '../lib/router';
import { openDirect, ReportDialog } from './Forum';

interface Conversation { conversation_id: string; other_id: string; other_name: string; last_message: string; last_at: string | null; unread: number; blocked: boolean }
export interface Message {
  message_id: string; sender_id: string; mine: boolean; body: string; hidden: boolean; created_at: string | null;
  kind?: 'text' | 'image' | 'video' | 'audio'; url?: string | null; mime?: string | null; duration?: number | null;
}
interface Thread { conversation_id: string; other_id: string; other_name: string; blocked: boolean; blocked_by_me: boolean; other_read_at?: string | null; messages: Message[] }

/** Tin nhắn riêng giữa các thành viên cùng lớp. Giáo viên chỉ xem được tin nhắn bị báo cáo. */
export function Messages({ conversationId }: { conversationId?: string }) {
  const list = useAsync((s) => api<Conversation[]>('/ai/messages/conversations', { signal: s }), [], 'dm/list');
  const [picking, setPicking] = useState(false);
  useInterval(list.reload, 20_000);
  return (
    <>
      <PageHeader title="Tin nhắn" sub="Nhắn riêng với bạn cùng lớp. Hãy lịch sự; tin nhắn bị báo cáo sẽ được giáo viên xem xét."
        actions={<Button size="sm" icon="plus" onClick={() => setPicking(true)}>Tin nhắn mới</Button>} />
      <div className={`dm-layout ${conversationId ? 'dm-has-open' : ''} ${!conversationId && list.data && !list.data.length ? 'dm-none' : ''}`}>
        <aside className="card dm-list" aria-label="Cuộc trò chuyện">
          {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorBox message={list.error} onRetry={list.reload} /> : !list.data?.length ? (
            <div className="muted small" style={{ padding: 8 }}>Chưa có cuộc trò chuyện nào. Chọn một người trong lớp để bắt đầu.</div>
          ) : list.data.map((c) => (
            <button key={c.conversation_id} className={`dm-item ${c.conversation_id === conversationId ? 'on' : ''}`} onClick={() => navigate(`/messages/${c.conversation_id}`)}>
              <Avatar name={c.other_name} id={c.other_id} size={40} />
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  <strong className="dm-name">{c.other_name}</strong>
                  {c.blocked && <Icon name="ban" size={14} label="Đã chặn" />}
                  <span className="muted small" style={{ marginLeft: 'auto', flex: 'none' }}>{timeAgo(c.last_at)}</span>
                </span>
                <span className={`dm-last ${c.unread ? 'dm-unread' : ''}`}>{c.last_message || 'Chưa có tin nhắn'}</span>
              </span>
              {c.unread > 0 && <span className="nav-badge" aria-label={`${c.unread} tin chưa đọc`}>{c.unread}</span>}
            </button>
          ))}
        </aside>
        <section className="card dm-chat">
          {conversationId ? <Chat key={conversationId} conversationId={conversationId} conv={list.data?.find((c) => c.conversation_id === conversationId)} onChange={list.reload} />
            : <div className="dm-start"><h2 className="dm-start-title">Bắt đầu trò chuyện</h2><p className="muted small">Chọn lớp, giáo viên hay học sinh, rồi bấm vào tên.</p><ContactPicker /></div>}
        </section>
      </div>
      {picking && <MemberPicker onClose={() => setPicking(false)} />}
    </>
  );
}

type Kind = 'text' | 'image' | 'video' | 'audio';
interface Pending { id: string; kind: Kind; body: string; file?: File; localUrl?: string; duration?: number; progress: number; error?: string }

const LIMIT_MB: Record<string, number> = { image: 10, video: 50, audio: 10 };
const kindOf = (f: File): Kind | null => f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'video' : f.type.startsWith('audio/') ? 'audio' : null;
const fmtDur = (s: number | null | undefined) => {
  if (s == null || !isFinite(s)) return '0:00';
  const n = Math.max(0, Math.round(s));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
};
const pad = (n: number) => String(n).padStart(2, '0');
/** Mốc giờ giữa các cụm tin nhắn, kiểu Messenger: "14:05", "Hôm qua 09:12", "Th 3 20:30", "12/11/2026 08:00". */
function fmtStamp(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return hm;
  if (diff === 1) return `Hôm qua ${hm}`;
  if (diff < 7) return `${['CN', 'Th 2', 'Th 3', 'Th 4', 'Th 5', 'Th 6', 'Th 7'][d.getDay()]} ${hm}`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${hm}`;
}
const gapMs = (a: string | null, b: string | null) => (a && b ? new Date(b).getTime() - new Date(a).getTime() : 0);

/** Tải file lên bằng XHR để có phần trăm tiến độ (fetch chưa báo được tiến độ upload). */
function uploadForm<T>(path: string, form: FormData, onProgress: (p: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    const tk = getToken();
    if (tk) xhr.setRequestHeader('Authorization', `Bearer ${tk}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      let data: any = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* không phải JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T); else reject(new ApiError(xhr.status, data));
    };
    xhr.onerror = () => reject(new ApiError(0, { detail: 'Không kết nối được máy chủ.' }));
    xhr.send(form);
  });
}

function Chat({ conversationId, conv, onChange }: { conversationId: string; conv?: Conversation; onChange: () => void }) {
  const toast = useToast();
  const data = useAsync((s) => api<Thread>(`/ai/messages/conversations/${conversationId}`, { signal: s }), [conversationId], `dm/${conversationId}`);
  const [text, setText] = useState('');
  const [drafts, setDrafts] = useState<{ file: File; kind: Kind; url: string }[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [reporting, setReporting] = useState<Message | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const atBottom = useRef(true);
  const opened = useRef(false);
  const t = data.data;
  useInterval(data.reload, 8_000);
  // mở / có tin mới thì server đã đánh dấu đã đọc: cập nhật số chưa đọc ở menu và danh sách hội thoại
  useEffect(() => { if (t) { refreshNotifications(); onChange(); } }, [t?.messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const toBottom = () => { if (box.current) box.current.scrollTop = box.current.scrollHeight; };
  // cuộn trước khi trình duyệt vẽ (useLayoutEffect) để không thấy khung nhảy từ đầu xuống cuối;
  // đang đọc tin cũ ở trên thì không kéo xuống, trừ khi chính mình vừa gửi
  const count = (t?.messages.length || 0) + pending.length;
  useLayoutEffect(() => {
    if (!t) return;
    const last = t.messages[t.messages.length - 1];
    if (!opened.current || atBottom.current || pending.length || last?.mine) toBottom();
    opened.current = true;
  }, [count, !!t]); // eslint-disable-line react-hooks/exhaustive-deps
  const onScroll = () => { const b = box.current; if (b) atBottom.current = b.scrollHeight - b.scrollTop - b.clientHeight < 120; };
  const onMediaLoad = () => { if (atBottom.current) toBottom(); };
  useEffect(() => { if (window.innerWidth > 760) input.current?.focus(); }, [conversationId]);
  useEffect(() => () => drafts.forEach((d) => URL.revokeObjectURL(d.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  // ô nhập tự cao lên theo nội dung (tối đa ~6 dòng) như các app chat
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
    // chỉ hiện thanh cuộn khi đã cao tối đa (tránh mũi tên cuộn ở cuối ô nhập 1 dòng)
    el.style.overflowY = el.scrollHeight > 150 ? 'auto' : 'hidden';
  }, [text]);

  const append = (m: Message) => data.setData((prev) => prev && !prev.messages.some((x) => x.message_id === m.message_id)
    ? { ...prev, messages: [...prev.messages, m] } : prev);

  const upload = async (p: Pending) => {
    setPending((ps) => ps.map((x) => (x.id === p.id ? { ...x, error: undefined, progress: 0 } : x)));
    try {
      let m: Message;
      if (p.kind === 'text') {
        const r = await api<{ message_id: string; created_at: string | null }>(`/ai/messages/conversations/${conversationId}`, { json: { body: p.body } });
        m = { message_id: r.message_id, sender_id: '', mine: true, body: p.body, hidden: false, kind: 'text', created_at: r.created_at };
      } else {
        const f = new FormData();
        f.append('file', p.file!);
        f.append('kind', p.kind);
        if (p.body) f.append('body', p.body);
        if (p.duration != null) f.append('duration', String(p.duration));
        m = await uploadForm<Message>(`/ai/messages/conversations/${conversationId}/files`, f,
          (pr) => setPending((ps) => ps.map((x) => (x.id === p.id ? { ...x, progress: pr } : x))));
      }
      append(m);
      setPending((ps) => ps.filter((x) => x.id !== p.id));
      if (p.localUrl) setTimeout(() => URL.revokeObjectURL(p.localUrl!), 4000);
      onChange();
    } catch (e) {
      setPending((ps) => ps.map((x) => (x.id === p.id ? { ...x, error: errorText(e) } : x)));
    }
  };
  const queue = (items: Omit<Pending, 'id' | 'progress'>[]) => {
    const ps = items.map((it) => ({ ...it, id: `p${Date.now()}-${Math.random().toString(36).slice(2)}`, progress: 0 }));
    setPending((old) => [...old, ...ps]);
    atBottom.current = true;
    // gửi lần lượt để tin đến đúng thứ tự
    (async () => { for (const p of ps) await upload(p); })();
  };

  const send = () => {
    const body = text.trim();
    if (!body && !drafts.length) return;
    queue([
      ...drafts.map((d) => ({ kind: d.kind, body: '', file: d.file, localUrl: d.url })),
      ...(body ? [{ kind: 'text' as Kind, body }] : []),
    ]);
    setDrafts([]);
    setText('');
    input.current?.focus();
  };
  const addFiles = (files: FileList | File[] | null) => {
    const list = Array.from(files || []);
    const ok: { file: File; kind: Kind; url: string }[] = [];
    for (const f of list) {
      const k = kindOf(f);
      if (!k || k === 'audio') { toast(`${f.name}: chỉ gửi được ảnh hoặc video`, 'error'); continue; }
      if (f.size > LIMIT_MB[k] * 1024 * 1024) { toast(`${f.name}: ${k === 'image' ? 'ảnh' : 'video'} tối đa ${LIMIT_MB[k]} MB`, 'error'); continue; }
      ok.push({ file: f, kind: k, url: URL.createObjectURL(f) });
    }
    if (ok.length) setDrafts((d) => [...d, ...ok].slice(0, 10));
  };
  const removeDraft = (i: number) => setDrafts((d) => { URL.revokeObjectURL(d[i].url); return d.filter((_, j) => j !== i); });
  const sendVoice = (file: File, seconds: number) => queue([{ kind: 'audio', body: '', file, localUrl: URL.createObjectURL(file), duration: seconds }]);

  const block = async (blocked: boolean) => {
    if (blocked && !await confirmDialog(`Chặn ${t?.other_name}? Hai bạn sẽ không nhắn tin cho nhau được cho đến khi bỏ chặn.`, { danger: true, okLabel: 'Chặn' })) return;
    try {
      await api('/ai/messages/blocks', { json: { user_id: t?.other_id, blocked } });
      toast(blocked ? 'Đã chặn' : 'Đã bỏ chặn', 'success');
      data.reload();
      onChange();
    } catch (e) { toast(errorText(e), 'error'); }
  };

  const name = t?.other_name || conv?.other_name || '';
  const otherId = t?.other_id || conv?.other_id || '';
  const msgs = t?.messages || [];
  const lastMine = [...msgs].reverse().find((m) => m.mine);
  const seen = !!(lastMine && t?.other_read_at && lastMine.created_at && new Date(t.other_read_at) >= new Date(lastMine.created_at));
  const BREAK = 15 * 60_000;  // cách nhau quá 15 phút thì hiện mốc giờ ở giữa

  return (
    <div className={`dm-chat-inner ${dragging ? 'dm-dragging' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files') && !t?.blocked) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); if (!t?.blocked) addFiles(e.dataTransfer.files); }}>
      <header className="dm-chat-head">
        <button className="iconbtn dm-back" aria-label="Về danh sách" onClick={() => navigate('/messages')}><Icon name="chevronLeft" size={20} /></button>
        {name ? <Avatar name={name} id={otherId} size={40} /> : <span className="dm-avatar-ph" />}
        <span className="grow" style={{ minWidth: 0 }}><strong className="dm-name" style={{ display: 'block' }}>{name || ' '}</strong><span className="muted small">{otherId ? `@${otherId}` : ' '}</span></span>
        {t && <Button size="sm" variant="ghost" icon="ban" onClick={() => block(!t.blocked_by_me)}>{t.blocked_by_me ? 'Bỏ chặn' : 'Chặn'}</Button>}
      </header>
      <div ref={box} className="dm-messages" aria-live="polite" onScroll={onScroll}>
        {!t ? (data.error ? <ErrorBox message={data.error} onRetry={data.reload} /> : <div className="dm-loading"><Spinner /></div>) : <>
          <div className="dm-intro">
            <Avatar name={name} id={otherId} size={64} />
            <strong>{name}</strong>
            <span className="muted small">{msgs.length ? 'Tin nhắn riêng giữa hai bạn trong lớp' : 'Hãy gửi lời chào đầu tiên 👋'}</span>
          </div>
          {msgs.map((m, i) => {
            const prev = msgs[i - 1];
            const next = msgs[i + 1];
            const stamp = !prev || gapMs(prev.created_at, m.created_at) > BREAK;
            const first = stamp || prev.mine !== m.mine;
            const last = !next || next.mine !== m.mine || gapMs(m.created_at, next.created_at) > BREAK;
            return (
              <Fragment key={m.message_id}>
                {stamp && <div className="dm-stamp">{fmtStamp(m.created_at)}</div>}
                <div className={`dm-row ${m.mine ? 'mine' : ''} ${first ? 'first' : ''} ${last ? 'last' : ''}`}>
                  {!m.mine && <span className="dm-row-av">{last && <Avatar name={name} id={otherId} size={28} />}</span>}
                  <div className="dm-col" title={fmtStamp(m.created_at)}>
                    <MessageBody m={m} onOpen={setLightbox} onMediaLoad={onMediaLoad} />
                  </div>
                  {!m.mine && !m.hidden && <button className="dm-act" aria-label="Báo cáo tin nhắn" title="Báo cáo" onClick={() => setReporting(m)}><Icon name="flag" size={15} /></button>}
                </div>
                {m === lastMine && !pending.length && <div className="dm-status">{seen ? 'Đã xem' : 'Đã gửi'}</div>}
              </Fragment>
            );
          })}
          {pending.map((p, i) => (
            <div key={p.id} className={`dm-row mine dm-pending ${i === 0 ? 'first' : ''} ${i === pending.length - 1 ? 'last' : ''}`}>
              <div className="dm-col">
                <MessageBody m={{ message_id: p.id, sender_id: '', mine: true, body: p.body, hidden: false, kind: p.kind, url: p.localUrl, duration: p.duration, created_at: null }}
                  local onOpen={setLightbox} onMediaLoad={onMediaLoad} />
                <span className="dm-status">
                  {p.error ? <><span className="dm-err">Chưa gửi được: {p.error}</span> <button className="linkbtn small" onClick={() => upload(p)}>Thử lại</button> <button className="linkbtn small" onClick={() => setPending((ps) => ps.filter((x) => x.id !== p.id))}>Bỏ</button></>
                    : p.kind === 'text' ? 'Đang gửi…' : `Đang gửi ${p.progress}%`}
                </span>
              </div>
            </div>
          ))}
        </>}
      </div>
      {t?.blocked ? (
        <p className="muted small dm-blocked"><Badge tone="gray">Đã chặn</Badge> {t.blocked_by_me ? 'Bạn đã chặn người này.' : 'Bạn không thể nhắn cho người này.'}</p>
      ) : (
        <Composer text={text} setText={setText} input={input} fileInput={fileInput} drafts={drafts} disabled={!t}
          onFiles={addFiles} onRemoveDraft={removeDraft} onSend={send} onVoice={sendVoice} onError={(msg) => toast(msg, 'error')} />
      )}
      {dragging && <div className="dm-drop"><Icon name="image" size={36} /><strong>Thả ảnh hoặc video vào đây để gửi</strong></div>}
      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
      {reporting && (
        <ReportDialog title="Báo cáo tin nhắn" onClose={() => setReporting(null)} onSend={async (reason) => {
          const r = await api<{ duplicate: boolean }>(`/ai/messages/${reporting.message_id}/report`, { json: { reason } });
          return r.duplicate ? 'Bạn đã báo cáo tin nhắn này rồi' : 'Đã gửi báo cáo cho giáo viên (chỉ tin nhắn này được gửi)';
        }} />
      )}
    </div>
  );
}

/** Nội dung một tin: chữ, ảnh, video hay tin nhắn thoại (kèm chú thích nếu có). Dùng cả ở khung báo cáo của giáo viên. */
export function MessageBody({ m, local, onOpen, onMediaLoad }: { m: Message; local?: boolean; onOpen?: (src: string) => void; onMediaLoad?: () => void }) {
  const kind = m.kind || 'text';
  const src = m.url ? (local ? m.url : mediaUrl(m.url)) : '';
  if (kind === 'text' || !src) return <div className={`dm-bubble ${m.hidden ? 'dm-hidden' : ''}`}>{m.body}</div>;
  return (
    <>
      {kind === 'image' && (
        <button type="button" className="dm-media" onClick={() => onOpen?.(src)} aria-label="Xem ảnh">
          <img src={src} alt="Ảnh đã gửi" loading="lazy" onLoad={onMediaLoad} />
        </button>
      )}
      {kind === 'video' && <video className="dm-media dm-video" src={src} controls playsInline preload="metadata" onLoadedMetadata={onMediaLoad} />}
      {kind === 'audio' && <VoiceBubble src={src} duration={m.duration} mine={m.mine} />}
      {m.body && <div className="dm-bubble">{m.body}</div>}
    </>
  );
}

const BARS = 30;
/** Bong bóng tin nhắn thoại: nút phát, sóng âm (tô màu theo tiến độ, bấm để tua) và thời lượng. */
function VoiceBubble({ src, duration, mine }: { src: string; duration?: number | null; mine: boolean }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [len, setLen] = useState<number>(duration || 0);
  // sóng âm giả lập ổn định theo từng file (không cần phân tích âm thanh)
  const bars = useMemo(() => {
    let h = 0;
    for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) >>> 0;
    return Array.from({ length: BARS }, (_, i) => { h = (h * 1103515245 + 12345) >>> 0; return 0.3 + ((h >>> 16) % 70) / 100 * (i % 5 === 2 ? 1 : 0.85); });
  }, [src]);
  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) { document.querySelectorAll('audio').forEach((x) => { if (x !== a) x.pause(); }); a.play().catch(() => {}); } else a.pause();
  };
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = audio.current;
    if (!a || !len) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * len;
    setPos(a.currentTime);
  };
  const ratio = len ? Math.min(1, pos / len) : 0;
  return (
    <div className={`dm-voice ${mine ? 'mine' : ''}`}>
      <button type="button" className="dm-voice-play" onClick={toggle} aria-label={playing ? 'Tạm dừng' : 'Nghe tin nhắn thoại'}>
        <Icon name={playing ? 'pause' : 'play'} size={16} />
      </button>
      <div className="dm-wave" onClick={seek} role="presentation">
        {bars.map((b, i) => <span key={i} className={i / BARS < ratio ? 'on' : ''} style={{ height: `${Math.round(b * 100)}%` }} />)}
      </div>
      <span className="dm-voice-time">{fmtDur(playing || pos ? pos : len)}</span>
      <audio ref={audio} src={src} preload="metadata"
        onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (isFinite(d) && d > 0) setLen(d); }}
        onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setPos(0); }} />
    </div>
  );
}

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="dm-lightbox" onClick={onClose} role="dialog" aria-label="Xem ảnh">
      <button className="dm-lightbox-x" aria-label="Đóng" onClick={onClose}><Icon name="x" size={22} /></button>
      <img src={src} alt="" onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

const MAX_VOICE_SEC = 300;
function pickAudioMime() {
  const opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
  return typeof MediaRecorder !== 'undefined' ? opts.find((o) => MediaRecorder.isTypeSupported?.(o)) || '' : '';
}

/** Ô soạn tin kiểu Messenger: nút ảnh/video, ô nhập tự giãn, ảnh chờ gửi, nút gửi hoặc nút ghi âm khi ô trống. */
function Composer({ text, setText, input, fileInput, drafts, disabled, onFiles, onRemoveDraft, onSend, onVoice, onError }: {
  text: string; setText: (s: string) => void; input: React.RefObject<HTMLTextAreaElement | null>; fileInput: React.RefObject<HTMLInputElement | null>;
  drafts: { file: File; kind: Kind; url: string }[]; disabled: boolean;
  onFiles: (f: FileList | File[] | null) => void; onRemoveDraft: (i: number) => void; onSend: () => void;
  onVoice: (file: File, seconds: number) => void; onError: (msg: string) => void;
}) {
  const [rec, setRec] = useState<{ startedAt: number; elapsed: number } | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const keep = useRef(false);
  const timer = useRef<number | null>(null);
  const canSend = !!text.trim() || drafts.length > 0;

  const stopTimer = () => { if (timer.current) { clearInterval(timer.current); timer.current = null; } };
  useEffect(() => () => { stopTimer(); keep.current = false; recorder.current?.state === 'recording' && recorder.current.stop(); }, []);

  const startRec = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      onError('Trình duyệt không cho ghi âm ở địa chỉ này. Hãy mở trang bằng localhost hoặc https.');
      return;
    }
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {
      onError('Chưa có quyền dùng micro. Hãy cho phép micro trong trình duyệt rồi thử lại.');
      return;
    }
    const mime = pickAudioMime();
    const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    const startedAt = Date.now();
    r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    r.onstop = () => {
      stream.getTracks().forEach((tr) => tr.stop());
      stopTimer();
      setRec(null);
      const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
      if (!keep.current || seconds < 0.5 || !chunks.length) return;
      const type = (r.mimeType || mime || 'audio/webm').split(';')[0];
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      onVoice(new File(chunks, `tin-nhan-thoai.${ext}`, { type: type.includes('mp4') ? 'audio/mp4' : type }), seconds);
    };
    recorder.current = r;
    keep.current = false;
    r.start(250);
    setRec({ startedAt, elapsed: 0 });
    timer.current = window.setInterval(() => {
      const el = (Date.now() - startedAt) / 1000;
      setRec((x) => (x ? { ...x, elapsed: el } : x));
      if (el >= MAX_VOICE_SEC) { keep.current = true; r.stop(); }
    }, 200);
  };
  const stopRec = (send: boolean) => { keep.current = send; if (recorder.current?.state === 'recording') recorder.current.stop(); };

  if (rec) {
    return (
      <div className="dm-compose dm-recording">
        <button type="button" className="dm-cbtn" aria-label="Hủy ghi âm" title="Hủy" onClick={() => stopRec(false)}><Icon name="trash" size={20} /></button>
        <div className="dm-rec-bar"><span className="dm-rec-dot" /> Đang ghi âm… <b>{fmtDur(rec.elapsed)}</b><span className="muted small" style={{ marginLeft: 'auto' }}>tối đa {MAX_VOICE_SEC / 60} phút</span></div>
        <button type="button" className="dm-send" aria-label="Gửi tin nhắn thoại" onClick={() => stopRec(true)}><Icon name="send" size={19} /></button>
      </div>
    );
  }
  return (
    <form className="dm-compose" onSubmit={(e) => { e.preventDefault(); onSend(); }}>
      <input ref={fileInput} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
      <button type="button" className="dm-cbtn" aria-label="Gửi ảnh hoặc video" title="Ảnh / video" disabled={disabled} onClick={() => fileInput.current?.click()}><Icon name="image" size={22} /></button>
      {!canSend && <button type="button" className="dm-cbtn" aria-label="Ghi âm tin nhắn thoại" title="Tin nhắn thoại" disabled={disabled} onClick={startRec}><Icon name="mic" size={22} /></button>}
      <div className="dm-field">
        {drafts.length > 0 && (
          <div className="dm-drafts">
            {drafts.map((d, i) => (
              <span key={d.url} className="dm-draft">
                {d.kind === 'image' ? <img src={d.url} alt="" /> : <video src={d.url} muted preload="metadata" />}
                {d.kind === 'video' && <span className="dm-draft-tag"><Icon name="play" size={12} /></span>}
                <button type="button" aria-label="Bỏ tệp này" onClick={() => onRemoveDraft(i)}><Icon name="x" size={12} stroke={3} /></button>
              </span>
            ))}
            <button type="button" className="dm-draft dm-draft-add" aria-label="Thêm ảnh hoặc video" onClick={() => fileInput.current?.click()}><Icon name="plus" size={20} /></button>
          </div>
        )}
        <textarea ref={input} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} rows={1} placeholder="Aa" aria-label="Tin nhắn" disabled={disabled}
          onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); onFiles(e.clipboardData.files); } }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onSend(); } }} />
      </div>
      <button type="submit" className="dm-send" aria-label="Gửi" disabled={!canSend || disabled}><Icon name="send" size={19} /></button>
    </form>
  );
}

interface Contact { user_id: string; name: string; role: string; class_ids: string[]; conversation_id: string | null; blocked: boolean }
interface Contacts { classes: { class_id: string; name: string; count: number }[]; people: Contact[] }
type RoleTag = 'all' | 'teacher' | 'student';
const isTeacher = (c: Contact) => c.role === 'teacher' || c.role === 'admin';

/** Chọn người để nhắn: bấm thẻ lớp, thẻ vai trò, rồi gõ hoặc bấm vào tên. Dùng trong hộp "Tin nhắn mới" và ở khung trống bên phải. */
export function ContactPicker({ onPicked, compact }: { onPicked?: () => void; compact?: boolean }) {
  const toast = useToast();
  const data = useAsync((s) => api<Contacts>('/ai/messages/contacts', { signal: s }), [], 'dm/contacts');
  const [cls, setCls] = useState('');
  const [role, setRole] = useState<RoleTag>('all');
  const [q, setQ] = useState('');
  const [opening, setOpening] = useState('');
  const classes = data.data?.classes || [];
  const people = data.data?.people || [];
  const inClass = people.filter((p) => !cls || p.class_ids.includes(cls));
  const term = q.trim().toLowerCase();
  const shown = inClass.filter((p) => (role === 'all' || (role === 'teacher') === isTeacher(p)) && `${p.name} ${p.user_id}`.toLowerCase().includes(term));
  const nTeacher = inClass.filter(isTeacher).length;

  const open = async (p: Contact) => {
    if (p.conversation_id) { onPicked?.(); navigate(`/messages/${p.conversation_id}`); return; }
    setOpening(p.user_id);
    await openDirect(p.user_id, toast);
    setOpening('');
    onPicked?.();
  };

  if (data.loading && !data.data) return <Spinner />;
  if (data.error) return <ErrorBox message={data.error} onRetry={data.reload} />;
  if (!classes.length) return <Empty title="Bạn chưa vào lớp nào">Vào <Link to="/classes">Lớp của tôi</Link> và nhập mã lớp để nhắn tin với bạn cùng lớp và giáo viên.</Empty>;
  return (
    <div className={`cp ${compact ? 'cp-compact' : ''}`}>
      {classes.length > 0 && (
        <div className="cp-tags" role="group" aria-label="Lọc theo lớp">
          {classes.length > 1 && <button type="button" className={`pill ${!cls ? 'pill-on' : ''}`} aria-pressed={!cls} onClick={() => setCls('')}>Tất cả lớp</button>}
          {classes.map((c) => (
            <button key={c.class_id} type="button" className={`pill cp-class ${cls === c.class_id || classes.length === 1 ? 'pill-on' : ''}`} aria-pressed={cls === c.class_id || classes.length === 1}
              onClick={() => setCls(classes.length > 1 && cls === c.class_id ? '' : c.class_id)} title={c.name}><Icon name="users" size={15} /> {c.class_id}</button>
          ))}
        </div>
      )}
      <div className="cp-tags" role="group" aria-label="Lọc theo vai trò">
        {([['all', 'Tất cả', inClass.length], ['teacher', 'Giáo viên', nTeacher], ['student', 'Học sinh', inClass.length - nTeacher]] as const).map(([k, label, n]) => (
          <button key={k} type="button" className={`pill ${role === k ? 'pill-on' : ''}`} aria-pressed={role === k} onClick={() => setRole(k)}>
            {label} <span className="cp-count">{n}</span>
          </button>
        ))}
      </div>
      <div className="cp-search">
        <Icon name="search" size={18} />
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Gõ tên hoặc mã để tìm…" aria-label="Tìm người trong lớp" autoFocus={compact} />
      </div>
      <div className="cp-list" role="list">
        {!shown.length ? <p className="muted small" style={{ padding: 8 }}>Không có ai khớp.</p> : shown.map((p) => (
          <button key={p.user_id} role="listitem" type="button" className="cp-person" onClick={() => open(p)} disabled={opening === p.user_id}>
            <Avatar name={p.name} id={p.user_id} size={40} />
            <span className="grow" style={{ minWidth: 0 }}>
              <strong className="dm-name">{p.name}</strong>
              <span className="cp-sub">@{p.user_id}<span className="cp-role-inline">{isTeacher(p) ? ' · Giáo viên' : ''}</span>{classes.length > 1 && ` · ${p.class_ids.join(', ')}`}</span>
            </span>
            {isTeacher(p) && <span className="cp-role"><Badge tone="blue">Giáo viên</Badge></span>}
            <span className="cp-go">{p.blocked ? 'Đã chặn · Mở' : p.conversation_id ? 'Mở' : 'Nhắn'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function MemberPicker({ onClose }: { onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="Nhắn tin cho người trong lớp">
      <div className="modal-body"><ContactPicker compact onPicked={onClose} /></div>
    </Modal>
  );
}
