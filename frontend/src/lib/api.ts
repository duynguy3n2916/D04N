// Lớp gọi API backend FastAPI (cùng origin). Token JWT lưu ở localStorage (bọc try/catch).

export type Role = 'student' | 'teacher' | 'admin';
export interface User {
  user_id: string; role: Role; class_ids: string[]; name?: string; display_name?: string | null; email?: string | null;
  must_change_password?: boolean; has_password?: boolean;
}
export interface ClassInfo { class_id: string; name: string; join_code?: string; is_active: boolean; students?: number; teachers?: number }
export interface AuthResponse { access_token: string; user: User }

const TOKEN_KEY = 'mam.token';
const USER_KEY = 'mam.user';

export const storage = {
  get(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } },
  set(key: string, value: string | null) {
    try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* bỏ qua */ }
  },
};

let token: string | null = storage.get(TOKEN_KEY);
let onUnauthorized: ((code?: string, message?: string) => void) | null = null;
let onMustChange: (() => void) | null = null;

export function getToken() { return token; }
export function setSession(t: string | null, user: User | null) {
  token = t;
  storage.set(TOKEN_KEY, t);
  storage.set(USER_KEY, user ? JSON.stringify(user) : null);
}
export function savedUser(): User | null {
  try { return JSON.parse(storage.get(USER_KEY) || 'null'); } catch { return null; }
}
export function setUnauthorizedHandler(fn: (code?: string, message?: string) => void) { onUnauthorized = fn; }
export function setMustChangeHandler(fn: () => void) { onMustChange = fn; }

export class ApiError extends Error {
  status: number; code?: string; details?: any; requestId?: string;
  constructor(status: number, body: any) {
    super(body?.error?.message || body?.detail || `Lỗi ${status}`);
    this.status = status; this.code = body?.error?.code; this.details = body?.error?.details; this.requestId = body?.request_id;
  }
}

type Opts = { method?: string; json?: unknown; form?: FormData; signal?: AbortSignal };

export async function api<T = any>(path: string, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  if (opts.form) body = opts.form;
  let res: Response;
  try {
    res = await fetch(path, { method: opts.method || (body ? 'POST' : 'GET'), headers, body, signal: opts.signal });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError(0, { detail: 'Không kết nối được máy chủ. Backend đã chạy chưa?' });
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && token && !path.startsWith('/ai/auth/login') && !path.startsWith('/ai/auth/change-password')) {
    onUnauthorized?.(data?.error?.code, data?.error?.message);
  }
  if (res.status === 403 && data?.error?.code === 'PASSWORD_CHANGE_REQUIRED') onMustChange?.();
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

/** Tải file có xác thực (vd. xuất đề): trả blob + tên file từ Content-Disposition. */
export async function apiBlob(path: string): Promise<{ blob: Blob; filename: string }> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { headers }).catch(() => {
    throw new ApiError(0, { detail: 'Không kết nối được máy chủ. Backend đã chạy chưa?' });
  });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  const cd = res.headers.get('Content-Disposition') || '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  const filename = star ? decodeURIComponent(star[1]) : plain ? plain[1] : 'download';
  return { blob: await res.blob(), filename };
}

/** Gọi endpoint Server-Sent Events (POST + JSON), gọi onEvent cho từng sự kiện. Lỗi trước khi stream ném ApiError. */
export async function apiStream(path: string, json: unknown, onEvent: (event: string, data: any) => void,
                                signal?: AbortSignal): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(json), signal });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError(0, { detail: 'Không kết nối được máy chủ. Backend đã chạy chưa?' });
  }
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => null);
    if (res.status === 401 && token) onUnauthorized?.(data?.error?.code, data?.error?.message);
    if (res.status === 403 && data?.error?.code === 'PASSWORD_CHANGE_REQUIRED') onMustChange?.();
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
}

