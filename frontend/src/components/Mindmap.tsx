import { useState } from 'react';
import { api, errorText, fmtTime, type Source } from '../lib/api';
import { isTeacher, useAuth } from '../lib/auth';
import { useAsync } from '../lib/hooks';
import { Icon } from './Icon';
import { Badge, Button, confirmDialog, Empty, ErrorBox, Modal, Spinner, useToast } from './ui';

export interface MindNode { id: string; title: string; note?: string; sources?: Source[]; children?: MindNode[] }
interface MindmapDoc { mindmap_id: string; version: number; status: 'draft' | 'approved' | 'archived'; tree: MindNode; created_at: string | null }
interface MindmapResp { lesson_code: string; lesson_title: string; approved: MindmapDoc | null; latest?: MindmapDoc | null }

function sourceLabel(s: Source) {
  if (s.source_type === 'video') return `Video ${fmtTime(s.start_time)}`;
  if (s.page) return `Slide trang ${s.page}`;
  return 'Bài đọc';
}

/** Một nhánh của cây: thu gọn / mở rộng, mỗi nguồn là nút nhảy tới đúng phần bài giảng. */
function Branch({ node, depth, editing, onRename, onSource }: {
  node: MindNode; depth: number; editing: boolean; onRename: (id: string, title: string) => void; onSource: (s: Source) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const kids = node.children || [];
  return (
    <li className={`mm-node mm-d${Math.min(depth, 3)}`}>
      <div className="mm-card">
        {kids.length > 0 && (
          <button className="mm-toggle" aria-expanded={open} aria-label={open ? 'Thu gọn' : 'Mở rộng'} onClick={() => setOpen(!open)}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
          </button>
        )}
        <div className="col" style={{ gap: 4, flex: 1, minWidth: 0 }}>
          {editing
            ? <input className="input" value={node.title} aria-label="Tên nút" onChange={(e) => onRename(node.id, e.target.value)} />
            : <strong className="mm-title">{node.title}</strong>}
          {node.note && <span className="muted small">{node.note}</span>}
          {!!node.sources?.length && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {node.sources.map((s) => (
                <button key={s.label} className="src" onClick={() => onSource(s)} title={s.display}>
                  <Icon name={s.source_type === 'video' ? 'play' : s.page ? 'slide' : 'book'} size={14} />
                  <span>{sourceLabel(s)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {open && kids.length > 0 && (
        <ul className="mm-children">
          {kids.map((c) => <Branch key={c.id} node={c} depth={depth + 1} editing={editing} onRename={onRename} onSource={onSource} />)}
        </ul>
      )}
    </li>
  );
}

function renameIn(node: MindNode, id: string, title: string): MindNode {
  if (node.id === id) return { ...node, title };
  return { ...node, children: (node.children || []).map((c) => renameIn(c, id, title)) };
}

/** Sơ đồ tư duy của bài: học sinh xem bản đã duyệt; giáo viên tạo bằng AI, sửa tên nút, duyệt. */
export function MindmapModal({ lessonCode, onClose, onSource }: { lessonCode: string; onClose: () => void; onSource: (s: Source) => void }) {
  const { user } = useAuth();
  const teacher = isTeacher(user);
  const toast = useToast();
  const data = useAsync((s) => api<MindmapResp>(`/ai/learn/lessons/${encodeURIComponent(lessonCode)}/mindmap`, { signal: s }), [lessonCode]);
  const [busy, setBusy] = useState(false);
  const [editTree, setEditTree] = useState<MindNode | null>(null);
  const doc = teacher ? (data.data?.latest || data.data?.approved) : data.data?.approved;
  const tree = editTree || doc?.tree;

  const generate = async () => {
    if (doc && !await confirmDialog('Tạo sơ đồ mới bằng AI? Bản hiện tại vẫn được giữ đến khi bạn duyệt bản mới.')) return;
    setBusy(true);
    try { await api(`/ai/lessons/${encodeURIComponent(lessonCode)}/mindmap/generate`, { method: 'POST' }); toast('Đã tạo sơ đồ nháp', 'success'); setEditTree(null); data.reload(); }
    catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  const save = async (status?: 'approved') => {
    if (!doc) return;
    setBusy(true);
    try {
      await api(`/ai/mindmaps/${doc.mindmap_id}`, { method: 'PATCH', json: { ...(editTree && { tree: editTree }), ...(status && { status }) } });
      toast(status ? 'Đã duyệt, học sinh đã xem được' : 'Đã lưu', 'success');
      setEditTree(null); data.reload();
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  const jump = (s: Source) => { onClose(); onSource(s); };

  return (
    <Modal open onClose={onClose} title="Sơ đồ tư duy" wide dismissable={!busy}>
      <div className="modal-body">
        {data.loading && !data.data && <Spinner />}
        {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
        {teacher && data.data && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {doc && <Badge tone={doc.status === 'approved' ? 'green' : 'yellow'}>{doc.status === 'approved' ? `Đã duyệt · bản ${doc.version}` : `Nháp · bản ${doc.version}`}</Badge>}
            <Button size="sm" variant="soft" icon="sparkle" loading={busy} onClick={generate}>{doc ? 'Tạo lại bằng AI' : 'Tạo sơ đồ bằng AI'}</Button>
            {doc && !editTree && <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditTree(doc.tree)}>Sửa tên nút</Button>}
            {editTree && <Button size="sm" variant="ghost" disabled={busy} onClick={() => save()}>Lưu</Button>}
            {editTree && <Button size="sm" variant="ghost" onClick={() => setEditTree(null)}>Hủy sửa</Button>}
            {doc && (doc.status !== 'approved' || editTree) && <Button size="sm" icon="check" loading={busy} onClick={() => save('approved')}>Duyệt cho học sinh</Button>}
          </div>
        )}
        {data.data && !tree && (
          <Empty title="Bài này chưa có sơ đồ tư duy">
            {teacher ? 'Bấm “Tạo sơ đồ bằng AI” để tổng hợp từ bài đọc, slide và lời giảng của bài.' : 'Giáo viên chưa duyệt sơ đồ cho bài này.'}
          </Empty>
        )}
        {tree && (
          <div className="mindmap">
            <div className="mm-root"><Icon name="bulb" size={20} /><strong>{tree.title}</strong></div>
            <ul className="mm-children mm-top">
              {(tree.children || []).map((c) => (
                <Branch key={c.id} node={c} depth={1} editing={!!editTree} onSource={jump}
                  onRename={(id, title) => setEditTree((t) => (t ? renameIn(t, id, title) : t))} />
              ))}
            </ul>
            <p className="muted small" style={{ marginTop: 10 }}>Bấm vào nguồn (video, slide, bài đọc) để mở đúng phần bài giảng.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
