import { PasswordGate, Tabs, tabIcon, tabScreenOptions } from '../../components/TabsShell';
import { Logo } from '../../components/ui';
import { useNotifications } from '../../lib/notifications';

export default function StudentTabs() {
  const n = useNotifications();
  return (
    <PasswordGate>
      <Tabs screenOptions={tabScreenOptions}>
        <Tabs.Screen name="index" options={{ title: 'Học', headerTitle: () => <Logo size={28} />, tabBarIcon: tabIcon('book-outline', 'book') }} />
        <Tabs.Screen name="review" options={{ title: 'Ôn thẻ', headerTitle: 'Ôn thẻ ghi nhớ', tabBarIcon: tabIcon('layers-outline', 'layers'),
          tabBarBadge: n?.flashcards_due ? n.flashcards_due : undefined }} />
        <Tabs.Screen name="coach" options={{ title: 'Trợ lý', headerTitle: 'Trợ lý học tập', tabBarIcon: tabIcon('sparkles-outline', 'sparkles') }} />
        <Tabs.Screen name="messages" options={{ title: 'Tin nhắn', tabBarIcon: tabIcon('chatbubble-ellipses-outline', 'chatbubble-ellipses'),
          tabBarBadge: n?.dm_unread ? n.dm_unread : undefined }} />
        <Tabs.Screen name="account" options={{ title: 'Tôi', headerTitle: 'Tài khoản', tabBarIcon: tabIcon('person-circle-outline', 'person-circle') }} />
      </Tabs>
    </PasswordGate>
  );
}
