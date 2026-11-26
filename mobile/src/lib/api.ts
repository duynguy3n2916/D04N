// Lớp gọi API backend FastAPI (dùng chung backend với bản web).
// Khác bản web: app không chạy cùng origin nên cần địa chỉ máy chủ. Người dùng không phải nhập:
// - EXPO_PUBLIC_API_URL hoặc expo.extra.apiUrl (bản build) nếu có;
// - khi chạy thử bằng Expo, lấy IP máy tính đang chạy Expo và ghép cổng backend 8000.
// Chỉ khi không tự tìm được (hoặc người dùng tự đổi) mới dùng địa chỉ lưu trong SecureStore.
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { fetch as expoFetch } from 'expo/fetch';

export type Role = 'student' | 'teacher' | 'admin';
export interface User {
  user_id: string; role: Role; class_ids: string[]; name?: string; display_name?: string | null; email?: string | null;
  must_change_password?: boolean; has_password?: boolean;
}
export interface ClassInfo { class_id: string; name: string; join_code?: string; is_active?: boolean }
export interface AuthResponse { access_token: string; user: User }

const KEY_TOKEN = 'd04n.token';
const KEY_USER = 'd04n.user';
// Khoá mới: bỏ qua địa chỉ cũ người dùng từng gõ (có thể sai) ở khoá 'd04n.server'.
const KEY_SERVER = 'd04n.server.custom';
const BACKEND_PORT = 8000;

/** Khi chạy thử bằng Expo: hostUri có dạng "172.20.10.4:8081" (máy đang chạy Metro), backend chạy cùng máy ở cổng 8000. */
function devServer(): string {
  const c = Constants as any;
  const host: string | undefined = c.expoConfig?.hostUri || c.expoGoConfig?.debuggerHost || c.manifest2?.extra?.expoGo?.debuggerHost;
  const name = host?.split(':')[0];
  return name ? `http://${name}:${BACKEND_PORT}` : '';
}

/** Địa chỉ mặc định: EXPO_PUBLIC_API_URL, expo.extra.apiUrl trong app.json, hoặc máy đang chạy Expo. */
const DEFAULT_SERVER: string = process.env.EXPO_PUBLIC_API_URL || (Constants.expoConfig?.extra as any)?.apiUrl || devServer();

let token: string | null = null;
let server = DEFAULT_SERVER;
let onUnauthorized: ((message?: string) => void) | null = null;

async function readKey(k: string) { try { return await SecureStore.getItemAsync(k); } catch { return null; } }
async function writeKey(k: string, v: string | null) {
  try { if (v === null) await SecureStore.deleteItemAsync(k); else await SecureStore.setItemAsync(k, v); } catch { /* bỏ qua */ }
}

/** Đọc phiên đăng nhập và địa chỉ máy chủ đã lưu khi mở app. */
export async function loadSession(): Promise<User | null> {
  const [t, u, s] = await Promise.all([readKey(KEY_TOKEN), readKey(KEY_USER), readKey(KEY_SERVER)]);
  token = t;
  if (s) server = s;
  try { return t && u ? JSON.parse(u) : null; } catch { return null; }
}
export function getToken() { return token; }
export function getServer() { return server; }
export function hasDefaultServer() { return !!DEFAULT_SERVER; }
export function normalizeServer(raw: string) {
  let s = raw.trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s;
}
/** Người dùng tự đổi máy chủ. Để trống thì quay về địa chỉ tự tìm. */
export async function setServer(raw: string) {
  const s = normalizeServer(raw);
  server = s || DEFAULT_SERVER;
  await writeKey(KEY_SERVER, s && s !== DEFAULT_SERVER ? s : null);
}
export async function setSession(t: string | null, user: User | null) {
  token = t;
  await Promise.all([writeKey(KEY_TOKEN, t), writeKey(KEY_USER, user ? JSON.stringify(user) : null)]);
}
export function setUnauthorizedHandler(fn: (message?: string) => void) { onUnauthorized = fn; }

export class ApiError extends Error {
  status: number; code?: string; details?: any;
  constructor(status: number, body: any) {
    super(body?.error?.message || (typeof body?.detail === 'string' ? body.detail : '') || `Lỗi ${status}`);
    this.status = status; this.code = body?.error?.code; this.details = body?.error?.details;
  }
}

type Opts = { method?: string; json?: unknown; signal?: AbortSignal; timeoutMs?: number };

