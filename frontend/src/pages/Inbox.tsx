import { useState } from 'react';
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
const FILTERS: { id: '' | Noti['kind']; label: string }[] = [{ id: '', label: 'Tất cả' }, { id: 'reply', label: 'Trả lời' }, { id: 'mention', label: 'Nhắc tên' }, { id: 'dm', label: 'Tin nhắn' }];

/** Chia thông báo theo Hôm nay / Tuần này / Cũ hơn. */
function groupOf(iso: string | null) {
  if (!iso) return 'Cũ hơn';
  const d = new Date(iso), now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= start) return 'Hôm nay';
  if (d.getTime() >= start - 6 * 86400000) return 'Tuần này';
  return 'Cũ hơn';
}

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
  const [filter, setFilter] = useState<'' | Noti['kind']>('');
  const unread = list.data?.filter((n) => !n.read).length || 0;
  const shown = (list.data || []).filter((n) => !filter || n.kind === filter);
  const groups = ['Hôm nay', 'Tuần này', 'Cũ hơn'].map((g) => ({ g, rows: shown.filter((n) => groupOf(n.created_at) === g) })).filter((x) => x.rows.length);
  return (
    <>
      <PageHeader title="Thông báo" sub="Ai đó nhắc tên bạn hoặc bình luận vào bài của bạn."
        actions={unread > 0 ? <Button size="sm" variant="ghost" icon="check" onClick={markAll}>Đánh dấu đã đọc hết</Button> : undefined} />
      {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorBox message={list.error} onRetry={list.reload} /> : !list.data?.length ? (
        <Empty title="Chưa có thông báo">Khi bạn được @nhắc tên hoặc có người bình luận bài của bạn, thông báo sẽ hiện ở đây.</Empty>
      ) : (
        <div className="inbox-page">
          <div className="inbox-filters" role="group" aria-label="Lọc thông báo">
            {FILTERS.map((f) => <button key={f.id || 'all'} className={`pill ${filter === f.id ? 'pill-on' : ''}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
            {unread > 0 && <span className="muted small">{unread} chưa đọc</span>}
          </div>
          {!groups.length && <Empty title="Không có thông báo loại này">Chọn “Tất cả” để xem mọi thông báo.</Empty>}
          {groups.map(({ g, rows }) => (
            <section key={g} className="inbox-group">
              <span className="oc-kicker">{g}</span>
              <div className="card inbox-card">
                {rows.map((n) => (
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
            </section>
          ))}
        </div>
      )}
    </>
  );
}
