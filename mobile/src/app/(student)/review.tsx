import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { View } from 'react-native';
import { Text } from '../../components/Text';
import { Card, Empty, Muted, Row, Screen } from '../../components/ui';
import { refreshNotifications, useNotifications } from '../../lib/notifications';
import { C } from '../../lib/theme';

/** Các bài có thẻ đến hạn ôn hôm nay. Thẻ của từng bài cũng mở được từ trang bài học. */
export default function Review() {
  const n = useNotifications();
  useFocusEffect(useCallback(() => { refreshNotifications(); }, []));
  const list = n?.flashcards || [];
  return (
    <Screen onRefresh={refreshNotifications}>
      <Muted>Lật thẻ, tự chấm mức nhớ. Thẻ bạn quên sẽ quay lại sớm, thẻ nhớ tốt sẽ giãn ra.</Muted>
      {!!n && !list.length && (
        <Empty title="Hôm nay không còn thẻ cần ôn" icon="checkmark-done-outline">Muốn ôn thêm, mở một bài học và chọn “Ôn thẻ ghi nhớ của bài này”.</Empty>
      )}
      {list.map((f) => (
        <Card key={f.lesson_code} onPress={() => router.push(`/flashcards/${encodeURIComponent(f.lesson_code)}`)}>
          <Row>
            <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: C.brandSoft, alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="layers" size={22} color={C.brand} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: C.ink }}>{f.lesson_title || f.lesson_code}</Text>
              <Muted style={{ fontSize: 13 }}>{f.due} thẻ cần ôn</Muted>
            </View>
            <Ionicons name="chevron-forward" size={18} color={C.muted} />
          </Row>
        </Card>
      ))}
    </Screen>
  );
}
