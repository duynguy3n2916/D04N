// Số thông báo chưa đọc + thẻ đến hạn: một nguồn dùng chung, hỏi lại mỗi 60 giây khi app đang mở.
import { useEffect, useState } from 'react';
import { api, getToken, type NotiSummary } from './api';

let current: NotiSummary | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const subs = new Set<(s: NotiSummary | null) => void>();

export async function refreshNotifications() {
  if (!getToken()) return;
  try { current = await api<NotiSummary>('/ai/notifications/summary'); subs.forEach((fn) => fn(current)); } catch { /* phụ, bỏ qua */ }
}

export function useNotifications() {
  const [s, setS] = useState(current);
  useEffect(() => {
    subs.add(setS);
    if (subs.size === 1) { refreshNotifications(); timer = setInterval(refreshNotifications, 60_000); }
    return () => { subs.delete(setS); if (!subs.size && timer) { clearInterval(timer); timer = null; } };
  }, []);
  return s;
}
