import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../../components/Icon';
import { Mascot } from '../../components/Mascot';
import { Button, ErrorBox, Progress } from '../../components/ui';
import { api, errorText } from '../../lib/api';
import type { ItemProps } from '../Lesson';

interface QuizQ { question_id: string; type: string; question: string; options: string[] | null; difficulty?: string }
interface QAnswer { is_correct: boolean | null; verdict?: string; correct_answer: string; correct_index?: number | null; explanation?: string | null; feedback: string; xp_awarded?: number }
interface QFinish { correct: number; total: number; score: number; pass_ratio: number; passed: boolean; xp_awarded: number }

/** Bài kiểm tra cuối bài: từng câu một, chọn → Kiểm tra → phản hồi → Tiếp tục → màn hình kết quả. */
export function QuizItem({ item, onCompleted, setContext, askTutor, goNext }: ItemProps) {
  const quiz = item.quiz || { count: 5, pass_ratio: 0.8, available: 0 };
  const [phase, setPhase] = useState<'intro' | 'run' | 'done'>('intro');
  const [qs, setQs] = useState<QuizQ[]>([]);
  const [i, setI] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [answer, setAnswer] = useState<QAnswer | null>(null);
  const [xp, setXp] = useState(0);
  const [final, setFinal] = useState<QFinish | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const q = qs[i];

  useEffect(() => {
    // Khi đang làm bài, Tutor tự chuyển sang chế độ gợi ý (backend nhận biết qua lesson).
    setContext({ label: phase === 'run' ? `Kiểm tra · câu ${i + 1}/${qs.length}` : `Kiểm tra · ${item.title}`,
      suggestions: phase === 'run' ? ['Gợi ý cho mình hướng làm câu này'] : ['Mình nên ôn lại phần nào trước khi làm?'] });
  }, [phase, i, qs.length, item.title, setContext]);

  useEffect(() => { if (phase === 'run') boxRef.current?.focus(); }, [phase, i, !!answer]);

  const start = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ questions: QuizQ[] }>(`/ai/learn/items/${item.item_id}/quiz/start`, { method: 'POST' });
      setQs(r.questions); setI(0); setSelected(null); setText(''); setAnswer(null); setXp(0); setFinal(null);
      setPhase('run');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  const hasOptions = !!q?.options?.length;
  const check = useCallback(async () => {
    if (!q || busy || answer) return;
    if (hasOptions ? selected === null : !text.trim()) return;
    setBusy(true); setError(null);
    try {
      const r = await api<QAnswer>(`/ai/learn/items/${item.item_id}/quiz/answer`, { json: {
        question_id: q.question_id, selected_index: hasOptions ? selected : null, answer: hasOptions ? null : text.trim() } });
      setAnswer(r);
      if (r.xp_awarded) setXp((n) => n + (r.xp_awarded || 0));
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }, [q, busy, answer, hasOptions, selected, text, item.item_id]);

  const next = useCallback(async () => {
    if (i < qs.length - 1) { setI(i + 1); setSelected(null); setText(''); setAnswer(null); return; }
    setBusy(true); setError(null);
    try {
      const r = await api<QFinish>(`/ai/learn/items/${item.item_id}/quiz/finish`, { method: 'POST' });
      setFinal(r); setPhase('done');
      onCompleted((r.xp_awarded || 0) + xp || undefined);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }, [i, qs.length, item.item_id, onCompleted, xp]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
    if (!answer && hasOptions && /^[1-8]$/.test(e.key)) {
      const k = Number(e.key) - 1;
      if (k < (q?.options?.length || 0)) setSelected(k);
    } else if (e.key === 'Enter') { e.preventDefault(); if (answer) next(); else check(); }
  };

  if (phase === 'intro') {
    const best = item.score != null ? Math.round(item.score * 100) : null;
    return (
      <div className="quiz-page">
        <div className="result-hero">
          <Mascot size={120} mood={item.completed ? 'happy' : 'wave'} />
          <h2>{item.title}</h2>
          <p className="muted" style={{ fontWeight: 700, maxWidth: 520 }}>
            {Math.min(quiz.count, quiz.available || quiz.count)} câu hỏi · cần đúng {Math.round(quiz.pass_ratio * 100)}% để qua bài.
            Trong lúc làm, Tutor chỉ đưa gợi ý chứ không nói đáp án.
          </p>
          <div className="result-stats">
            <div className="result-stat"><strong>{quiz.available}</strong><span className="muted small">câu trong ngân hàng</span></div>
            <div className="result-stat"><strong>{best != null ? `${best}%` : '—'}</strong><span className="muted small">điểm cao nhất</span></div>
            <div className="result-stat"><strong style={{ color: item.completed ? 'var(--green)' : undefined }}>{item.completed ? 'Đã qua' : 'Chưa qua'}</strong><span className="muted small">trạng thái</span></div>
          </div>
          {error && <ErrorBox message={error} />}
          {quiz.available === 0
            ? <ErrorBox message="Giáo viên chưa duyệt câu hỏi nào cho bài kiểm tra này." />
            : <Button size="lg" loading={busy} onClick={start} style={{ minWidth: 240 }}>{item.completed ? 'Làm lại' : 'Bắt đầu'}</Button>}
        </div>
      </div>
    );
  }

  if (phase === 'done' && final) {
    const pct = Math.round(final.score * 100);
    return (
      <div className="quiz-page">
        <div className="result-hero">
          <Mascot size={130} mood={final.passed ? 'happy' : 'think'} />
          <h2>{final.passed ? 'Xuất sắc, bạn đã qua bài!' : 'Chưa đạt lần này'}</h2>
          <p className="muted" style={{ fontWeight: 700 }}>
            {final.passed ? 'Bài tiếp theo đã được mở khóa.' : `Cần đúng ít nhất ${Math.round(final.pass_ratio * 100)}%. Ôn lại rồi thử lần nữa nhé.`}
          </p>
          <div className="result-stats">
            <div className="result-stat" style={{ borderColor: 'var(--yellow)' }}><strong style={{ color: 'var(--yellow-text)' }}>+{xp + final.xp_awarded}</strong><span className="muted small">XP nhận được</span></div>
            <div className="result-stat" style={{ borderColor: final.passed ? 'var(--green-line)' : 'var(--red-line)' }}>
              <strong style={{ color: final.passed ? 'var(--green)' : 'var(--red)' }}>{pct}%</strong><span className="muted small">{final.correct}/{final.total} câu đúng</span>
            </div>
          </div>
          <div className="row" style={{ justifyContent: 'center' }}>
            <Button variant="ghost" size="lg" icon="refresh" onClick={start} loading={busy}>Làm lại</Button>
            {final.passed && goNext && <Button size="lg" icon="chevronRight" onClick={goNext}>Mục tiếp theo</Button>}
            {!final.passed && <Button variant="blue" size="lg" icon="sparkle" onClick={() => askTutor('Mình vừa làm sai bài kiểm tra, nên ôn lại phần nào?')}>Hỏi Tutor nên ôn gì</Button>}
          </div>
        </div>
      </div>
    );
  }

  if (!q) return null;
  const ok = answer?.is_correct === true;
  return (
    <div className="quiz-page" tabIndex={-1} ref={boxRef} onKeyDown={onKey} style={{ outline: 'none', flex: 1 }}>
      <div className="row" style={{ gap: 14 }}>
        <div style={{ flex: 1 }}><Progress value={(i + (answer ? 1 : 0)) / qs.length} label="Tiến độ bài kiểm tra" height={16} /></div>
        <span style={{ fontWeight: 900 }}>{i + 1}/{qs.length}</span>
      </div>
      <span className="qkicker"><Icon name="star" size={18} />Câu {i + 1}{q.difficulty ? ` · ${q.difficulty === 'easy' ? 'Dễ' : q.difficulty === 'hard' ? 'Khó' : 'Vừa'}` : ''}</span>
      <h2 className="qtitle">{q.question}</h2>
      {hasOptions ? (
        <div className="opts" role="radiogroup" aria-label="Các lựa chọn">
          {q.options!.map((o, k) => {
            let cls = 'opt';
            if (!answer && selected === k) cls += ' opt-sel';
            if (answer) cls += k === answer.correct_index ? ' opt-ok' : k === selected ? ' opt-bad' : ' opt-dim';
            return (
              <button key={k} className={cls} role="radio" aria-checked={selected === k} disabled={!!answer || busy} onClick={() => setSelected(k)}>
                <span className="opt-key">{k + 1}</span>{o.replace(/^\s*[A-H][.)]\s*/, '')}
              </button>
            );
          })}
        </div>
      ) : (
        <label className="field"><span className="sr-only">Câu trả lời</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} disabled={!!answer || busy} placeholder="Nhập câu trả lời của bạn…" />
        </label>
      )}
      {error && <ErrorBox message={error} />}
      <div style={{ flex: 1 }} />
      <div className={`quiz-bottom ${answer ? (ok ? 'feedback-ok' : 'feedback-bad') : ''}`} aria-live="polite">
        <div className="quiz-bottom-inner">
          {!answer ? (
            <>
              <Button variant="ghost" size="lg" onClick={() => askTutor(`Gợi ý giúp mình câu: ${q.question}`)} icon="bulb">Xin gợi ý</Button>
              <Button size="lg" loading={busy} disabled={hasOptions ? selected === null : !text.trim()} onClick={check} style={{ minWidth: 180 }}>Kiểm tra</Button>
            </>
          ) : (
            <>
              <div className="feedback-row" style={{ flex: 1, minWidth: 260 }}>
                <span className="feedback-icon"><Icon name={ok ? 'check' : 'x'} size={28} stroke={3.2} style={{ color: ok ? 'var(--green)' : 'var(--red)' }} /></span>
                <div className="feedback" style={{ padding: 0, background: 'none' }}>
                  <h3>{ok ? `Chính xác!${answer.xp_awarded ? ` +${answer.xp_awarded} XP` : ''}` : answer.verdict === 'partial' ? 'Đúng một phần' : 'Chưa đúng'}</h3>
                  <p>{ok ? (answer.explanation || answer.feedback) : <>Đáp án: <b>{answer.correct_answer}</b>{answer.explanation ? ` — ${answer.explanation}` : ''}</>}</p>
                </div>
              </div>
              <Button size="lg" variant={ok ? 'green' : 'red'} loading={busy} onClick={next} style={{ minWidth: 180 }}>{i < qs.length - 1 ? 'Tiếp tục' : 'Xem kết quả'}</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
