import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../../components/Icon';
import { Button, Empty, ErrorBox, IconButton, Spinner } from '../../components/ui';
import { api, errorText, mediaUrl } from '../../lib/api';
import type { ItemProps } from '../Lesson';

let pdfjsPromise: Promise<any> | null = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((m: any) => {
      m.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', document.baseURI).toString();
      return m;
    });
  }
  return pdfjsPromise;
}

/** Vẽ một trang PDF vào canvas theo bề rộng mong muốn (CSS px). */
function PageCanvas({ doc, pageNo, width, lazy = false, onVisible }: { doc: any; pageNo: number; width: number; lazy?: boolean; onVisible?: (n: number, ratio: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(!lazy);
  const [h, setH] = useState(Math.round(width * 9 / 16));

  useEffect(() => {
    if (!lazy && !onVisible) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) setVisible(true);
        onVisible?.(pageNo, e.intersectionRatio);
      }
    }, { rootMargin: '200px', threshold: [0, 0.25, 0.5, 0.75, 1] });
    io.observe(el);
    return () => io.disconnect();
  }, [lazy, onVisible, pageNo]);

  useEffect(() => {
    if (!visible || !doc || width <= 0) return;
    let task: any = null;
    let cancelled = false;
    doc.getPage(pageNo).then((page: any) => {
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale: scale * dpr });
      const canvas = ref.current;
      if (!canvas) return;
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = `${Math.floor(vp.width / dpr)}px`;
      canvas.style.height = `${Math.floor(vp.height / dpr)}px`;
      setH(Math.floor(vp.height / dpr));
      task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, canvas });
      task.promise.catch(() => {});
    });
    return () => { cancelled = true; task?.cancel?.(); };
  }, [doc, pageNo, width, visible]);

  return <canvas ref={ref} style={{ width, height: h }} aria-label={`Trang ${pageNo}`} role="img" />;
}

type TextSlide = { page: number; title: string | null; text: string };

