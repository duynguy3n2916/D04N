import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Button, Card, ErrorBox, H1, Muted, Progress, Row, Screen, st } from '../ui';
import { api, ApiError, errorText } from '../../lib/api';
import { C } from '../../lib/theme';
import type { ItemProps } from './types';

interface QuizQ { question_id: string; type: string; question: string; options: string[] | null }
interface QAnswer { is_correct: boolean | null; correct_answer: string; correct_index?: number | null; explanation?: string | null; feedback: string; xp_awarded?: number }
interface QFinish { correct: number; total: number; score: number; pass_ratio: number; passed: boolean; xp_awarded: number; time_up?: boolean }

const fmtWhen = (iso: string) => new Date(iso).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

/** Bài kiểm tra: từng câu một, chọn → Kiểm tra → phản hồi → Tiếp → kết quả (giống bản web, cùng API). */
export function QuizItem({ item, onCompleted, goNext }: ItemProps) {
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
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const q = qs[i];
  const hasOptions = !!q?.options?.length;
  const remaining = deadline ? Math.max(0, Math.floor((deadline - now) / 1000)) : null;

  useEffect(() => {
    if (phase !== 'run' || !deadline) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase, deadline]);

  const start = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ questions: QuizQ[]; deadline_at: string | null }>(`/ai/learn/items/${item.item_id}/quiz/start`, { method: 'POST' });
      setQs(r.questions); setI(0); setSelected(null); setText(''); setAnswer(null); setXp(0); setFinal(null);
      setDeadline(r.deadline_at ? new Date(r.deadline_at).getTime() : null); setNow(Date.now());
      setPhase('run');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  const finish = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<QFinish>(`/ai/learn/items/${item.item_id}/quiz/finish`, { method: 'POST' });
      setFinal(r); setPhase('done'); setDeadline(null);
      onCompleted((r.xp_awarded || 0) + xp || undefined);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }, [item.item_id, onCompleted, xp]);

  useEffect(() => { if (phase === 'run' && remaining === 0) finish(); }, [remaining, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const check = async () => {
    if (!q || busy || answer) return;
    if (hasOptions ? selected === null : !text.trim()) return;
    setBusy(true); setError(null);
    try {
      const r = await api<QAnswer>(`/ai/learn/items/${item.item_id}/quiz/answer`, { json: {
        question_id: q.question_id, selected_index: hasOptions ? selected : null, answer: hasOptions ? null : text.trim() } });
      setAnswer(r);
      if (r.xp_awarded) setXp((n) => n + (r.xp_awarded || 0));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'QUIZ_TIME_UP') { setBusy(false); finish(); return; }
      setError(errorText(e));
    } finally { setBusy(false); }
  };

  const next = () => {
    if (i < qs.length - 1) { setI(i + 1); setSelected(null); setText(''); setAnswer(null); return; }
    finish();
  };

  if (phase === 'intro') {
    const closed = quiz.window === 'closed' || quiz.window === 'not_yet';
    return (
      <Screen>
        <View style={{ alignItems: 'center', gap: 10, paddingVertical: 16 }}>
          <Ionicons name={item.completed ? 'checkmark-circle' : 'help-circle'} size={72} color={C.brand} />
          <H1 style={{ textAlign: 'center' }}>{item.title}</H1>
          <Muted style={{ textAlign: 'center' }}>
            {Math.min(quiz.count, quiz.available || quiz.count)} câu · cần đúng {Math.round(quiz.pass_ratio * 100)}% để qua bài.
            {quiz.time_limit_minutes ? ` Giới hạn ${quiz.time_limit_minutes} phút, hết giờ tự nộp.` : ''}
          </Muted>
          {(quiz.open_at || quiz.close_at) && (
            <Muted style={{ textAlign: 'center', fontSize: 13 }}>
              {quiz.open_at ? `Mở: ${fmtWhen(quiz.open_at)}. ` : ''}{quiz.close_at ? `Đóng: ${fmtWhen(quiz.close_at)}.` : ''}
            </Muted>
          )}
          {item.score != null && <Text style={{ fontWeight: '700', color: C.ink }}>Điểm tốt nhất: {Math.round(item.score * 100)}%</Text>}
        </View>
        {error && <ErrorBox message={error} />}
        <Button title={closed ? (quiz.window === 'not_yet' ? 'Chưa tới giờ mở' : 'Bài đã đóng') : item.completed ? 'Làm lại' : 'Bắt đầu'}
          icon="play" busy={busy} disabled={closed || !quiz.available} onPress={start} />
        {!quiz.available && <Muted style={{ textAlign: 'center' }}>Giáo viên chưa duyệt câu hỏi nào cho bài này.</Muted>}
      </Screen>
    );
  }

  if (phase === 'done' && final) {
    return (
      <Screen>
        <View style={{ alignItems: 'center', gap: 10, paddingVertical: 24 }}>
          <Ionicons name={final.passed ? 'trophy' : 'refresh-circle'} size={80} color={final.passed ? C.brand : C.wrong} />
          <H1 style={{ textAlign: 'center' }}>{final.passed ? 'Qua bài rồi!' : 'Chưa đạt, thử lại nhé'}</H1>
          <Text style={{ fontSize: 40, fontWeight: '800', color: C.ink }}>{final.correct}/{final.total}</Text>
          <Muted>{Math.round(final.score * 100)}% · cần {Math.round(final.pass_ratio * 100)}%{final.time_up ? ' · hết giờ' : ''}</Muted>
          {!!(final.xp_awarded + xp) && <Text style={{ color: C.brand, fontWeight: '800' }}>+{final.xp_awarded + xp} XP</Text>}
        </View>
        <Button variant="ghost" icon="refresh" title="Làm lại" onPress={start} busy={busy} />
        {final.passed && goNext && <Button icon="arrow-forward" title="Mục tiếp theo" onPress={goNext} />}
      </Screen>
    );
  }

  if (!q) return <Screen><Muted>Không có câu hỏi.</Muted></Screen>;
  const correctIdx = answer?.correct_index;
  return (
    <Screen>
      <Row style={{ justifyContent: 'space-between' }}>
        <Muted>Câu {i + 1}/{qs.length}</Muted>
        {remaining != null && <Text style={{ fontWeight: '800', color: remaining < 60 ? C.wrong : C.ink }}>{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</Text>}
      </Row>
      <Progress value={(i + (answer ? 1 : 0)) / qs.length} />
      <Text style={{ fontSize: 20, fontWeight: '700', color: C.ink, lineHeight: 28, marginVertical: 8 }}>{q.question}</Text>
      {hasOptions ? q.options!.map((opt, k) => {
        const isSel = selected === k;
        const isRight = answer && correctIdx === k;
        const isWrong = answer && isSel && !answer.is_correct;
        return (
          <Pressable key={k} disabled={!!answer} onPress={() => setSelected(k)}
            style={[{ flexDirection: 'row', gap: 12, alignItems: 'center', padding: 14, borderRadius: 16, borderWidth: 2, borderColor: C.line, backgroundColor: C.card },
              isSel && { borderColor: C.brand, backgroundColor: C.brandSoft },
              isRight && { borderColor: C.ok, backgroundColor: C.okSoft },
              isWrong && { borderColor: C.wrong, backgroundColor: C.wrongSoft }]}>
            <View style={{ width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: isSel ? C.brand : C.line, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontWeight: '800', color: isSel ? C.brand : C.muted }}>{String.fromCharCode(65 + k)}</Text>
            </View>
            <Text style={{ flex: 1, fontSize: 16, color: C.ink }}>{opt}</Text>
          </Pressable>
        );
      }) : (
        <TextInput style={[st.input, { minHeight: 100, textAlignVertical: 'top' }]} multiline value={text} onChangeText={setText}
          editable={!answer} placeholder="Nhập câu trả lời của bạn" placeholderTextColor={C.muted} />
      )}
      {answer && (
        <Card style={{ backgroundColor: answer.is_correct ? C.okSoft : C.wrongSoft, borderColor: answer.is_correct ? C.ok : C.wrong }}>
          <Text style={{ fontWeight: '800', fontSize: 17, color: answer.is_correct ? C.okText : C.wrong }}>
            {answer.is_correct ? 'Chính xác!' : answer.is_correct === false ? 'Chưa đúng' : 'Đã ghi nhận'}
          </Text>
          {!answer.is_correct && !!answer.correct_answer && <Text style={{ color: C.ink }}>Đáp án: <Text style={{ fontWeight: '700' }}>{answer.correct_answer}</Text></Text>}
          {!!answer.feedback && <Text style={{ color: C.ink }}>{answer.feedback}</Text>}
          {!!answer.explanation && <Muted>{answer.explanation}</Muted>}
        </Card>
      )}
      {error && <ErrorBox message={error} />}
      {answer
        ? <Button title={i < qs.length - 1 ? 'Tiếp tục' : 'Xem kết quả'} icon="arrow-forward" onPress={next} busy={busy} />
        : <Button title="Kiểm tra" onPress={check} busy={busy} disabled={hasOptions ? selected === null : !text.trim()} />}
    </Screen>
  );
}
