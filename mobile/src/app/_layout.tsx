import { BricolageGrotesque_400Regular, BricolageGrotesque_500Medium, BricolageGrotesque_600SemiBold, BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold, useFonts } from '@expo-google-fonts/bricolage-grotesque';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, isTeacher, useAuth } from '../lib/auth';
import { C, F } from '../lib/theme';

function RootStack() {
  const { user } = useAuth();
  if (user === undefined) {
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg }}><ActivityIndicator color={C.brand} size="large" /></View>;
  }
  const teacher = isTeacher(user);
  return (
    <Stack screenOptions={{
      headerTintColor: C.brand, headerStyle: { backgroundColor: C.bg }, headerShadowVisible: false,
      headerTitleStyle: { color: C.ink, fontFamily: F[700], fontSize: 17 }, contentStyle: { backgroundColor: C.bg }, headerBackTitle: 'Quay lại',
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
        <Stack.Screen name="dm/[id]" options={{ title: 'Tin nhắn' }} />
        <Stack.Screen name="dm/new" options={{ title: 'Tin nhắn mới' }} />
        <Stack.Screen name="notifications" options={{ title: 'Thông báo' }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  // chữ Bricolage Grotesque giống bản web; chưa tải xong thì hiện vòng quay
  const [fontsLoaded, fontError] = useFonts({ BricolageGrotesque_400Regular, BricolageGrotesque_500Medium, BricolageGrotesque_600SemiBold, BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold });
  if (!fontsLoaded && !fontError) {
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg }}><ActivityIndicator color={C.brand} size="large" /></View>;
  }
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="dark" />
        <RootStack />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
