// Thông báo chưa đọc (diễn đàn, hộp thông báo, tin nhắn riêng, thẻ flashcard đến hạn): một nguồn dữ liệu dùng chung, hỏi lại mỗi 60 giây.
import { useEffect, useState } from 'react';
import { api, getToken } from './api';

export interface NotiSummary {
  forum_new: number;
  forum_by_class: Record<string, number>;
  flashcards_due: number;
  flashcards: { lesson_code: string; lesson_title: string; due: number }[];
  inbox_unread: number;
  dm_unread: number;
}

let current: NotiSummary | null = null;
let inflight = false;
let timer: number | null = null;
const subscribers = new Set<(s: NotiSummary | null) => void>();

export async function refreshNotifications() {
  if (!getToken() || inflight) return;
  inflight = true;
  try {
    current = await api<NotiSummary>('/ai/notifications/summary');
    subscribers.forEach((fn) => fn(current));
  } catch { /* thông báo là phụ, lỗi thì bỏ qua lần này */ } finally { inflight = false; }
}

/** Đánh dấu đã xem diễn đàn của một lớp rồi cập nhật lại số chưa đọc. */
export async function markForumSeen(classId: string) {
  if (!classId) return;
  try { await api('/ai/notifications/seen', { json: { key: `forum:${classId}` } }); } catch { /* bỏ qua */ }
  refreshNotifications();
}

export function useNotifications(): NotiSummary | null {
  const [state, setState] = useState(current);
  useEffect(() => {
    subscribers.add(setState);
    if (subscribers.size === 1) {
      refreshNotifications();
      timer = window.setInterval(refreshNotifications, 60_000);
    }
    return () => {
      subscribers.delete(setState);
      if (!subscribers.size && timer !== null) { window.clearInterval(timer); timer = null; }
    };
  }, []);
  return state;
}
