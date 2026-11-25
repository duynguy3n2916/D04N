import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text, TextInput } from '../components/Text';
import { Button, Logo } from '../components/ui';
import { ApiError, api, errorText, getServer, hasDefaultServer, setServer } from '../lib/api';
import { useAuth } from '../lib/auth';
import { C } from '../lib/theme';

// Màn đăng nhập theo bản web: phần trên nền kem với khẩu hiệu lớn, khung đăng nhập nền mực bo góc ở dưới.
const DARK = '#1E1418';
const DARK_FIELD = '#2A1D22';
const DARK_LINE = '#3D2B31';

export default function Login() {
  const { login, notice } = useAuth();
  const [server, setServerText] = useState(getServer());
  // Ô máy chủ ẩn khi app tự tìm được địa chỉ; chỉ hiện khi không tìm được, hoặc khi người dùng bấm "Đổi máy chủ" sau lỗi kết nối.
  const [showServer, setShowServer] = useState(!getServer());
  const [offline, setOffline] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(notice);
  const [serverOk, setServerOk] = useState<boolean | null>(null);

  useEffect(() => { setError(notice); }, [notice]);

  const check = async () => {
    setChecking(true); setError(null); setServerOk(null);
    try { await setServer(server); setServerText(getServer()); await api('/ai/auth/config'); setServerOk(true); }
    catch (e) { setServerOk(false); setError(errorText(e)); } finally { setChecking(false); }
  };

  const submit = async () => {
    if (!username.trim() || !password) { setError('Nhập tên đăng nhập và mật khẩu.'); return; }
    setBusy(true); setError(null);
    try { if (showServer) await setServer(server); setOffline(false); await login(username.trim(), password); }
    catch (e) { setOffline(e instanceof ApiError && e.status === 0); setError(errorText(e)); } finally { setBusy(false); }
  };

  const field = (name: string) => ({
    onFocus: () => setFocus(name), onBlur: () => setFocus(null),
    style: { backgroundColor: DARK_FIELD, borderWidth: 2, borderColor: focus === name ? C.brand : DARK_LINE, borderRadius: 16,
      paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, fontWeight: '600' as const, color: C.white, flex: 1 },
    placeholderTextColor: '#8E7F83',
  });

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled" bounces={false}>
          <View style={{ paddingHorizontal: 24, paddingTop: 16, paddingBottom: 28, gap: 22 }}>
            <Logo size={30} />
            <Text style={{ fontSize: 46, fontWeight: '800', letterSpacing: -2.2, lineHeight: 46 }}>
              Học cùng <Text style={{ color: C.brand, fontWeight: '800' }}>AI</Text>,{'\n'}mỗi ngày{'\n'}một chút.
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {[['play', 'Video có câu hỏi'], ['sparkles', 'Trợ lý có nguồn'], ['layers', 'Thẻ ghi nhớ']].map(([icon, label]) => (
                <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: C.card, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 11, borderWidth: 1, borderColor: C.cardLine }}>
                  <Ionicons name={icon as any} size={13} color={C.ink} />
                  <Text style={{ fontSize: 13, fontWeight: '600' }}>{label}</Text>
                </View>
              ))}
            </View>
          </View>

          <View style={{ flexGrow: 1, backgroundColor: DARK, borderTopLeftRadius: 32, borderTopRightRadius: 32, padding: 24, paddingBottom: 40, gap: 14 }}>
            <View style={{ gap: 4, marginBottom: 4 }}>
              <Text style={{ color: C.white, fontSize: 34, fontWeight: '800', letterSpacing: -1.2 }}>Đăng nhập</Text>
              <Text style={{ color: '#A89A9E', fontSize: 15 }}>Dùng tài khoản học sinh hoặc giáo viên trường cấp cho bạn.</Text>
            </View>

            {showServer ? (
              <View style={{ gap: 6 }}>
                <Text style={{ color: C.white, fontWeight: '700', fontSize: 14 }}>Địa chỉ máy chủ</Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TextInput {...field('server')} value={server} onChangeText={(t) => { setServerText(t); setServerOk(null); }}
                    autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="vd. 192.168.1.10:8000" />
                  <Pressable onPress={check} accessibilityLabel="Kiểm tra kết nối"
                    style={{ width: 54, borderRadius: 16, backgroundColor: serverOk ? C.ok : DARK_FIELD, borderWidth: 2, borderColor: serverOk ? C.ok : DARK_LINE, alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name={checking ? 'hourglass-outline' : serverOk ? 'checkmark' : 'wifi'} size={20} color={C.white} />
                  </Pressable>
                </View>
                <Text style={{ color: '#8E7F83', fontSize: 12 }}>
                  IP Wi-Fi của máy tính đang chạy backend, vd. 192.168.1.10:8000.{hasDefaultServer() ? ' Để trống để tự tìm.' : ''}
                </Text>
              </View>
            ) : null}

            <View style={{ gap: 6 }}>
              <Text style={{ color: C.white, fontWeight: '700', fontSize: 14 }}>Tên đăng nhập hoặc email</Text>
              <TextInput {...field('user')} value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false}
                textContentType="username" autoComplete="username" returnKeyType="next" placeholder="vd. sv-01" />
            </View>
            <View style={{ gap: 6 }}>
              <Text style={{ color: C.white, fontWeight: '700', fontSize: 14 }}>Mật khẩu</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <TextInput {...field('pw')} value={password} onChangeText={setPassword} secureTextEntry={!showPw}
                  textContentType="password" autoComplete="password" returnKeyType="go" onSubmitEditing={submit} />
                <Text onPress={() => setShowPw((v) => !v)} style={{ position: 'absolute', right: 16, color: '#A89A9E', fontSize: 14 }}>{showPw ? 'Ẩn' : 'Hiện'}</Text>
              </View>
            </View>

            {error && (
              <View style={{ flexDirection: 'row', gap: 8, padding: 12, borderRadius: 14, backgroundColor: 'rgba(180,83,9,0.18)' }}>
                <Ionicons name="alert-circle" size={18} color="#F0A35E" />
                <Text style={{ color: '#F7D2B0', flex: 1, fontSize: 14 }}>
                  {error}
                  {offline && !showServer ? (
                    <Text onPress={() => { setServerText(getServer()); setShowServer(true); }} style={{ color: C.white, fontWeight: '700' }}> Đổi máy chủ</Text>
                  ) : null}
                </Text>
              </View>
            )}
            <Button title="Vào học" iconRight="arrow-forward" onPress={submit} busy={busy} style={{ marginTop: 6, paddingVertical: 16 }} />
            <Text style={{ color: '#8E7F83', textAlign: 'center', fontSize: 13 }}>Quên mật khẩu hay tạo tài khoản: dùng bản web.</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
