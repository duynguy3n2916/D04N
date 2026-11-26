import { useState, useEffect } from 'react';
import { Modal, Field, Button, ErrorBox, Spinner, Empty, Badge } from './ui';
import { api, errorText } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { LessonSelect } from '../pages/teach/QuestionBank';

interface BankItem {
  item_id: string;
  question: string;
  status: string;
  lesson_id: string | null;
  course_id?: string | null; 
  difficulty?: string | null;
  type: string;
}

const DIFFICULTIES = [
  { value: 'easy', label: 'Dễ', tone: 'green' as const },
  { value: 'medium', label: 'Vừa', tone: 'blue' as const },
  { value: 'hard', label: 'Khó', tone: 'red' as const },
];

export function ManualCreateDialog({ defaultLesson = '', onClose, onSaved }: { defaultLesson?: string; onClose: () => void; onSaved: () => void }) {
  // ĐÍCH ĐẾN: Nơi câu hỏi sẽ được lưu vào
  const [lessonId, setLessonId] = useState(defaultLesson); 
  
  // BỘ LỌC NGUỒN: Mặc định lọc theo bài hiện tại nếu có
  const [sourceFilter, setSourceFilter] = useState(defaultLesson); 

  // Khóa bài học đích nếu mở từ một mục học cụ thể
  const isLessonLocked = Boolean(defaultLesson);

  const [mode, setMode] = useState<'create' | 'select'>('create');
  
  // STATE TẠO MỚI: Bổ sung difficulty (mặc định 'medium')
  const [f, setF] = useState({ 
    question: '', 
    options: ['', '', '', ''], 
    correct_answer: '', 
    explanation: '',
    difficulty: 'medium' 
  });
  
  const bank = useAsync((s) => api<BankItem[]>('/ai/teacher/question-bank', { signal: s }), []);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = 'auto'; };
  }, []);

  // Lọc danh sách câu hỏi trong kho
  const availableQuestions = bank.data?.filter(q => {
    if (q.lesson_id === lessonId && q.status === 'approved') return false;
    if (sourceFilter && q.lesson_id !== sourceFilter) return false;
    return true;
  }) || [];

  const saveCreate = async () => {
    if (!lessonId) return setErr('Vui lòng chọn bài học đích cho câu hỏi này.');
    if (!f.question.trim()) return setErr('Vui lòng nhập nội dung câu hỏi.');
    
    const validOpts = f.options.filter(o => o.trim() !== '');
    if (validOpts.length < 2) return setErr('Vui lòng nhập ít nhất 2 lựa chọn (đáp án).');
    if (!f.correct_answer || !validOpts.includes(f.correct_answer)) return setErr('Vui lòng tích chọn một đáp án đúng.');

    setBusy(true); setErr(null);
    try {
      await api('/ai/questions/manual', {
        method: 'POST',
        json: { 
          lesson_id: lessonId, 
          content: f.question, 
          options: validOpts, 
          answer: f.correct_answer, 
          explanation: f.explanation,
          difficulty: f.difficulty
        }
      });
      onSaved();
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };

  const saveSelect = async () => {
    if (!lessonId) return setErr('Vui lòng chọn bài học đích để gắn câu hỏi vào.');
    if (selectedIds.length === 0) return setErr('Vui lòng chọn ít nhất một câu hỏi.');
    
    setBusy(true); setErr(null);
    try {
      for (const id of selectedIds) {
        await api(`/ai/question-bank/${id}`, { 
          method: 'PATCH', 
          json: { lesson_id: lessonId, status: 'approved' } 
        });
      }
      onSaved();
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };

  const getDifficultyLabel = (diff?: string | null) => {
    if (!diff) return null;
    const item = DIFFICULTIES.find(d => d.value === diff.toLowerCase());
    return item ? <Badge tone={item.tone}>{item.label}</Badge> : <Badge>{diff}</Badge>;
  };

  return (
    <Modal open onClose={onClose} title="Thêm câu hỏi kiểm tra" wide dismissable={!busy}>
      <div className="modal-body" style={{ overscrollBehavior: 'contain' }}>
        
        {/* ĐÍCH ĐẾN: Khóa nếu mở từ trang Khóa học */}
        <Field 
          label="Gắn vào bài học" 
          hint={isLessonLocked ? "Bài học này được gắn cố định theo mục học bạn vừa chọn." : undefined}
        >
          {isLessonLocked ? (
            <div 
              className="row" 
              style={{ 
                padding: '8px 12px', 
                background: 'var(--bg-soft)', 
                borderRadius: 8, 
                border: '1px solid var(--border)',
                alignItems: 'center',
                gap: 8,
                cursor: 'not-allowed'
              }}
            >
              <Badge tone="green">{lessonId}</Badge>
              <span className="small muted" style={{ fontStyle: 'italic' }}>
                (Đang khóa theo bài học được chọn)
              </span>
            </div>
          ) : (
            <LessonSelect value={lessonId} onChange={setLessonId} />
          )}
        </Field>

        <div className="seg" role="group" style={{ alignSelf: 'flex-start', marginBottom: 12 }}>
          <button type="button" className={mode === 'create' ? 'on' : ''} onClick={() => setMode('create')}>Soạn câu mới</button>
          <button type="button" className={mode === 'select' ? 'on' : ''} onClick={() => setMode('select')}>Chọn từ kho</button>
        </div>

        {mode === 'create' && (
          <>
            <Field label="Nội dung câu hỏi">
              <textarea autoFocus placeholder="Ví dụ: Định nghĩa nào sau đây đúng nhất về Machine Learning?" value={f.question} onChange={(e) => setF({ ...f, question: e.target.value })} />
            </Field>

            {/* MỤC CHỌN ĐỘ KHÓ: Dễ - Vừa - Khó */}
            <Field label="Độ khó">
              <div className="seg" role="group" style={{ 
                alignSelf: 'flex-start', 
                width: 'fit-content',
                display: 'inline-flex'
              }}>
                {DIFFICULTIES.map((d) => (
                  <button
                    key={d.value}
                    type="button"
                    className={f.difficulty === d.value ? 'on' : ''}
                    onClick={() => setF({ ...f, difficulty: d.value })}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </Field>
            
            <fieldset className="col" style={{ gap: 8, border: 'none', padding: 0 }}>
              <legend className="field-label" style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>Các đáp án (Nhập nội dung và Tích chọn đáp án đúng)</legend>
              {f.options.map((o, i) => (
                <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
                  <input type="radio" name="manual-correct" checked={f.correct_answer === o && o.trim() !== ''} onChange={() => setF({ ...f, correct_answer: o })} style={{ width: 20, height: 20, accentColor: 'var(--green)' }} disabled={!o.trim()} />
                  <input className="input" placeholder={`Đáp án ${String.fromCharCode(65 + i)}`} value={o} onChange={(e) => {
                      const newOpts = [...f.options];
                      const wasCorrect = f.correct_answer === newOpts[i];
                      newOpts[i] = e.target.value;
                      setF({ ...f, options: newOpts, correct_answer: wasCorrect ? e.target.value : f.correct_answer });
                    }} />
                </div>
              ))}
            </fieldset>

            <Field label="Giải thích (Tùy chọn)">
              <textarea placeholder="Hiển thị cho học sinh xem sau khi trả lời..." value={f.explanation} onChange={(e) => setF({ ...f, explanation: e.target.value })} />
            </Field>
          </>
        )}

        {mode === 'select' && (
          <div className="col" style={{ gap: 12, minHeight: 280, marginTop: 8 }}>
            
            {/* BỘ LỌC NGUỒN */}
            <div className="row" style={{ alignItems: 'center', gap: 12, background: 'var(--bg-soft)', padding: '10px 12px', borderRadius: 8 }}>
              <span className="small" style={{ fontWeight: 600, minWidth: 90 }}>Lọc nguồn từ:</span>
              <div style={{ flex: 1 }}>
                 <LessonSelect value={sourceFilter} onChange={setSourceFilter} allowAll />
              </div>
            </div>

            <p className="small muted" style={{ margin: 0 }}>
              Tích chọn câu hỏi ở dưới để chuyển chúng vào bài <strong>{lessonId || 'đang chọn'}</strong>.
            </p>
            
            {bank.loading && <Spinner />}
            {bank.error && <ErrorBox message={bank.error} onRetry={bank.reload} />}
            {!bank.loading && availableQuestions.length === 0 && (
              <Empty title="Không có câu hỏi">Không tìm thấy câu hỏi khả dụng nào từ nguồn này.</Empty>
            )}

            {availableQuestions.length > 0 && (
              <div className="card col" style={{ gap: 8, maxHeight: 320, overflowY: 'auto', padding: 12 }}>
                {availableQuestions.map((q) => (
                  <label key={q.item_id} className="check" style={{ alignItems: 'flex-start', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                    <input 
                      type="checkbox" 
                      style={{ marginTop: 4 }}
                      checked={selectedIds.includes(q.item_id)} 
                      onChange={(e) => {
                        if (e.target.checked) setSelectedIds([...selectedIds, q.item_id]);
                        else setSelectedIds(selectedIds.filter(id => id !== q.item_id));
                      }} 
                    />
                    <div className="col" style={{ gap: 4 }}>
                      <span style={{ fontWeight: 500 }}>{q.question}</span>
                      <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        {getDifficultyLabel(q.difficulty)}
                        <span className="small muted">
                          {q.status === 'draft' ? 'Chờ duyệt' : q.status === 'rejected' ? 'Từ chối' : 'Đã duyệt'} 
                          {q.course_id && ` · Khóa: ${q.course_id}`}
                          {q.lesson_id ? ` · Bài gốc: ${q.lesson_id}` : ' · Chung'}
                        </span>
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        
        {err && <ErrorBox message={err} />}
        
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Hủy</Button>
          {mode === 'create' ? (
            <Button icon="check" loading={busy} onClick={saveCreate}>Lưu & Duyệt ngay</Button>
          ) : (
             <Button icon="check" loading={busy} onClick={saveSelect} disabled={selectedIds.length === 0}>
               Thêm {selectedIds.length > 0 ? selectedIds.length : ''} câu vào bài {lessonId}
             </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}