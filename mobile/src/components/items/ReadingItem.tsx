import { useState } from 'react';
import { Markdown } from '../Markdown';
import { Button, ErrorBox, Screen } from '../ui';
import { api, errorText } from '../../lib/api';
import type { ItemProps } from './types';

/** Bài đọc: hiển thị Markdown, cuối bài bấm "Đã đọc xong" để tính hoàn thành. */
export function ReadingItem({ item, onCompleted, goNext }: ItemProps) {
  const [done, setDone] = useState(item.completed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finish = async () => {
    setBusy(true); setError(null);
    try {
      if (!done) {
        const r = await api<{ xp_awarded: number }>(`/ai/learn/items/${item.item_id}/complete`, { method: 'POST' });
        setDone(true); onCompleted(r.xp_awarded);
      }
      goNext?.();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Screen>
      <Markdown text={item.reading?.content_md || '_Bài đọc trống._'} />
      {error && <ErrorBox message={error} />}
      <Button style={{ marginTop: 16 }} icon={goNext ? 'arrow-forward' : 'checkmark'} busy={busy}
        title={done ? (goNext ? 'Mục tiếp theo' : 'Đã đọc xong') : goNext ? 'Đã đọc xong, sang mục tiếp' : 'Đã đọc xong'}
        disabled={done && !goNext} onPress={finish} />
    </Screen>
  );
}
