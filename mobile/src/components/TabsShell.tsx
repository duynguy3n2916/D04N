import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Tabs } from 'expo-router/tabs';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, View, type ColorValue } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../lib/auth';
import { useNotifications } from '../lib/notifications';
import { C, F } from '../lib/theme';
import { ChangePassword } from './ChangePassword';
import { Text } from './Text';
import { H1, type IconName } from './ui';

export const tabScreenOptions = {
  tabBarActiveTintColor: C.brand,
  tabBarInactiveTintColor: C.muted,
  tabBarStyle: { backgroundColor: C.card, borderTopColor: C.cardLine },
  tabBarLabelStyle: { fontSize: 12, fontFamily: F[600] },
  tabBarBadgeStyle: { backgroundColor: C.brand, fontSize: 11, fontFamily: F[700] },
  headerRight: () => <NotiBell />,
  headerStyle: { backgroundColor: C.bg },
  headerShadowVisible: false,
  headerTitleStyle: { color: C.ink, fontFamily: F[800], fontSize: 22, letterSpacing: -0.5 },
  headerTitleAlign: 'left' as const,
  sceneStyle: { backgroundColor: C.bg },
};

export const tabIcon = (name: IconName, active: IconName) =>
  ({ color, focused, size }: { color: ColorValue; focused: boolean; size: number }) => <Ionicons name={focused ? active : name} color={color as string} size={size} />;

/** Chuông thông báo ở góc phải tiêu đề (thay cho tab Thông báo, để thanh tab còn chỗ cho Tin nhắn). */
export function NotiBell() {
  const n = useNotifications();
  const unread = n?.inbox_unread || 0;
  return (
    <Pressable onPress={() => router.push('/notifications')} hitSlop={8} accessibilityLabel={unread ? `Thông báo, ${unread} chưa đọc` : 'Thông báo'}
      style={({ pressed }) => ({ marginRight: 16, width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? C.wash : C.card, borderWidth: 1, borderColor: C.cardLine })}>
      <Ionicons name={unread ? 'notifications' : 'notifications-outline'} size={20} color={C.ink} />
      {unread > 0 && (
        <View style={{ position: 'absolute', top: -3, right: -3, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, backgroundColor: C.brand, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: C.bg }}>
          <Text style={{ color: C.white, fontSize: 10, fontWeight: '800' }}>{unread > 99 ? '99+' : unread}</Text>
        </View>
      )}
    </Pressable>
  );
}

/** Chặn vào app cho tới khi đổi mật khẩu (tài khoản mới do giáo viên tạo). */
export function PasswordGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!user?.must_change_password) return <>{children}</>;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <ScrollView contentContainerStyle={{ padding: 24, gap: 12 }}>
        <H1>Đặt mật khẩu mới</H1>
        <ChangePassword forced />
      </ScrollView>
    </SafeAreaView>
  );
}

export { Tabs };
