import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { renderMarkdown } from '../../components/Markdown';
import { Button, Empty, useToast } from '../../components/ui';
import { api, storage } from '../../lib/api';
import type { ItemProps } from '../Lesson';

/** Bài đọc: markdown + mục lục theo vị trí cuộn + chọn đoạn văn để hỏi Tutor / ghi chú. */
export function ReadingItem({ item, onCompleted, setContext, askTutor, goNext }: ItemProps) {
  const md = item.reading?.content_md || '';
  const { html, headings } = useMemo(() => renderMarkdown(md), [md]);
  const articleRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(headings[0]?.id || null);
  const [sel, setSel] = useState<{ text: string; x: number; y: number } | null>(null);
  const noteKey = `mam.notes.${item.item_id}`;
  const [notes, setNotes] = useState(() => storage.get(noteKey) || '');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(item.completed);
  const toast = useToast();
  const minutes = Math.max(1, Math.round(md.split(/\s+/).length / 200));

  useEffect(() => { storage.set(noteKey, notes || null); }, [noteKey, notes]);

  useEffect(() => {
    setContext({
      label: `Bài đọc · ${item.title}`, focusDocumentId: item.reading?.document_id || null,
      suggestions: ['Tóm tắt bài đọc này', 'Giải thích khái niệm khó nhất', 'Cho mình 3 câu hỏi tự luyện'],
    });
  }, [item.title, item.reading?.document_id, setContext]);

  // theo dõi tiêu đề đang đọc
  useEffect(() => {
    const root = articleRef.current;
    if (!root || !headings.length) return;
    const scroller = document.getElementById('lesson-content');
    const io = new IntersectionObserver((entries) => {
      const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (vis[0]) setActive(vis[0].target.id);
    }, { root: scroller && scroller.scrollHeight > scroller.clientHeight ? scroller : null, rootMargin: '0px 0px -65% 0px' });
    headings.forEach((h) => { const el = root.querySelector(`#${CSS.escape(h.id)}`); if (el) io.observe(el); });
    return () => io.disconnect();
  }, [html, headings]);

  // thanh công cụ khi bôi đen
  useEffect(() => {
    const onUp = () => {
      setTimeout(() => {
        const s = window.getSelection();
        const root = articleRef.current;
        if (!s || s.isCollapsed || !root || !s.rangeCount) { setSel(null); return; }
        const range = s.getRangeAt(0);
        if (!root.contains(range.commonAncestorContainer)) { setSel(null); return; }
        const text = s.toString().trim();
        if (text.length < 3) { setSel(null); return; }
        const r = range.getBoundingClientRect();
        const base = root.getBoundingClientRect();
        setSel({ text: text.slice(0, 1200), x: r.left + r.width / 2 - base.left, y: r.top - base.top - 8 });
      }, 0);
    };
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keyup', onUp);
    return () => { document.removeEventListener('mouseup', onUp); document.removeEventListener('keyup', onUp); };
  }, []);

  const jump = (id: string) => {
    articleRef.current?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActive(id);
  };

  const finish = async () => {
    setBusy(true);
    try {
      if (!done) {
        const r = await api<{ xp_awarded: number }>(`/ai/learn/items/${item.item_id}/complete`, { method: 'POST' });
        setDone(true);
        onCompleted(r.xp_awarded);
      }
      goNext?.();
    } catch (e) {
      toast(String((e as Error).message), 'error');
    } finally { setBusy(false); }
  };

  if (!md.trim()) return <Empty title="Bài đọc chưa có nội dung" />;

  return (
    <div className="reading">
      <div className="reading-article" ref={articleRef}>
        <div className="row muted small" style={{ gap: 8, marginBottom: 10, fontWeight: 800 }}>
          <Icon name="book" size={16} />Bài đọc · khoảng {minutes} phút{done && <> · <span style={{ color: 'var(--green-text)' }}>đã đọc xong</span></>}
        </div>
        <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
        {sel && (
          <div className="sel-toolbar" style={{ left: sel.x, top: sel.y }} onMouseDown={(e) => e.preventDefault()}>
            <button onClick={() => { askTutor(sel.text); setSel(null); window.getSelection()?.removeAllRanges(); }}>
              <Icon name="sparkle" size={16} />Hỏi Tutor về đoạn này
            </button>
            <button onClick={() => { setNotes((n) => (n ? n + '\n\n' : '') + `> ${sel.text}\n`); setSel(null); toast('Đã thêm vào ghi chú', 'success'); }}>
              <Icon name="note" size={16} />Thêm vào ghi chú
            </button>
          </div>
        )}

        <section className="card col" style={{ gap: 8, marginTop: 24 }}>
          <h2 style={{ fontSize: 16 }}>Ghi chú của bạn</h2>
          <label className="sr-only" htmlFor="reading-notes">Ghi chú</label>
          <textarea id="reading-notes" className="input note-area" value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="Bôi đen một đoạn trong bài rồi bấm “Thêm vào ghi chú”, hoặc gõ trực tiếp ở đây. Ghi chú được lưu trên trình duyệt này." />
        </section>

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 20 }}>
          <Button size="lg" loading={busy} icon="check" onClick={finish} disabled={done && !goNext}>
            {done ? (goNext ? 'Mục tiếp theo' : 'Đã đọc xong') : goNext ? 'Đã đọc xong · tiếp tục' : 'Đánh dấu đã đọc xong'}
          </Button>
        </div>
      </div>

      {headings.length > 1 && (
        <nav className="reading-toc" aria-label="Mục lục bài đọc">
          <span className="outline-title">MỤC LỤC</span>
          {headings.map((h) => (
            <button key={h.id} className={`toc-link ${h.level === 3 ? 'toc-l3' : ''} ${active === h.id ? 'toc-on' : ''}`} onClick={() => jump(h.id)}>{h.text}</button>
          ))}
        </nav>
      )}
    </div>
  );
}
