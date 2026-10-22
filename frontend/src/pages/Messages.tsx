import { useEffect, useRef, useState } from 'react';
import { PageHeader } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { Avatar, timeAgo, useMembers } from '../components/Social';
import { Badge, Button, confirmDialog, Empty, ErrorBox, Modal, Spinner, useToast } from '../components/ui';
import { api, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync, useInterval } from '../lib/hooks';
import { refreshNotifications } from '../lib/notifications';
import { navigate } from '../lib/router';
import { openDirect, ReportDialog } from './Forum';

interface Conversation { conversation_id: string; other_id: string; other_name: string; last_message: string; last_at: string | null; unread: number; blocked: boolean }
interface Message { message_id: string; sender_id: string; mine: boolean; body: string; hidden: boolean; created_at: string | null }
interface Thread { conversation_id: string; other_id: string; other_name: string; blocked: boolean; blocked_by_me: boolean; messages: Message[] }

/** Tin nhắn riêng giữa các thành viên cùng lớp. Giáo viên chỉ xem được tin nhắn bị báo cáo. */
export function Messages({ conversationId }: { conversationId?: string }) {
  const list = useAsync((s) => api<Conversation[]>('/ai/messages/conversations', { signal: s }), []);
  const [picking, setPicking] = useState(false);
  useInterval(list.reload, 20_000);
  return (
    <>
      <PageHeader title="Tin nhắn" sub="Nhắn riêng với bạn cùng lớp. Hãy lịch sự; tin nhắn bị báo cáo sẽ được giáo viên xem xét."
        actions={<Button size="sm" icon="plus" onClick={() => setPicking(true)}>Tin nhắn mới</Button>} />
      <div className={`dm-layout ${conversationId ? 'dm-has-open' : ''}`}>
        <aside className="card dm-list" aria-label="Cuộc trò chuyện">
          {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorBox message={list.error} onRetry={list.reload} /> : !list.data?.length ? (
            <div className="muted small" style={{ padding: 8 }}>Chưa có cuộc trò chuyện nào. Bấm “Tin nhắn mới” để bắt đầu.</div>
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
          {conversationId ? <Chat key={conversationId} conversationId={conversationId} onChange={list.reload} />
            : <Empty title="Chọn một cuộc trò chuyện">Hoặc bấm “Tin nhắn mới” để nhắn cho bạn cùng lớp.</Empty>}
        </section>
      </div>
      {picking && <MemberPicker onClose={() => setPicking(false)} />}
    </>
  );
}

function Chat({ conversationId, onChange }: { conversationId: string; onChange: () => void }) {
  const toast = useToast();
  const data = useAsync((s) => api<Thread>(`/ai/messages/conversations/${conversationId}`, { signal: s }), [conversationId]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [reporting, setReporting] = useState<Message | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const t = data.data;
  useInterval(data.reload, 8_000);
  // mở / có tin mới thì server đã đánh dấu đã đọc: cập nhật số chưa đọc ở menu và danh sách hội thoại
  useEffect(() => { if (t) { refreshNotifications(); onChange(); } }, [t?.messages.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // cuộn khung tin nhắn (không cuộn cả trang) xuống tin mới nhất
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [t?.messages.length]);

  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api(`/ai/messages/conversations/${conversationId}`, { json: { body: text.trim() } });
      setText('');
      data.reload();
      onChange();
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  const block = async (blocked: boolean) => {
    if (blocked && !await confirmDialog(`Chặn ${t?.other_name}? Hai bạn sẽ không nhắn tin cho nhau được cho đến khi bỏ chặn.`, { danger: true, okLabel: 'Chặn' })) return;
    try {
      await api('/ai/messages/blocks', { json: { user_id: t?.other_id, blocked } });
      toast(blocked ? 'Đã chặn' : 'Đã bỏ chặn', 'success');
      data.reload();
      onChange();
    } catch (e) { toast(errorText(e), 'error'); }
  };

  if (data.loading && !t) return <Spinner />;
  if (data.error) return <ErrorBox message={data.error} onRetry={data.reload} />;
  if (!t) return null;
  return (
    <div className="dm-chat-inner">
      <header className="dm-chat-head">
        <button className="iconbtn dm-back" aria-label="Về danh sách" onClick={() => navigate('/messages')}><Icon name="chevronLeft" size={20} /></button>
        <Avatar name={t.other_name} id={t.other_id} size={36} />
        <span className="grow"><strong>{t.other_name}</strong><br /><span className="muted small">@{t.other_id}</span></span>
        <Button size="sm" variant="ghost" icon="ban" onClick={() => block(!t.blocked_by_me)}>{t.blocked_by_me ? 'Bỏ chặn' : 'Chặn'}</Button>
      </header>
      <div ref={box} className="dm-messages" aria-live="polite">
        {!t.messages.length && <p className="muted small" style={{ textAlign: 'center' }}>Hãy gửi lời chào đầu tiên 👋</p>}
        {t.messages.map((m) => (
          <div key={m.message_id} className={`dm-msg ${m.mine ? 'mine' : ''}`}>
            <div className={`dm-bubble ${m.hidden ? 'dm-hidden' : ''}`}>{m.body}</div>
            <span className="muted small dm-meta">
              {timeAgo(m.created_at)}
              {!m.mine && !m.hidden && <button className="linkbtn small" onClick={() => setReporting(m)}>Báo cáo</button>}
            </span>
          </div>
        ))}
      </div>
      {t.blocked ? (
        <p className="muted small dm-blocked"><Badge tone="gray">Đã chặn</Badge> {t.blocked_by_me ? 'Bạn đã chặn người này.' : 'Bạn không thể nhắn cho người này.'}</p>
      ) : (
        <form className="dm-compose" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <textarea className="input" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} rows={1} placeholder="Nhập tin nhắn…" aria-label="Tin nhắn"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <Button type="submit" icon="send" loading={busy} disabled={!text.trim()}>Gửi</Button>
        </form>
      )}
      {reporting && (
        <ReportDialog title="Báo cáo tin nhắn" onClose={() => setReporting(null)} onSend={async (reason) => {
          const r = await api<{ duplicate: boolean }>(`/ai/messages/${reporting.message_id}/report`, { json: { reason } });
          return r.duplicate ? 'Bạn đã báo cáo tin nhắn này rồi' : 'Đã gửi báo cáo cho giáo viên (chỉ tin nhắn này được gửi)';
        }} />
      )}
    </div>
  );
}

function MemberPicker({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const me = useAsync((s) => api<{ classes?: { class_id: string; name: string }[] }>('/ai/auth/me', { signal: s }), []);
  const classes = me.data?.classes?.length ? me.data.classes : (user?.class_ids || []).map((id) => ({ class_id: id, name: '' }));
  const [classId, setClassId] = useState('');
  const cid = classId || classes[0]?.class_id || '';
  const members = useMembers(cid);
  const [q, setQ] = useState('');
  const shown = (members.data || []).filter((m) => m.user_id !== user?.user_id && (`${m.name} ${m.user_id}`).toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Modal open onClose={onClose} title="Nhắn tin cho bạn cùng lớp">
      <div className="modal-body col" style={{ gap: 10 }}>
        {classes.length > 1 && (
          <select className="input" value={cid} onChange={(e) => setClassId(e.target.value)} aria-label="Lớp">
            {classes.map((c) => <option key={c.class_id} value={c.class_id}>{c.name ? `${c.class_id} · ${c.name}` : c.class_id}</option>)}
          </select>
        )}
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm theo tên hoặc mã…" autoFocus aria-label="Tìm thành viên" />
        <div className="col" style={{ gap: 4, maxHeight: 360, overflowY: 'auto' }}>
          {!cid ? <span className="muted small">Bạn chưa vào lớp nào.</span> : members.loading && !members.data ? <Spinner /> : !shown.length ? <span className="muted small">Không có ai khớp.</span> : shown.map((m) => (
            <button key={m.user_id} className="dm-item" onClick={() => { onClose(); openDirect(m.user_id, toast); }}>
              <Avatar name={m.name} id={m.user_id} size={34} />
              <span className="grow"><strong>{m.name}</strong> <span className="muted small">@{m.user_id}</span></span>
              {m.role !== 'student' && <Badge tone="blue">Giáo viên</Badge>}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
