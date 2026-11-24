import { useRef, useState } from 'react';
import { PageHeader } from '../../components/AppShell';
import { Icon, type IconName } from '../../components/Icon';
import { Drawer, FilterPills, PillSelect, SearchBox, StatusTag, Toolbar } from '../../components/Manage';
import { Button, confirmDialog, Empty, ErrorBox, IconButton, Spinner, useToast } from '../../components/ui';
import { api, errorText, mediaUrl, pollJob } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { useLessonCodes } from './QuestionBank';

interface Doc { document_id: string; title: string; source_type: string; source_id: string | null; status: string; error: string | null; version: number; lesson_id: string | null; class_id: string | null; chunks: number; created_at: string }
interface Chunk { chunk_index: number; page: number | null; section: string | null; start_time: number | null; content: string }

const STATUS: Record<string, { tone: 'ok' | 'wait' | 'bad' | 'muted'; label: string }> = {
  ready: { tone: 'ok', label: 'Đã lập chỉ mục' }, processing: { tone: 'wait', label: 'Đang xử lý' }, pending: { tone: 'wait', label: 'Chờ xử lý' },
  failed: { tone: 'bad', label: 'Lỗi' }, deleted: { tone: 'muted', label: 'Đã xóa' },
};
type Kind = '' | 'file' | 'lesson' | 'video';
const kindOf = (d: Doc): Kind => (d.source_type === 'video' ? 'video' : d.source_type === 'lesson' ? 'lesson' : 'file');
const KIND_ICON: Record<Exclude<Kind, ''>, IconName> = { file: 'doc', lesson: 'book', video: 'video' };
const typeLabel = (d: Doc) => (d.source_type === 'video' ? 'Phụ đề video' : d.source_type === 'lesson' ? 'Bài đọc' : d.source_type.toUpperCase());
const FILE_TYPES = ['pdf', 'pptx', 'docx', 'txt', 'md'];

/** Học liệu trong Knowledge Base: tài liệu, bài đọc, phụ đề video đã được chia đoạn để Tutor truy xuất. */
export function Documents() {
  const toast = useToast();
  const [lesson, setLesson] = useState('');
  const docs = useAsync((s) => api<Doc[]>(`/ai/documents${lesson ? `?lesson_id=${encodeURIComponent(lesson)}` : ''}`, { signal: s }), [lesson]);
  const [view, setView] = useState<Doc | null>(null);
  const [uploadLesson, setUploadLesson] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    if (!uploadLesson) { toast('Chọn bài học trước khi tải lên', 'error'); return; }
    const fd = new FormData(); fd.append('file', file); fd.append('lesson_id', uploadLesson);
    setProgress('Đang tải lên…');
    try {
      const r = await api<{ job_id?: string; duplicate?: boolean; message?: string }>('/ai/documents/index', { form: fd });
      if (r.duplicate) { toast(r.message || 'Tài liệu đã có', 'info'); setProgress(null); return; }
      if (r.job_id) {
        const j = await pollJob(r.job_id, (x) => setProgress(`Đang xử lý ${file.name}… ${x.progress != null ? Math.round(x.progress * 100) + '%' : ''}`));
        if (j.status === 'failed') throw new Error(j.error || 'Xử lý thất bại');
      }
      toast('Đã nạp tài liệu vào Knowledge Base', 'success');
    } catch (e) { toast(errorText(e), 'error'); }
    finally { setProgress(null); docs.reload(); if (fileRef.current) fileRef.current.value = ''; }
  };
  const remove = async (d: Doc) => {
    if (!await confirmDialog(`Xóa “${d.title}” khỏi Knowledge Base?`, { danger: true, okLabel: 'Xóa' })) return;
    try { await api(`/ai/documents/${d.document_id}`, { method: 'DELETE' }); docs.reload(); } catch (e) { toast(errorText(e), 'error'); }
  };

  const lessons = useLessonCodes();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<Kind>('');
  const all = docs.data || [];
  const rows = all.filter((d) => (!kind || kindOf(d) === kind) && (!q || d.title.toLowerCase().includes(q.toLowerCase())));
  const count = (k: Kind) => all.filter((d) => kindOf(d) === k).length;
  const failed = all.filter((d) => d.status === 'failed').length;

  return (
    <>
      <PageHeader title="Học liệu" sub="Những gì Tutor AI được phép dùng để trả lời: tài liệu, bài đọc và phụ đề video của từng bài."
        actions={<div className="row" style={{ gap: 8 }}>
          <PillSelect label="Bài nhận tài liệu mới" value={uploadLesson} onChange={setUploadLesson}>
            <option value="">Tải lên cho bài…</option>
            {lessons.data?.map((l) => <option key={l.code} value={l.code}>{l.code} · {l.title}</option>)}
          </PillSelect>
          <input ref={fileRef} type="file" hidden accept=".pdf,.docx,.pptx,.txt,.md" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
          <Button icon="upload" disabled={!uploadLesson || !!progress} onClick={() => fileRef.current?.click()} title="PDF, DOCX, PPTX, TXT, MD">Tải tài liệu</Button>
        </div>} />
      {progress && <div className="notice" aria-live="polite" style={{ marginBottom: 14 }}>{progress}</div>}
      <Toolbar>
        <SearchBox value={q} onChange={setQ} placeholder="Tìm học liệu…" />
        <PillSelect label="Lọc theo bài" value={lesson} onChange={setLesson}>
          <option value="">Tất cả bài</option>
          {lessons.data?.map((l) => <option key={l.code} value={l.code}>{l.code} · {l.title}</option>)}
        </PillSelect>
        <FilterPills<Kind> label="Loại" value={kind} onChange={setKind}
          options={[{ id: '', label: 'Tất cả', count: all.length }, { id: 'file', label: 'Tài liệu', count: count('file') }, { id: 'lesson', label: 'Bài đọc', count: count('lesson') }, { id: 'video', label: 'Phụ đề video', count: count('video') }]} />
        <span className="grow" />
        {failed > 0 && <StatusTag tone="bad">{failed} học liệu lỗi</StatusTag>}
      </Toolbar>
      {docs.loading && !docs.data && <Spinner />}
      {docs.error && <ErrorBox message={docs.error} onRetry={docs.reload} />}
      {docs.data && !all.length && <Empty title={lesson ? 'Bài này chưa có học liệu' : 'Chưa có học liệu'}>Chọn bài ở góc trên rồi bấm “Tải tài liệu”. Bài đọc và phụ đề video được thêm tự động.</Empty>}
      {!!all.length && !rows.length && <Empty title="Không có học liệu nào khớp">Thử bỏ bớt bộ lọc hoặc từ khóa.</Empty>}
      {!!rows.length && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Tên</th><th>Bài</th><th>Trạng thái trong Tutor</th><th>Số đoạn</th><th className="td-actions"><span className="sr-only">Thao tác</span></th></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.document_id} className={`row-click ${view?.document_id === d.document_id ? 'row-on' : ''}`} onClick={() => setView(d)}>
                  <td className="td-main">
                    <span className="doc-cell"><span className={`doc-ico doc-${kindOf(d)}`}><Icon name={KIND_ICON[kindOf(d) as Exclude<Kind, ''>]} size={18} /></span>
                      <span style={{ minWidth: 0 }}><strong>{d.title}</strong><span className="td-sub">{typeLabel(d)}{d.version > 1 ? ` · phiên bản ${d.version}` : ''}</span></span></span>
                  </td>
                  <td className="td-num">{d.lesson_id || '—'}</td>
                  <td><StatusTag tone={STATUS[d.status]?.tone || 'muted'}>{STATUS[d.status]?.label || d.status}</StatusTag>{d.error && <span className="td-sub" style={{ color: 'var(--red-text)' }}>{d.error}</span>}</td>
                  <td className="td-num">{d.chunks}</td>
                  <td className="td-actions" onClick={(e) => e.stopPropagation()}>
                    {FILE_TYPES.includes(d.source_type) && <a className="iconbtn" href={mediaUrl(`/ai/documents/${d.document_id}/file`)} target="_blank" rel="noreferrer" aria-label="Mở file gốc" title="Mở file gốc"><Icon name="external" size={18} /></a>}
                    <IconButton icon="trash" label="Xóa" onClick={() => remove(d)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view && <DocDrawer key={view.document_id} doc={view} onClose={() => setView(null)} />}
    </>
  );
}

