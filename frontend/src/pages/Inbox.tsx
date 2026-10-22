import { PageHeader } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { timeAgo } from '../components/Social';
import { Button, Empty, ErrorBox, Spinner, useToast } from '../components/ui';
import { api, errorText } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { refreshNotifications } from '../lib/notifications';
import { navigate } from '../lib/router';

interface Noti { notification_id: string; kind: 'mention' | 'reply' | 'dm'; text: string; actor_id: string | null; class_id: string | null; thread_id: string | null; read: boolean; created_at: string | null }

const ICON = { mention: 'mail', reply: 'reply', dm: 'chat' } as const;

/** Hộp thông báo: được @nhắc tên, có người bình luận bài / trả lời bình luận của mình. */
export function Inbox() {
  const toast = useToast();
  const list = useAsync((s) => api<Noti[]>('/ai/notifications/inbox', { signal: s }), []);
  const markAll = async () => {
    try { await api('/ai/notifications/inbox/read', { json: {} }); list.reload(); refreshNotifications(); } catch (e) { toast(errorText(e), 'error'); }
  };
  const open = async (n: Noti) => {
    if (!n.read) {
      try { await api('/ai/notifications/inbox/read', { json: { notification_id: n.notification_id } }); refreshNotifications(); } catch { /* bỏ qua */ }
    }
    if (n.thread_id) navigate(`/forum/${n.thread_id}`);
    else list.reload();
  };
  const unread = list.data?.filter((n) => !n.read).length || 0;
  return (
    <>
      <PageHeader title="Thông báo" sub="Ai đó nhắc tên bạn hoặc bình luận vào bài của bạn."
        actions={unread > 0 ? <Button size="sm" variant="ghost" icon="check" onClick={markAll}>Đánh dấu đã đọc tất cả</Button> : undefined} />
      {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorBox message={list.error} onRetry={list.reload} /> : !list.data?.length ? (
        <Empty title="Chưa có thông báo">Khi bạn được @nhắc tên hoặc có người bình luận bài của bạn, thông báo sẽ hiện ở đây.</Empty>
      ) : (
        <div className="card col" style={{ gap: 0, padding: 6 }}>
          {list.data.map((n) => (
            <button key={n.notification_id} className={`inbox-item ${n.read ? '' : 'inbox-unread'}`} onClick={() => open(n)}>
              <span className={`inbox-ico inbox-${n.kind}`}><Icon name={ICON[n.kind] || 'bell'} size={18} /></span>
              <span className="grow">
                <span>{n.text}</span><br />
                <span className="muted small">{timeAgo(n.created_at)}{n.class_id ? ` · lớp ${n.class_id}` : ''}</span>
              </span>
              {!n.read && <span className="inbox-dot" aria-label="Chưa đọc" />}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
