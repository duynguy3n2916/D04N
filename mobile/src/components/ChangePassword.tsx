import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import { C } from '../lib/theme';
import { Button, ErrorBox, Muted, st } from './ui';

/** Đổi mật khẩu (bắt buộc ở lần đăng nhập đầu nếu tài khoản do giáo viên tạo). */
export function ChangePassword({ forced, onDone }: { forced?: boolean; onDone?: () => void }) {
  const { changePassword } = useAuth();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const submit = async () => {
    if (next.length < 8) { setError('Mật khẩu mới cần ít nhất 8 ký tự.'); return; }
    if (next !== again) { setError('Hai lần nhập mật khẩu mới chưa khớp.'); return; }
    setBusy(true); setError(null);
    try { await changePassword(cur, next); setOk(true); setCur(''); setNext(''); setAgain(''); onDone?.(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <View style={{ gap: 10 }}>
      {forced && <Muted>Đây là lần đăng nhập đầu tiên. Hãy đặt mật khẩu mới để tiếp tục.</Muted>}
      <Text style={st.label}>Mật khẩu hiện tại</Text>
      <TextInput style={st.input} value={cur} onChangeText={setCur} secureTextEntry />
      <Text style={st.label}>Mật khẩu mới</Text>
      <TextInput style={st.input} value={next} onChangeText={setNext} secureTextEntry />
      <Text style={st.label}>Nhập lại mật khẩu mới</Text>
      <TextInput style={st.input} value={again} onChangeText={setAgain} secureTextEntry onSubmitEditing={submit} />
      {error && <ErrorBox message={error} />}
      {ok && !forced && <Text style={{ color: C.okText, fontWeight: '700' }}>Đã đổi mật khẩu.</Text>}
      <Button title="Đổi mật khẩu" onPress={submit} busy={busy} />
    </View>
  );
}
