import { ScrollView } from 'react-native';
import type { ClassInfo } from '../../lib/api';
import { Pill } from '../ui';

/** Hàng chọn lớp (cuộn ngang). Ẩn khi giáo viên chỉ có một lớp. */
export function ClassPicker({ classes, value, onChange, counts }: { classes: ClassInfo[]; value: string; onChange: (id: string) => void; counts?: Record<string, number> }) {
  if (classes.length < 2) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
      {classes.map((c) => <Pill key={c.class_id} label={c.name || c.class_id} active={value === c.class_id} onPress={() => onChange(c.class_id)}
        count={counts?.[c.class_id] || undefined} />)}
    </ScrollView>
  );
}
