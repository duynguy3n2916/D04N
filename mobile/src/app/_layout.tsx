import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, isTeacher, useAuth } from '../lib/auth';
import { C } from '../lib/theme';

function RootStack() {
  const { user } = useAuth();
  if (user === undefined) {
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg }}><ActivityIndicator color={C.brand} size="large" /></View>;
  }
  const teacher = isTeacher(user);
  return (
    <Stack screenOptions={{
      headerTintColor: C.brand, headerStyle: { backgroundColor: C.bg }, headerShadowVisible: false,
      headerTitleStyle: { color: C.ink, fontWeight: '700' }, contentStyle: { backgroundColor: C.bg }, headerBackTitle: 'Quay lại',
    }}>
      <Stack.Protected guard={!user}>
        <Stack.Screen name="login" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={!!user && !teacher}>
        <Stack.Screen name="(student)" options={{ headerShown: false }} />
        <Stack.Screen name="course/[id]" options={{ title: 'Khoá học' }} />
        <Stack.Screen name="lesson/[id]" options={{ title: 'Bài học' }} />
        <Stack.Screen name="item/[id]" options={{ title: '' }} />
        <Stack.Screen name="flashcards/[code]" options={{ title: 'Ôn thẻ ghi nhớ' }} />
        <Stack.Screen name="coach/[id]" options={{ title: 'Trợ lý học tập' }} />
      </Stack.Protected>
      <Stack.Protected guard={!!user && teacher}>
        <Stack.Screen name="(teacher)" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={!!user}>
        <Stack.Screen name="forum/[id]" options={{ title: 'Thảo luận' }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="dark" />
        <RootStack />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
