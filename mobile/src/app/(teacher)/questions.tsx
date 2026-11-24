import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button, Card, Empty, ErrorBox, Muted, Pill, Row, Screen, Spinner, Tag } from '../../components/ui';
import { api, errorText } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { C } from '../../lib/theme';

interface BankItem {
  item_id: string; generation_id: string | null; status: string; lesson_id: string | null; question: string; type: string; difficulty: string;
  options?: string[] | null; correct_answer?: string; correct_index?: number | null; explanation?: string;
}
interface Stats { approved: number; rejected: number; pending: number; acceptance_rate: number | null }
const DIFF: Record<string, string> = { easy: 'Dễ', medium: 'Vừa', hard: 'Khó' };
const TYPE: Record<string, string> = { multiple_choice: 'Trắc nghiệm', true_false: 'Đúng/Sai', short_answer: 'Tự luận ngắn' };

/**
 * Giáo viên duyệt nhanh câu hỏi AI soạn: Duyệt hoặc Từ chối từng câu.
 * Sửa nội dung câu hỏi, AI soạn câu hỏi mới và xuất đề vẫn làm trên web.
 */
export default function Questions() {
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const bank = useAsync((signal) => api<BankItem[]>(`/ai/teacher/question-bank?status=${status}`, { signal }), [status]);
  const stats = useAsync((signal) => api<Stats>('/ai/teacher/stats', { signal }), []);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setSt = async (it: BankItem, to: 'approved' | 'rejected' | 'pending') => {
    setBusyId(it.item_id); setError(null);
    try {
      await api(`/ai/question-bank/${it.item_id}`, { method: 'PATCH', json: { status: to } });
      bank.setData((rows) => (rows || []).filter((r) => r.item_id !== it.item_id));
      stats.reload();
    } catch (e) { setError(errorText(e)); } finally { setBusyId(null); }
  };

  const s = stats.data;
  return (
    <Screen onRefresh={() => { bank.reload(); stats.reload(); }} refreshing={bank.loading && !!bank.data}>
      <Row>
        <Pill label="Chờ duyệt" active={status === 'pending'} onPress={() => setStatus('pending')} count={s?.pending} />
        <Pill label="Đã duyệt" active={status === 'approved'} onPress={() => setStatus('approved')} count={s?.approved} />
        <Pill label="Từ chối" active={status === 'rejected'} onPress={() => setStatus('rejected')} count={s?.rejected} />
      </Row>
      {s?.acceptance_rate != null && <Muted style={{ fontSize: 13 }}>Tỉ lệ chấp nhận câu AI soạn: {Math.round(s.acceptance_rate * 100)}%</Muted>}
      {error && <ErrorBox message={error} />}
      {bank.loading && !bank.data && <Spinner />}
      {bank.error && <ErrorBox message={bank.error} onRetry={bank.reload} />}
      {bank.data && !bank.data.length && (
        <Empty title={status === 'pending' ? 'Không còn câu nào chờ duyệt' : 'Chưa có câu nào'} icon="checkmark-done-outline">
          {status === 'pending' ? 'Muốn AI soạn thêm câu hỏi, dùng trang Ngân hàng câu hỏi trên web.' : undefined}
        </Empty>
      )}
      {bank.data?.map((q) => (
        <Card key={q.item_id}>
          <Row style={{ flexWrap: 'wrap' }}>
            {!!q.lesson_id && <Tag tone="brand" label={q.lesson_id} />}
            <Tag label={TYPE[q.type] || q.type} />
            <Tag label={DIFF[q.difficulty] || q.difficulty} />
            {q.generation_id ? <Tag label="AI soạn" /> : <Tag label="Thủ công" />}
          </Row>
          <Text style={{ fontSize: 16, fontWeight: '700', color: C.ink, lineHeight: 22 }}>{q.question}</Text>
          {q.options?.map((o, k) => {
            const right = q.correct_index === k || (q.correct_index == null && o === q.correct_answer);
            return (
              <View key={k} style={{ flexDirection: 'row', gap: 8, padding: 8, borderRadius: 10, backgroundColor: right ? C.okSoft : C.wash }}>
                <Text style={{ fontWeight: '800', color: right ? C.okText : C.muted }}>{String.fromCharCode(65 + k)}</Text>
                <Text style={{ flex: 1, color: C.ink }}>{o}</Text>
              </View>
            );
          })}
          {!q.options?.length && !!q.correct_answer && <Text style={{ color: C.ink }}>Đáp án: <Text style={{ fontWeight: '700' }}>{q.correct_answer}</Text></Text>}
          {!!q.explanation && <Muted>{q.explanation}</Muted>}
          <Row style={{ marginTop: 4 }}>
            {status !== 'approved' && <Button small icon="checkmark" title="Duyệt" busy={busyId === q.item_id} onPress={() => setSt(q, 'approved')} style={{ flex: 1 }} />}
            {status !== 'rejected' && <Button small variant="ghost" icon="close" title="Từ chối" disabled={busyId === q.item_id} onPress={() => setSt(q, 'rejected')} style={{ flex: 1 }} />}
          </Row>
        </Card>
      ))}
    </Screen>
  );
}
