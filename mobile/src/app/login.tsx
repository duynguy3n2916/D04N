import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, ErrorBox, Muted, st } from '../components/ui';
import { api, errorText, getServer, setServer } from '../lib/api';
import { useAuth } from '../lib/auth';
import { C } from '../lib/theme';

export default function Login() {
  const { login, notice } = useAuth();
  const [server, setServerText] = useState(getServer());
  const [showServer, setShowServer] = useState(!getServer());
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(notice);
  const [serverOk, setServerOk] = useState<boolean | null>(null);

  useEffect(() => { setError(notice); }, [notice]);

  const check = async () => {
    setBusy(true); setError(null); setServerOk(null);
    try { await setServer(server); setServerText(getServer()); await api('/ai/auth/config'); setServerOk(true); }
    catch (e) { setServerOk(false); setError(errorText(e)); } finally { setBusy(false); }
  };

  const submit = async () => {
    if (!username.trim() || !password) { setError('Nhập tên đăng nhập và mật khẩu.'); return; }
    setBusy(true); setError(null);
    try {
      await setServer(server);
      await login(username.trim(), password);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: 24, gap: 16, flexGrow: 1, justifyContent: 'center' }} keyboardShouldPersistTaps="handled">
          <View style={{ gap: 6, marginBottom: 12 }}>
            <View style={{ width: 56, height: 56, borderRadius: 18, backgroundColor: C.brand, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: C.white, fontSize: 22, fontWeight: '800' }}>D4</Text>
            </View>
            <Text style={[st.h1, { fontSize: 32, marginTop: 12 }]}>Chào bạn,</Text>
            <Muted>Đăng nhập bằng tài khoản học sinh hoặc giáo viên mà trường đã cấp.</Muted>
          </View>

          {showServer ? (
            <View style={{ gap: 8 }}>
              <Text style={st.label}>Địa chỉ máy chủ</Text>
              <TextInput style={st.input} value={server} onChangeText={(t) => { setServerText(t); setServerOk(null); }} autoCapitalize="none" autoCorrect={false}
                keyboardType="url" placeholder="vd. 192.168.1.10:8000" placeholderTextColor={C.muted} />
              <Muted style={{ fontSize: 13 }}>Khi chạy thử: dùng IP Wi-Fi của máy tính đang chạy backend (cùng mạng với điện thoại).</Muted>
              <Button small variant="ghost" title={serverOk ? 'Kết nối được' : 'Kiểm tra kết nối'} icon={serverOk ? 'checkmark-circle' : 'wifi'} onPress={check} busy={busy && serverOk === null} style={{ alignSelf: 'flex-start' }} />
            </View>
          ) : (
            <Text onPress={() => setShowServer(true)} style={{ color: C.muted, fontSize: 13 }}>Máy chủ: {getServer()} · <Text style={{ color: C.brand, fontWeight: '700' }}>Đổi</Text></Text>
          )}

          <View style={{ gap: 6 }}>
            <Text style={st.label}>Tên đăng nhập hoặc email</Text>
            <TextInput style={st.input} value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false}
              textContentType="username" autoComplete="username" returnKeyType="next" />
          </View>
          <View style={{ gap: 6 }}>
            <Text style={st.label}>Mật khẩu</Text>
            <TextInput style={st.input} value={password} onChangeText={setPassword} secureTextEntry
              textContentType="password" autoComplete="password" returnKeyType="go" onSubmitEditing={submit} />
          </View>
          {error && <ErrorBox message={error} />}
          <Button title="Đăng nhập" onPress={submit} busy={busy} />
          <Muted style={{ textAlign: 'center', fontSize: 13 }}>Quên mật khẩu, tạo khoá học hay quản trị: dùng bản web.</Muted>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
