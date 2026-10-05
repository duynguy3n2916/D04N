import { useRef, useState } from 'react';
import { PageHeader } from '../../components/AppShell';
import { Badge, Button, Empty, ErrorBox, Field, IconButton, Modal, Spinner, useToast } from '../../components/ui';
import { api, errorText, mediaUrl, pollJob } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { LessonSelect } from './QuestionBank';

interface Doc { document_id: string; title: string; source_type: string; source_id: string | null; status: string; error: string | null; version: number; lesson_id: string | null; class_id: string | null; chunks: number; created_at: string }
interface Chunk { chunk_index: number; page: number | null; section: string | null; start_time: number | null; content: string }

const STATUS: Record<string, { tone: 'green' | 'yellow' | 'red' | 'gray'; label: string }> = {
  ready: { tone: 'green', label: 'Sẵn sàng' }, processing: { tone: 'yellow', label: 'Đang xử lý' }, pending: { tone: 'yellow', label: 'Chờ xử lý' },
  failed: { tone: 'red', label: 'Lỗi' }, deleted: { tone: 'gray', label: 'Đã xóa' },
};

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
    if (!window.confirm(`Xóa “${d.title}” khỏi Knowledge Base?`)) return;
    try { await api(`/ai/documents/${d.document_id}`, { method: 'DELETE' }); docs.reload(); } catch (e) { toast(errorText(e), 'error'); }
  };

  return (
    <>
      <PageHeader title="Học liệu" sub="Những gì Tutor AI được phép dùng để trả lời: tài liệu, bài đọc và phụ đề video của từng bài." />
      <div className="card row" style={{ marginBottom: 16, alignItems: 'flex-end' }}>
        <Field label="Tải tài liệu cho bài"><LessonSelect value={uploadLesson} onChange={setUploadLesson} /></Field>
        <input ref={fileRef} type="file" hidden accept=".pdf,.docx,.pptx,.txt,.md" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
        <Button icon="upload" disabled={!uploadLesson || !!progress} onClick={() => fileRef.current?.click()}>Chọn file (PDF, DOCX, PPTX, TXT, MD)</Button>
        {progress && <span className="small" style={{ fontWeight: 800 }} aria-live="polite">{progress}</span>}
      </div>
      <div className="row" style={{ marginBottom: 12 }}><Field label="Lọc theo bài"><LessonSelect value={lesson} onChange={setLesson} allowAll /></Field></div>
      {docs.loading && !docs.data && <Spinner />}
      {docs.error && <ErrorBox message={docs.error} onRetry={docs.reload} />}
      {docs.data && !docs.data.length && <Empty title="Chưa có học liệu" />}
      {!!docs.data?.length && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Tên</th><th>Loại</th><th>Bài</th><th>Trạng thái</th><th>Số đoạn</th><th /></tr></thead>
            <tbody>
              {docs.data.map((d) => (
                <tr key={d.document_id}>
                  <td style={{ fontWeight: 800 }}>{d.title}{d.version > 1 && <span className="muted small"> · v{d.version}</span>}</td>
                  <td><Badge tone={d.source_type === 'video' ? 'purple' : d.source_type === 'lesson' ? 'blue' : 'gray'}>{d.source_type === 'video' ? 'Phụ đề video' : d.source_type === 'lesson' ? 'Bài đọc' : d.source_type.toUpperCase()}</Badge></td>
                  <td className="small">{d.lesson_id || '—'}</td>
                  <td><Badge tone={STATUS[d.status]?.tone || 'gray'}>{STATUS[d.status]?.label || d.status}</Badge>{d.error && <div className="small" style={{ color: 'var(--red-text)' }}>{d.error}</div>}</td>
                  <td>{d.chunks}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <IconButton icon="list" label="Xem các đoạn" onClick={() => setView(d)} />
                    {['pdf', 'pptx', 'docx', 'txt', 'md'].includes(d.source_type) && <a className="iconbtn" href={mediaUrl(`/ai/documents/${d.document_id}/file`)} target="_blank" rel="noreferrer" aria-label="Mở file gốc" title="Mở file gốc">↗</a>}
                    <IconButton icon="trash" label="Xóa" onClick={() => remove(d)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view && <ChunksDialog doc={view} onClose={() => setView(null)} />}
    </>
  );
}

function ChunksDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const r = useAsync((s) => api<{ chunks: Chunk[] }>(`/ai/documents/${doc.document_id}/chunks?limit=200`, { signal: s }), [doc.document_id]);
  return (
    <Modal open onClose={onClose} title={doc.title} wide>
      <div className="modal-body">
        {r.loading && <Spinner />}
        {r.error && <ErrorBox message={r.error} />}
        {r.data?.chunks.map((c) => (
          <div key={c.chunk_index} className="card col" style={{ gap: 4, padding: '12px 14px' }}>
            <span className="muted small" style={{ fontWeight: 800 }}>
              Đoạn {c.chunk_index + 1}{c.page ? ` · trang ${c.page}` : ''}{c.section ? ` · ${c.section}` : ''}{c.start_time != null ? ` · ${Math.floor(c.start_time / 60)}:${String(Math.floor(c.start_time % 60)).padStart(2, '0')}` : ''}
            </span>
            <p className="small" style={{ whiteSpace: 'pre-wrap', fontWeight: 600 }}>{c.content}</p>
          </div>
        ))}
      </div>
    </Modal>
  );
}
