import { router } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';
import { Text, TextInput } from './Text';
import { api, errorText, getServer, type ClassInfo, type User } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync } from '../lib/hooks';
import { C } from '../lib/theme';
import { ChangePassword } from './ChangePassword';
import { Avatar, Button, Card, ErrorBox, H2, Muted, Row, Screen, st, Tag } from './ui';

/** Tab "Tôi": thông tin tài khoản, lớp, vào lớp bằng mã (học sinh), đổi mật khẩu, đăng xuất. */
export function AccountScreen() {
  const { user, logout } = useAuth();
  const me = useAsync((signal) => api<User & { classes: ClassInfo[] }>('/ai/auth/me', { signal }), []);
  const [showPw, setShowPw] = useState(false);
  const name = user?.display_name || user?.name || user?.user_id || '';
  const roleLabel = user?.role === 'student' ? 'Học sinh' : user?.role === 'teacher' ? 'Giáo viên' : 'Quản trị';

  return (
    <Screen onRefresh={me.reload} refreshing={me.loading && !!me.data}>
      <Card>
        <Row>
          <Avatar name={name} size={52} />
          <Row style={{ flex: 1, flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
            <H2>{name}</H2>
            <Muted>@{user?.user_id}</Muted>
          </Row>
          <Tag tone="brand" label={roleLabel} />
        </Row>
      </Card>
      <Card>
        <H2>Lớp của tôi</H2>
        {me.error && <ErrorBox message={me.error} onRetry={me.reload} />}
        {me.data && !me.data.classes?.length && <Muted>Chưa ở lớp nào.</Muted>}
        {me.data?.classes?.map((c) => (
          <Row key={c.class_id} style={{ justifyContent: 'space-between' }}>
            <Text style={{ color: C.ink, fontSize: 15, flex: 1 }}>{c.name}</Text>
            <Muted>{c.class_id}</Muted>
          </Row>
        ))}
        {user?.role === 'student' && (
          <Button icon="school-outline" title="Tham gia lớp / xem lớp của tôi" onPress={() => router.push('/classes')} style={{ marginTop: 6 }} />
        )}
      </Card>
      <Card>
        <Button variant="soft" icon="key-outline" title={showPw ? 'Ẩn đổi mật khẩu' : 'Đổi mật khẩu'} onPress={() => setShowPw((v) => !v)} />
        {showPw && <ChangePassword />}
      </Card>
      <Button variant="ghost" icon="log-out-outline" title="Đăng xuất"
        onPress={() => Alert.alert('Đăng xuất?', '', [{ text: 'Huỷ', style: 'cancel' }, { text: 'Đăng xuất', style: 'destructive', onPress: () => logout() }])} />
      <Muted style={{ textAlign: 'center', fontSize: 12 }}>Máy chủ: {getServer()}</Muted>
    </Screen>
  );
}
