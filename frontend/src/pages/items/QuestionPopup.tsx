import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../../components/Icon';
import { Markdown } from '../../components/Markdown';
import { Button } from '../../components/ui';
import { fmtTime, type AnswerResult, type PublicQuestion } from '../../lib/api';

/** Popup câu hỏi giữa video: chọn → Kiểm tra → giải thích → "Xem tiếp video" mới đóng. */
export function QuestionPopup({ question, deadlineAt, result, onSubmit, onTimeout, onContinue, onAskTutor, onSeek }: {
  question: PublicQuestion | null;
  deadlineAt: number | null;
  result: AnswerResult | null;
  onSubmit: (selectedIndex: number | null, text: string | null) => Promise<void>;
  onTimeout: () => Promise<void>;
  onContinue: () => Promise<void>;
  onAskTutor: () => void;
  onSeek?: (seconds: number | null | undefined) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const firedTimeout = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const hasOptions = !!question?.options?.length;

  useEffect(() => { setSelected(null); setText(''); firedTimeout.current = false; }, [question?.question_id]);
  useEffect(() => { ref.current?.focus(); }, [question?.question_id, !!result]);

  useEffect(() => {
    if (!deadlineAt || result) { setLeft(null); return; }
    const tick = () => {
      const s = Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000));
      setLeft(s);
      if (s <= 0 && !firedTimeout.current) {
        firedTimeout.current = true;
        setBusy(true);
        onTimeout().finally(() => setBusy(false));
      }
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [deadlineAt, result, onTimeout]);

  const check = async () => {
    if (busy || result) return;
    if (hasOptions ? selected === null : !text.trim()) return;
    setBusy(true);
    try { await onSubmit(hasOptions ? selected : null, hasOptions ? null : text.trim()); } finally { setBusy(false); }
  };
  const cont = async () => { setBusy(true); try { await onContinue(); } finally { setBusy(false); } };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
    if (!result && hasOptions && /^[1-8]$/.test(e.key)) {
      const i = Number(e.key) - 1;
      if (i < (question?.options?.length || 0)) setSelected(i);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (result) cont(); else check();
    }
  };

  const timeout = result?.type === 'timeout';
  const ok = result?.is_correct === true;
  const correctIdx = result?.correct_index ?? null;

  return (
    <div className="overlay">
      <div className="modal qmodal" role="dialog" aria-modal="true" aria-labelledby="qtitle" tabIndex={-1} ref={ref} onKeyDown={onKey}>
        <div className="modal-body">
          <div className="qhead">
            <span className={`qkicker ${question?.origin === 'agent' ? 'qkicker-agent' : ''}`}>
              <Icon name={question?.origin === 'agent' ? 'sparkle' : 'star'} size={20} />
              {question?.origin === 'agent' ? 'Câu hỏi mở rộng của AI' : `Câu hỏi tại ${fmtTime(question?.timestamp)}`} · video đã tạm dừng
            </span>
            {left !== null && <span className={`timer ${left <= 15 ? 'timer-low' : ''}`}><Icon name="clock" size={16} />Còn {left}s</span>}
          </div>
          <h2 id="qtitle" className="qtitle">{question?.question || 'Kết quả câu hỏi trước'}</h2>
          {hasOptions ? (
            <div className="opts" role="radiogroup" aria-label="Các lựa chọn">
              {question!.options!.map((o, i) => {
                let cls = 'opt';
                if (!result && selected === i) cls += ' opt-sel';
                if (result) {
                  if (i === correctIdx) cls += ' opt-ok';
                  else if (i === selected) cls += ' opt-bad';
                  else cls += ' opt-dim';
                }
                return (
                  <button key={i} className={cls} role="radio" aria-checked={selected === i} disabled={!!result || busy} onClick={() => setSelected(i)}>
                    <span className="opt-key">{i + 1}</span>{o.replace(/^\s*[A-H][.)]\s*/, '')}
                  </button>
                );
              })}
            </div>
          ) : question ? (
            <label className="field"><span className="sr-only">Câu trả lời</span>
              <textarea value={text} onChange={(e) => setText(e.target.value)} disabled={!!result || busy} placeholder="Nhập câu trả lời của bạn…" />
            </label>
          ) : null}
        </div>

        {!result ? (
          <div className="qfoot">
            <span className="muted small">Hết giờ, Tutor sẽ tự giải thích đáp án.</span>
            <Button size="lg" loading={busy} disabled={hasOptions ? selected === null : !text.trim()} onClick={check} style={{ minWidth: 180 }}>Kiểm tra</Button>
          </div>
        ) : (
          <div className={`feedback ${timeout ? 'feedback-timeout' : ok ? 'feedback-ok' : 'feedback-bad'}`} aria-live="assertive">
            <div className="feedback-row">
              <span className="feedback-icon"><Icon name={timeout ? 'clock' : ok ? 'check' : 'x'} size={28} stroke={3.2} style={{ color: timeout ? '#B88A00' : ok ? 'var(--green)' : 'var(--red)' }} /></span>
              <div>
                <h3>{timeout ? 'Hết giờ rồi' : ok ? `Chính xác!${result.xp_awarded ? ` +${result.xp_awarded} XP` : ''}` : result.verdict === 'partial' ? 'Đúng một phần' : 'Chưa đúng rồi'}</h3>
                <p>{result.feedback}</p>
                {result.tutor_status && result.tutor_status !== 'failed' && (
                  <div className="tutor-explain" aria-live="polite">
                    <span className="tutor-explain-head"><Icon name="sparkle" size={15} />Tutor AI giải thích</span>
                    {result.tutor_status === 'pending'
                      ? <span className="typing" aria-label="Tutor đang soạn lời giải thích"><i /><i /><i /></span>
                      : <>
                          <Markdown source={result.tutor_explanation || ''} />
                          {!!result.tutor_sources?.length && (
                            <div className="src-chips">{result.tutor_sources.map((s) => (
                              <button key={s.label} className="src" title={s.display} disabled={s.source_type !== 'video'}
                                onClick={() => s.source_type === 'video' && onSeek?.(s.start_time)}>
                                <Icon name={s.source_type === 'video' ? 'play' : 'book'} size={14} /><span>{s.label} · {s.display}</span>
                              </button>
                            ))}</div>
                          )}
                        </>}
                  </div>
                )}
                {result.tutor_status === 'failed' && (
                  <p className="muted small" style={{ marginTop: 6 }}>Tutor AI chưa soạn được lời giải thích (lỗi khi gọi mô hình AI). Bấm “Hỏi Tutor thêm” để hỏi lại.</p>
                )}
                {!ok && <button className="src" style={{ marginTop: 8 }} onClick={onAskTutor}><Icon name="sparkle" size={14} />Hỏi Tutor thêm</button>}
              </div>
            </div>
            <Button size="lg" variant={ok ? 'green' : timeout ? 'blue' : 'red'} loading={busy} onClick={cont} style={{ width: '100%' }}>Xem tiếp video</Button>
          </div>
        )}
      </div>
    </div>
  );
}
