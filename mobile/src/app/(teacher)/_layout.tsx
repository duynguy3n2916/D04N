import { PasswordGate, Tabs, tabIcon, tabScreenOptions } from '../../components/TabsShell';
import { Logo } from '../../components/ui';
import { useNotifications } from '../../lib/notifications';

export default function TeacherTabs() {
  const n = useNotifications();
  return (
    <PasswordGate>
      <Tabs screenOptions={tabScreenOptions}>
        <Tabs.Screen name="index" options={{ title: 'Lớp học', headerTitle: () => <Logo size={28} />, tabBarIcon: tabIcon('people-outline', 'people') }} />
        <Tabs.Screen name="forum" options={{ title: 'Diễn đàn', tabBarIcon: tabIcon('chatbubbles-outline', 'chatbubbles'),
          tabBarBadge: n?.forum_new ? n.forum_new : undefined }} />
        <Tabs.Screen name="questions" options={{ title: 'Duyệt câu', headerTitle: 'Duyệt câu hỏi', tabBarIcon: tabIcon('checkmark-circle-outline', 'checkmark-circle') }} />
        <Tabs.Screen name="messages" options={{ title: 'Tin nhắn', tabBarIcon: tabIcon('chatbubble-ellipses-outline', 'chatbubble-ellipses'),
          tabBarBadge: n?.dm_unread ? n.dm_unread : undefined }} />
        <Tabs.Screen name="account" options={{ title: 'Tôi', headerTitle: 'Tài khoản', tabBarIcon: tabIcon('person-circle-outline', 'person-circle') }} />
      </Tabs>
    </PasswordGate>
  );
}