/** URL file media cho thẻ <video>/pdf.js (không gửi được header) — gắn access_token. */
export function mediaUrl(path: string) {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}access_token=${encodeURIComponent(token || '')}`;
}

export function errorText(e: unknown): string {
  // mã yêu cầu chỉ cần khi lỗi máy chủ (để tra log); lỗi thao tác của người dùng thì không hiện
  if (e instanceof ApiError) return e.message + (e.requestId && (e.status >= 500 || e.status === 0) ? ` (mã: ${e.requestId})` : '');
  return (e as Error)?.message || String(e);
}

// ---------------------------------------------------------------- Kiểu dữ liệu chính

export type ItemType = 'video' | 'slide' | 'reading' | 'quiz';
export type ItemStatus = 'done' | 'current' | 'open' | 'locked' | 'completed';

export interface ItemSummary {
  item_id: string; lesson_id: string; type: ItemType; title: string; position: number; meta_text: string;
  status: ItemStatus; completed: boolean; progress_position: number | null; score: number | null;
}
export interface LessonNode { lesson_id: string; code: string; title: string; items: ItemSummary[]; items_total: number; items_done: number }
export interface CourseTree {
  course_id: string; code: string; title: string; description?: string; cover_url?: string | null; items_total: number; items_done: number;
  current_item_id: string | null;
  chapters: { chapter_id: string; title: string; lessons: LessonNode[] }[];
}
export interface CourseSummary { course_id: string; code: string; title: string; description?: string; cover_url?: string | null; items_total: number; items_done: number; current_item_id: string | null }
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
export interface Stats { total_xp: number; today_xp: number; week_xp: number; daily_goal_xp: number; streak_days: number; studied_today: boolean; last_7_days: { date: string; xp: number }[] }
export interface PublicQuestion { question_id: string; video_id: string; timestamp: number; type: string; difficulty?: string; question: string; options: string[] | null; origin?: string }
export interface SessionStatus {
  session_id: string; state: string; current_video_time: number; video_question_active: boolean; in_cooldown: boolean;
  remaining_cooldown_seconds: number; deadline_remaining_seconds: number | null; active_question: PublicQuestion | null;
  last_result: AnswerResult | null; can_resume: boolean; transitions?: { from: string; to: string; reason: string; at: string; video_time: number }[];
}
export interface AnswerResult {
  type?: string; question_id: string; is_correct: boolean | null; verdict?: string; correct_answer: string; correct_index?: number | null;
  explanation?: string | null; feedback: string; xp_awarded?: number;
  /** Tutor AI (AI thứ hai) giải thích sau khi hết giờ / trả lời sai */
  tutor_status?: 'pending' | 'ready' | 'failed' | null; tutor_explanation?: string | null; tutor_sources?: Source[] | null;
}
export interface Source {
  label: string; display: string; chunk_id?: string | null; source_type?: string; source_id?: string | null; document_id?: string;
  document_title?: string; page?: number | null; start_time?: number | null; end_time?: number | null;
}
export interface TutorQuota { used: number; limit: number; remaining: number; resets_at: string }
export interface ChatResponse { answer: string; sources: Source[]; conversation_id: string; hint_mode: boolean; refused: boolean; quota?: TutorQuota | null }
export interface TranscriptSegment { start_time: number; end_time: number; text: string }
export interface Job { job_id: string; job_type: string; status: 'queued' | 'running' | 'succeeded' | 'failed'; progress: number | null; message: string | null; result: any; error: string | null }

export function fmtTime(sec: number | null | undefined) {
  if (sec == null || isNaN(sec)) return '--:--';
  const s = Math.max(0, Math.floor(sec)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')) + ':' + String(r).padStart(2, '0');
}

export async function pollJob(jobId: string, onUpdate?: (j: Job) => void, signal?: AbortSignal): Promise<Job> {
  for (;;) {
    const j = await api<Job>(`/ai/jobs/${jobId}`, { signal });
    onUpdate?.(j);
    if (j.status === 'succeeded' || j.status === 'failed') return j;
    await new Promise((r) => setTimeout(r, 1200));
  }
}
