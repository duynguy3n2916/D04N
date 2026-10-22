// Thành phần dùng chung cho mạng xã hội học tập: ảnh đại diện, thời gian tương đối, ô nhập có gợi ý @tên, chọn ảnh.
import { useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { api, errorText, mediaUrl } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync } from '../lib/hooks';
import { Icon } from './Icon';
import { useToast } from './ui';

export interface Member { user_id: string; name: string; role: string }

const COLORS = ['#58cc02', '#1cb0f6', '#ff9600', '#ce82ff', '#ff4b4b', '#2b70c9'];

export function Avatar({ name, id, size = 36 }: { name: string; id: string; size?: number }) {
  const color = COLORS[[...id].reduce((s, c) => s + c.charCodeAt(0), 0) % COLORS.length];
  return (
    <span aria-hidden="true" style={{ width: size, height: size, borderRadius: '50%', background: color, color: '#fff', flex: 'none',
      display: 'inline-grid', placeItems: 'center', fontWeight: 900, fontSize: size * 0.42 }}>
      {(name || id || '?').trim().slice(0, 1).toUpperCase()}
    </span>
  );
}

export function timeAgo(iso: string | null | undefined) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'vừa xong';
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} ngày trước`;
  return new Date(iso).toLocaleDateString('vi-VN');
}

/** Danh sách thành viên lớp (gợi ý @tên, mở tin nhắn riêng). */
export function useMembers(classId: string) {
  return useAsync((s) => (classId ? api<Member[]>(`/ai/forum/classes/${encodeURIComponent(classId)}/members`, { signal: s }) : Promise.resolve([])), [classId]);
}

/** Ô nhập có gợi ý @tên: gõ "@" rồi vài ký tự để chọn thành viên cùng lớp. */
export function MentionTextarea({ value, onChange, members, placeholder, rows = 3, maxLength = 5000, autoFocus, onSubmit }: {
  value: string; onChange: (v: string) => void; members: Member[]; placeholder?: string; rows?: number; maxLength?: number;
  autoFocus?: boolean; onSubmit?: () => void;
}) {
  const { user } = useAuth();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const matches = query === null ? [] : members.filter((m) => m.user_id !== user?.user_id).filter((m) => m.user_id.includes(query) || m.name.toLowerCase().includes(query)).slice(0, 6);
  const detect = (text: string, caret: number) => {
    const m = /(^|\s)@([\w.-]*)$/.exec(text.slice(0, caret));
    setQuery(m ? m[2].toLowerCase() : null);
  };
  const pick = (m: Member) => {
    const el = ref.current;
    const caret = el?.selectionStart ?? value.length;
    const before = value.slice(0, caret).replace(/@([\w.-]*)$/, `@${m.user_id} `);
    onChange(before + value.slice(caret));
    setQuery(null);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(before.length, before.length); });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length && (e.key === 'Enter' || e.key === 'Tab')) { e.preventDefault(); pick(matches[0]); return; }
    if (e.key === 'Escape') setQuery(null);
    if (onSubmit && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSubmit(); }
  };
  return (
    <div className="sn-mention">
      <textarea ref={ref} className="input" value={value} rows={rows} maxLength={maxLength} placeholder={placeholder} autoFocus={autoFocus}
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) => { onChange(e.target.value); detect(e.target.value, e.target.selectionStart); }}
        onKeyDown={onKey} onBlur={() => setTimeout(() => setQuery(null), 150)} />
      {matches.length > 0 && (
        <div className="card col mention-pop" role="listbox" aria-label="Gợi ý nhắc tên">
          {matches.map((m) => (
            <button key={m.user_id} type="button" role="option" aria-selected={false} className="mention-item" onMouseDown={(e) => { e.preventDefault(); pick(m); }}>
              <Avatar name={m.name} id={m.user_id} size={24} /><span><b>{m.name}</b> <span className="muted small">@{m.user_id}</span></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface PickedImage { image_id: string; url: string }

/** Chọn tối đa 4 ảnh, tải lên ngay để lấy mã ảnh đính kèm. */
export function ImagePicker({ classId, images, onChange }: { classId: string; images: PickedImage[]; onChange: (v: PickedImage[]) => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    const out = [...images];
    for (const f of Array.from(files).slice(0, 4 - images.length)) {
      if (f.size > 5 * 1024 * 1024) { toast(`${f.name} lớn hơn 5 MB`, 'error'); continue; }
      const fd = new FormData();
      fd.append('file', f);
      try { out.push(await api<PickedImage>(`/ai/forum/classes/${encodeURIComponent(classId)}/images`, { form: fd })); }
      catch (e) { toast(errorText(e), 'error'); }
    }
    onChange(out);
    setBusy(false);
    if (input.current) input.current.value = '';
  };
  return (
    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      {images.map((im) => (
        <span key={im.image_id} className="img-thumb">
          <img src={mediaUrl(im.url)} alt="Ảnh đính kèm" />
          <button type="button" aria-label="Bỏ ảnh" onClick={() => onChange(images.filter((x) => x.image_id !== im.image_id))}><Icon name="x" size={14} /></button>
        </span>
      ))}
      {images.length < 4 && (
        <button type="button" className="chip" disabled={busy} onClick={() => input.current?.click()}>
          <Icon name="upload" size={16} /> {busy ? 'Đang tải ảnh…' : 'Thêm ảnh'}
        </button>
      )}
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(e) => pick(e.target.files)} />
    </div>
  );
}

/** Lưới ảnh trong bài / bình luận; bấm để mở ảnh gốc ở thẻ mới. */
export function ImageGrid({ urls }: { urls: string[] }) {
  if (!urls?.length) return null;
  return (
    <div className={`img-grid img-grid-${Math.min(urls.length, 4)}`}>
      {urls.map((u) => <a key={u} href={mediaUrl(u)} target="_blank" rel="noreferrer"><img src={mediaUrl(u)} alt="Ảnh đính kèm" loading="lazy" /></a>)}
    </div>
  );
}
