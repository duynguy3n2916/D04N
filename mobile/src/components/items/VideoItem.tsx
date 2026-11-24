import { useEventListener } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Linking, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Button, Card, Muted, Pill, Row, st } from '../ui';
import { api, ApiError, errorText, fmtTime, mediaUrl, type AnswerResult, type PublicQuestion, type TranscriptSegment } from '../../lib/api';
import { C } from '../../lib/theme';
import type { ItemProps } from './types';

const isPlayable = (url: string) => !/youtube\.com|youtu\.be|vimeo\.com/i.test(url);

/**
 * Video bài giảng: phát video, phụ đề chạy theo thời gian (bấm để tua), và câu hỏi giáo viên đặt tại mốc thời gian.
 * Tới mốc câu hỏi thì video dừng, hiện câu hỏi; trả lời xong mới xem tiếp (cùng luồng /ai/workflow như bản web).
 * Câu hỏi mở rộng do AI tự đặt (Question Agent) chỉ có trên bản web.
 */
export function VideoItem({ item, onCompleted, goNext }: ItemProps) {
  const v = item.video!;
  const vid = v.video_id;
  const src = v.stream_path ? mediaUrl(v.stream_path) : v.source_url || '';
  const playable = !!src && isPlayable(src);
  const player = useVideoPlayer(playable ? src : null, (p) => {
    p.timeUpdateEventInterval = 0.5;
    if (item.progress_position && !item.completed) p.currentTime = item.progress_position;
  });

  const [t, setT] = useState(0);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [questions, setQuestions] = useState<PublicQuestion[]>([]);
  const [tab, setTab] = useState<'subs' | 'questions'>('subs');
  const [popup, setPopup] = useState<{ question: PublicQuestion; result: AnswerResult | null } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = useRef<Set<string>>(new Set());
  const prevT = useRef(0);
  const opening = useRef(false);
  const completed = useRef(item.completed);
  const listRef = useRef<FlatList<TranscriptSegment>>(null);

  useEffect(() => {
    api<{ segments: TranscriptSegment[] }>(`/ai/videos/${encodeURIComponent(vid)}/transcript`).then((r) => setSegments(r.segments)).catch(() => setSegments([]));
    api<PublicQuestion[]>(`/ai/videos/${encodeURIComponent(vid)}/questions`).then((qs) => setQuestions(qs.sort((a, b) => a.timestamp - b.timestamp))).catch(() => setQuestions([]));
    // khôi phục câu hỏi đang dở (vd. thoát app giữa chừng)
    api<{ state: string; active_question: PublicQuestion | null }>(`/ai/workflow/session?video_id=${encodeURIComponent(vid)}`)
      .then((s) => { if (s.state === 'WAITING_FOR_STUDENT' && s.active_question) { player.pause(); setPopup({ question: s.active_question, result: null }); } })
      .catch(() => {});
  }, [vid]); // eslint-disable-line react-hooks/exhaustive-deps

  const openQuestion = async (q: PublicQuestion) => {
    if (opening.current) return;
    opening.current = true;
    player.pause();
    try {
      const r = await api<{ question: PublicQuestion }>('/ai/workflow/question-start', { json: { video_id: vid, question_id: q.question_id, current_time: player.currentTime } });
      setSelected(null); setText(''); setError(null);
      setPopup({ question: r.question, result: null });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'INTERACTION_IN_PROGRESS') {
        const s = await api<{ active_question: PublicQuestion | null }>(`/ai/workflow/session?video_id=${encodeURIComponent(vid)}`).catch(() => null);
        if (s?.active_question) setPopup({ question: s.active_question, result: null });
      } else { done.current.add(q.question_id); player.play(); }
    } finally { opening.current = false; }
  };

  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    setT(currentTime);
    const prev = prevT.current;
    prevT.current = currentTime;
    if (!popup && player.playing && currentTime > prev && currentTime - prev < 3) {
      const q = questions.find((x) => !done.current.has(x.question_id) && x.timestamp > prev && x.timestamp <= currentTime);
      if (q) { openQuestion(q); return; }
    }
    if (!completed.current && player.duration && currentTime >= player.duration * 0.9) {
      completed.current = true;
      api<{ xp_awarded: number }>(`/ai/learn/items/${item.item_id}/complete`, { method: 'POST' })
        .then((r) => onCompleted(r.xp_awarded)).catch(() => { completed.current = false; });
    }
  });

  // lưu vị trí xem mỗi 15 giây
  useEffect(() => {
    const id = setInterval(() => {
      if (player.playing) api(`/ai/learn/items/${item.item_id}/position`, { json: { position: Math.floor(player.currentTime) } }).catch(() => {});
    }, 15000);
    return () => clearInterval(id);
  }, [player, item.item_id]);

  const seek = (sec: number) => { player.currentTime = sec; prevT.current = sec; player.play(); };

  const submit = async () => {
    if (!popup) return;
    const hasOpts = !!popup.question.options?.length;
    if (hasOpts ? selected === null : !text.trim()) return;
    setBusy(true); setError(null);
    try {
      const r = await api<AnswerResult>(`/ai/video-questions/${popup.question.question_id}/answer`,
        { json: { selected_index: hasOpts ? selected : null, student_answer: hasOpts ? null : text.trim(), video_time: player.currentTime } });
      done.current.add(popup.question.question_id);
      setPopup({ ...popup, result: r });
      if (r.xp_awarded) onCompleted(r.xp_awarded);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'QUESTION_EXPIRED') { done.current.add(popup.question.question_id); setPopup({ ...popup, result: e.details?.last_result || { question_id: popup.question.question_id, is_correct: null, correct_answer: '', feedback: 'Câu hỏi đã hết thời gian trả lời.' } }); }
      else setError(errorText(e));
    } finally { setBusy(false); }
  };

  const resume = async () => {
    try { await api('/ai/workflow/resume', { json: { video_id: vid, current_time: player.currentTime } }); }
    catch (e) { if (e instanceof ApiError && e.code === 'ANSWER_REQUIRED') return; }
    setPopup(null);
    player.play();
  };

  const activeIdx = useMemo(() => segments.findIndex((s) => t >= s.start_time && t < s.end_time), [segments, t]);
  useEffect(() => {
    if (activeIdx >= 0 && tab === 'subs') listRef.current?.scrollToIndex({ index: activeIdx, viewPosition: 0.3, animated: true });
  }, [activeIdx, tab]);

  return (
    <View style={{ flex: 1 }}>
      {playable ? (
        <VideoView player={player} style={{ width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000' }} nativeControls allowsPictureInPicture={false} fullscreenOptions={{ enable: true }} />
      ) : (
        <Card style={{ margin: 16 }}>
          <Muted>Video này nằm trên trang ngoài, mở bằng trình duyệt để xem.</Muted>
          {!!src && <Button small variant="ghost" icon="open-outline" title="Mở video" onPress={() => Linking.openURL(src)} />}
        </Card>
      )}
      {activeIdx >= 0 && (
        <View style={{ backgroundColor: C.ink, paddingHorizontal: 16, paddingVertical: 10 }}>
          <Text style={{ color: C.white, fontSize: 15, textAlign: 'center' }}>{segments[activeIdx].text}</Text>
        </View>
      )}
      <Row style={{ padding: 12, paddingBottom: 4 }}>
        <Pill label="Phụ đề" active={tab === 'subs'} onPress={() => setTab('subs')} count={segments.length} />
        <Pill label="Câu hỏi" active={tab === 'questions'} onPress={() => setTab('questions')} count={questions.length} />
        <View style={{ flex: 1 }} />
        {goNext && <Button small variant="soft" title="Tiếp" icon="arrow-forward" onPress={goNext} />}
      </Row>
      {tab === 'subs' ? (
        segments.length ? (
          <FlatList ref={listRef} data={segments} keyExtractor={(_, i) => String(i)} contentContainerStyle={{ padding: 12, gap: 4 }}
            onScrollToIndexFailed={() => {}}
            renderItem={({ item: s, index }) => (
              <Pressable onPress={() => seek(s.start_time)} style={{ flexDirection: 'row', gap: 10, padding: 10, borderRadius: 12, backgroundColor: index === activeIdx ? C.brandSoft : 'transparent' }}>
                <Text style={{ color: C.brand, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{fmtTime(s.start_time)}</Text>
                <Text style={{ flex: 1, color: C.ink, fontSize: 15, lineHeight: 21 }}>{s.text}</Text>
              </Pressable>
            )} />
        ) : <Muted style={{ padding: 16 }}>Video chưa có phụ đề.</Muted>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 12, gap: 8 }}>
          {!questions.length && <Muted>Giáo viên chưa đặt câu hỏi cho video này.</Muted>}
          {questions.map((q) => (
            <Pressable key={q.question_id} onPress={() => seek(Math.max(0, q.timestamp - 3))} style={{ flexDirection: 'row', gap: 10, padding: 12, borderRadius: 14, backgroundColor: C.card, borderWidth: 1, borderColor: C.line }}>
              <Text style={{ color: C.brand, fontWeight: '700' }}>{fmtTime(q.timestamp)}</Text>
              <Text style={{ flex: 1, color: C.ink }} numberOfLines={2}>{done.current.has(q.question_id) ? '✓ ' : ''}{q.question}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      <Modal visible={!!popup} transparent animationType="slide" onRequestClose={() => { if (popup?.result) resume(); }}>
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(34,19,26,0.45)' }}>
          <View style={{ backgroundColor: C.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, gap: 12, maxHeight: '85%' }}>
            <ScrollView contentContainerStyle={{ gap: 12 }} keyboardShouldPersistTaps="handled">
              <Text style={{ color: C.brand, fontWeight: '800', fontSize: 12 }}>CÂU HỎI TẠI {fmtTime(popup?.question.timestamp)}</Text>
              <Text style={{ fontSize: 19, fontWeight: '700', color: C.ink, lineHeight: 26 }}>{popup?.question.question}</Text>
              {popup?.question.options?.length ? popup.question.options.map((opt, k) => {
                const r = popup.result;
                const isRight = r && r.correct_index === k;
                const isWrong = r && selected === k && !r.is_correct;
                return (
                  <Pressable key={k} disabled={!!r} onPress={() => setSelected(k)}
                    style={[{ padding: 14, borderRadius: 14, borderWidth: 2, borderColor: C.line, backgroundColor: C.card },
                      selected === k && { borderColor: C.brand, backgroundColor: C.brandSoft },
                      isRight && { borderColor: C.ok, backgroundColor: C.okSoft }, isWrong && { borderColor: C.wrong, backgroundColor: C.wrongSoft }]}>
                    <Text style={{ fontSize: 16, color: C.ink }}>{String.fromCharCode(65 + k)}. {opt}</Text>
                  </Pressable>
                );
              }) : popup && (
                <TextInput style={[st.input, { minHeight: 90, textAlignVertical: 'top' }]} multiline value={text} onChangeText={setText} editable={!popup.result} placeholder="Câu trả lời của bạn" placeholderTextColor={C.muted} />
              )}
              {popup?.result && (
                <Card style={{ backgroundColor: popup.result.is_correct ? C.okSoft : C.wrongSoft, borderColor: popup.result.is_correct ? C.ok : C.wrong }}>
                  <Text style={{ fontWeight: '800', color: popup.result.is_correct ? C.okText : C.wrong }}>{popup.result.is_correct ? 'Chính xác!' : popup.result.is_correct === false ? 'Chưa đúng' : 'Đã ghi nhận'}</Text>
                  {!popup.result.is_correct && !!popup.result.correct_answer && <Text style={{ color: C.ink }}>Đáp án: {popup.result.correct_answer}</Text>}
                  {!!popup.result.feedback && <Text style={{ color: C.ink }}>{popup.result.feedback}</Text>}
                  {!!popup.result.explanation && <Muted>{popup.result.explanation}</Muted>}
                </Card>
              )}
              {error && <Text style={{ color: C.wrong }}>{error}</Text>}
            </ScrollView>
            {popup?.result
              ? <Button title="Xem tiếp video" icon="play" onPress={resume} />
              : <Button title="Trả lời" onPress={submit} busy={busy} disabled={popup?.question.options?.length ? selected === null : !text.trim()} />}
          </View>
        </View>
      </Modal>
    </View>
  );
}