export function SlideItem({ item, onCompleted, setContext, registerNav, goNext, query }: ItemProps) {
  const s = item.slide!;
  const isPdf = s.source_type === 'pdf';
  const stageRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<any>(null);
  const [textSlides, setTextSlides] = useState<TextSlide[] | null>(null);
  const [n, setN] = useState(s.pages || 0);
  const [page, setPage] = useState(() => Math.max(1, Number(query.get('page') || item.progress_position || 1)));
  const [mode, setMode] = useState<'single' | 'scroll'>('single');
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(800);
  const [error, setError] = useState<string | null>(null);
  const completed = useRef(item.completed);

  useEffect(() => {
    if (!s.document_id) return;
    let alive = true;
    if (isPdf && s.file_path) {
      loadPdfjs().then((pdfjs) => pdfjs.getDocument({ url: mediaUrl(s.file_path!) }).promise)
        .then((d: any) => { if (alive) { setDoc(d); setN(d.numPages); } })
        .catch((e: unknown) => alive && setError('Không mở được file slide: ' + errorText(e)));
    } else {
      api<{ slides: TextSlide[] }>(`/ai/documents/${s.document_id}/slides`).then((r) => { if (alive) { setTextSlides(r.slides); setN(r.slides.length); } })
        .catch((e) => alive && setError(errorText(e)));
    }
    return () => { alive = false; };
  }, [s.document_id, s.file_path, isPdf]);

  // bề rộng vùng hiển thị
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(280, el.clientWidth - 28)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const go = useCallback((p: number) => setPage((cur) => Math.min(Math.max(1, p), n || cur)), [n]);
  useEffect(() => { registerNav({ page: (p) => { setMode('single'); go(p); } }); }, [registerNav, go]);

  useEffect(() => {
    setContext({
      label: `Slide ${page}/${n || '?'} · ${item.title}`, focusDocumentId: s.document_id, focusPage: page,
      suggestions: ['Giải thích slide này', 'Tóm tắt các ý chính', 'Cho mình câu hỏi tự luyện'],
    });
    const id = setTimeout(() => api(`/ai/learn/items/${item.item_id}/position`, { json: { position: page } }).catch(() => {}), 800);
    if (n && page >= n && !completed.current) {
      completed.current = true;
      api<{ xp_awarded: number }>(`/ai/learn/items/${item.item_id}/complete`, { method: 'POST' })
        .then((r) => onCompleted(r.xp_awarded)).catch(() => { completed.current = false; });
    }
    return () => clearTimeout(id);
  }, [page, n, item.item_id, item.title, s.document_id, setContext, onCompleted]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (mode !== 'single') return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(page + 1); }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(page - 1); }
  };

  const visRatios = useRef<Record<number, number>>({});
  const onVisible = useCallback((p: number, r: number) => {
    visRatios.current[p] = r;
    const best = Object.entries(visRatios.current).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] > 0.4) setPage(Number(best[0]));
  }, []);

  if (!s.document_id) return <Empty title="Mục slide chưa gắn tài liệu" />;
  const w = Math.round(width * zoom);
  const ts = textSlides?.[page - 1];

  return (
    <div className="slides">
      <div className="slide-stage" ref={stageRef} tabIndex={0} onKeyDown={onKey} aria-label="Vùng xem slide">
        {error && <ErrorBox message={error} />}
        {!error && isPdf && !doc && <Spinner label="Đang mở slide…" />}
        {doc && mode === 'single' && <PageCanvas doc={doc} pageNo={page} width={w} />}
        {doc && mode === 'scroll' && (
          <div className="slide-scroll">
            {Array.from({ length: n }, (_, i) => <PageCanvas key={i} doc={doc} pageNo={i + 1} width={w} lazy onVisible={onVisible} />)}
          </div>
        )}
        {textSlides && mode === 'single' && ts && (
          <div className="text-slide"><h3>{ts.title || `Slide ${ts.page}`}</h3><div>{ts.text}</div></div>
        )}
        {textSlides && mode === 'scroll' && (
          <div className="slide-scroll" style={{ width: '100%' }}>
            {textSlides.map((x) => <div key={x.page} className="text-slide"><h3>{x.title || `Slide ${x.page}`}</h3><div>{x.text}</div></div>)}
          </div>
        )}
      </div>

      <div className="slide-toolbar">
        <div className="seg" role="group" aria-label="Chế độ xem">
          <button className={mode === 'single' ? 'on' : ''} aria-pressed={mode === 'single'} onClick={() => setMode('single')}>Từng trang</button>
          <button className={mode === 'scroll' ? 'on' : ''} aria-pressed={mode === 'scroll'} onClick={() => setMode('scroll')}>Cuộn dọc</button>
        </div>
        <IconButton icon="zoomOut" label="Thu nhỏ" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(1)))} />
        <span style={{ fontWeight: 800, fontSize: 14, minWidth: 44, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
        <IconButton icon="zoomIn" label="Phóng to" onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(1)))} />
        <span style={{ flex: 1 }} />
        <IconButton icon="chevronLeft" label="Trang trước" onClick={() => go(page - 1)} disabled={page <= 1} />
        <span style={{ fontWeight: 900 }} aria-live="polite">{page} / {n || '?'}</span>
        <IconButton icon="chevronRight" label="Trang sau" onClick={() => go(page + 1)} disabled={!!n && page >= n} />
        <IconButton icon="fullscreen" label="Toàn màn hình" onClick={() => stageRef.current?.requestFullscreen?.().catch(() => {})} />
      </div>

      {doc && (
        <div className="thumbs" aria-label="Danh sách trang">
          {Array.from({ length: n }, (_, i) => (
            <button key={i} className={`thumb ${page === i + 1 ? 'thumb-on' : ''}`} onClick={() => { setMode('single'); go(i + 1); }} aria-label={`Trang ${i + 1}`} aria-current={page === i + 1}>
              <PageCanvas doc={doc} pageNo={i + 1} width={112} lazy />
              <span className="thumb-n">{i + 1}</span>
            </button>
          ))}
        </div>
      )}
      {textSlides && (
        <div className="thumbs">
          {textSlides.map((x) => (
            <button key={x.page} className={`pill ${page === x.page ? 'pill-on' : ''}`} onClick={() => { setMode('single'); go(x.page); }}>{x.page}</button>
          ))}
        </div>
      )}

      <div className="content-head">
        <div><h1>{item.title}</h1><span className="muted">{s.title}</span></div>
        <div className="row">
          {s.file_path && <a className="btn btn-md btn-ghost" href={mediaUrl(s.file_path)} target="_blank" rel="noreferrer"><Icon name="external" size={18} />Mở file</a>}
          {goNext && <Button onClick={goNext} icon="chevronRight">Mục tiếp theo</Button>}
        </div>
      </div>
      {s.notes && (
        <section className="card col" style={{ gap: 6 }}>
          <h2 style={{ fontSize: 16 }}>Ghi chú của giảng viên</h2>
          <p className="muted" style={{ fontWeight: 700 }}>{s.notes}</p>
        </section>
      )}
    </div>
  );
}