export async function api<T = any>(path: string, opts: Opts = {}): Promise<T> {
  if (!server) throw new ApiError(0, { detail: 'Chưa có địa chỉ máy chủ.' });
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: string | undefined;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  // fetch của React Native không tự hết giờ: tự huỷ sau 60 giây (gọi AI có thể lâu)
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
  opts.signal?.addEventListener('abort', () => ctrl.abort());
  let res: Response;
  try {
    res = await fetch(server + path, { method: opts.method || (body ? 'POST' : 'GET'), headers, body, signal: ctrl.signal });
  } catch (e: any) {
    if (opts.signal?.aborted) throw e;
    throw new ApiError(0, { detail: `Không kết nối được máy chủ ${server}. Điện thoại và máy tính có chung Wi-Fi không? Backend đã chạy bằng scripts/run.ps1 -Lan chưa?` });
  } finally { clearTimeout(timer); }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && token && !path.startsWith('/ai/auth/login')) {
    const code = data?.error?.code;
    onUnauthorized?.(code === 'TOKEN_EXPIRED' || code === 'SESSION_REVOKED' || code === 'ACCOUNT_DISABLED' ? data?.error?.message : undefined);
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

/** Gọi API trả Server-Sent Events (vd. /ai/coach/chat/stream): gọi onEvent cho từng sự kiện ngay khi tới.
 * fetch gốc của React Native không đọc được body dạng stream nên dùng fetch của Expo. */
export async function apiStream(path: string, json: unknown, onEvent: (event: string, data: any) => void,
                                timeoutMs = 180_000): Promise<void> {
  if (!server) throw new ApiError(0, { detail: 'Chưa có địa chỉ máy chủ.' });
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res: Awaited<ReturnType<typeof expoFetch>>;
    try {
      res = await expoFetch(server + path, { method: 'POST', headers, body: JSON.stringify(json), signal: ctrl.signal });
    } catch {
      throw new ApiError(0, { detail: `Không kết nối được máy chủ ${server}.` });
    }
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => null);
      if (res.status === 401 && token) onUnauthorized?.(data?.error?.message);
      throw new ApiError(res.status, data);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const flush = (block: string) => {
      let event = 'message', data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data) onEvent(event, JSON.parse(data));
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) { flush(buf.slice(0, i)); buf = buf.slice(i + 2); }
    }
    if (buf.trim()) flush(buf);
  } finally { clearTimeout(timer); }
}

/** URL file media cho video (trình phát không gửi header được) — gắn access_token như bản web. */
export function mediaUrl(path: string) {
  const sep = path.includes('?') ? '&' : '?';
  return `${server}${path}${sep}access_token=${encodeURIComponent(token || '')}`;
}

export function errorText(e: unknown): string {
  return (e as Error)?.message || String(e);
}

export function fmtTime(sec: number | null | undefined) {
  if (sec == null || isNaN(sec)) return '--:--';
  const s = Math.max(0, Math.floor(sec)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')) + ':' + String(r).padStart(2, '0');
}

export function timeAgo(iso: string | null | undefined) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'vừa xong';
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} ngày trước`;
  return new Date(iso).toLocaleDateString('vi-VN');
}

// ---------------------------------------------------------------- Kiểu dữ liệu (giống frontend/src/lib/api.ts)

export type ItemType = 'video' | 'slide' | 'reading' | 'quiz';
export type ItemStatus = 'done' | 'current' | 'open' | 'locked' | 'completed';

export interface ItemSummary {
  item_id: string; lesson_id: string; type: ItemType; title: string; position: number; meta_text: string;
  status: ItemStatus; completed: boolean; progress_position: number | null; score: number | null;
}
export interface LessonNode { lesson_id: string; code: string; title: string; items: ItemSummary[]; items_total: number; items_done: number }
export interface CourseSummary { course_id: string; code: string; title: string; description?: string; items_total: number; items_done: number; current_item_id: string | null }
export interface CourseTree extends CourseSummary { chapters: { chapter_id: string; title: string; lessons: LessonNode[] }[] }
export interface LessonView {
  lesson_id: string; code: string; title: string; description?: string; chapter_title: string; course_id: string;
  course_title: string; items: ItemSummary[]; items_total: number; items_done: number;
}
export interface ItemDetail extends ItemSummary {
  lesson_code: string;
  video?: { video_id: string; has_file: boolean; source_url: string | null; stream_path: string | null; duration_seconds: number | null; has_transcript: boolean; question_count: number };
  slide?: { document_id: string | null; source_type: string | null; title: string | null; status: string | null; file_path: string | null; notes?: string | null; pages?: number | null };
  reading?: { content_md: string; document_id: string | null };
  quiz?: { count: number; pass_ratio: number; available: number; time_limit_minutes?: number | null;
    open_at?: string | null; close_at?: string | null; window?: 'open' | 'not_yet' | 'closed' };
}
export interface Stats { total_xp: number; today_xp: number; week_xp: number; daily_goal_xp: number; streak_days: number; studied_today: boolean }
export interface PublicQuestion { question_id: string; video_id: string; timestamp: number; type: string; question: string; options: string[] | null }
export interface AnswerResult {
  question_id: string; is_correct: boolean | null; verdict?: string; correct_answer: string; correct_index?: number | null;
  explanation?: string | null; feedback: string; xp_awarded?: number;
}
export interface Source {
  label: string; display: string; source_type?: string; source_id?: string | null; document_id?: string;
  document_title?: string; page?: number | null; start_time?: number | null;
}
export interface TranscriptSegment { start_time: number; end_time: number; text: string }

export interface NotiSummary {
  forum_new: number; forum_by_class: Record<string, number>;
  flashcards_due: number; flashcards: { lesson_code: string; lesson_title: string; due: number }[];
  inbox_unread: number; dm_unread: number;
}
