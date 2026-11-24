import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router/tabs';
import type { ReactNode } from 'react';
import { ScrollView, type ColorValue } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../lib/auth';
import { C, F } from '../lib/theme';
import { ChangePassword } from './ChangePassword';
import { H1, type IconName } from './ui';

export const tabScreenOptions = {
  tabBarActiveTintColor: C.brand,
  tabBarInactiveTintColor: C.muted,
  tabBarStyle: { backgroundColor: C.bg, borderTopColor: C.cardLine },
  tabBarLabelStyle: { fontSize: 11, fontFamily: F[600] },
  headerStyle: { backgroundColor: C.bg },
  headerShadowVisible: false,
  headerTitleStyle: { color: C.ink, fontFamily: F[800], fontSize: 22, letterSpacing: -0.5 },
  headerTitleAlign: 'left' as const,
  sceneStyle: { backgroundColor: C.bg },
};

export const tabIcon = (name: IconName, active: IconName) =>
  ({ color, focused, size }: { color: ColorValue; focused: boolean; size: number }) => <Ionicons name={focused ? active : name} color={color as string} size={size} />;

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