/** Ngăn bên phải: xem trước file PDF và các đoạn Tutor dùng để trả lời. */
function DocDrawer({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const isPdf = doc.source_type === 'pdf';
  const [tab, setTab] = useState<'preview' | 'chunks'>(isPdf ? 'preview' : 'chunks');
  const r = useAsync((s) => api<{ chunks: Chunk[] }>(`/ai/documents/${doc.document_id}/chunks?limit=200`, { signal: s }), [doc.document_id]);
  return (
    <Drawer title={doc.title} onClose={onClose} wide={isPdf && tab === 'preview'}>
      <div className="row" style={{ gap: 8 }}>
        <StatusTag tone={STATUS[doc.status]?.tone || 'muted'}>{STATUS[doc.status]?.label || doc.status}</StatusTag>
        <span className="muted small">{typeLabel(doc)} · {doc.chunks} đoạn{doc.lesson_id ? ` · bài ${doc.lesson_id}` : ''}</span>
      </div>
      {isPdf && <FilterPills label="Chế độ xem" value={tab} onChange={setTab} options={[{ id: 'preview', label: 'Xem trước' }, { id: 'chunks', label: 'Các đoạn cho Tutor' }]} />}
      {tab === 'preview' && isPdf ? (
        <iframe className="doc-preview" title={`Xem trước ${doc.title}`} src={mediaUrl(`/ai/documents/${doc.document_id}/file`)} />
      ) : (
        <>
          {r.loading && <Spinner />}
          {r.error && <ErrorBox message={r.error} />}
          {r.data?.chunks.map((c) => (
            <div key={c.chunk_index} className="chunk">
              <span className="td-sub">
                Đoạn {c.chunk_index + 1}{c.page ? ` · trang ${c.page}` : ''}{c.section ? ` · ${c.section}` : ''}{c.start_time != null ? ` · ${Math.floor(c.start_time / 60)}:${String(Math.floor(c.start_time % 60)).padStart(2, '0')}` : ''}
              </span>
              <p>{c.content}</p>
            </div>
          ))}
        </>
      )}
    </Drawer>
  );
}
