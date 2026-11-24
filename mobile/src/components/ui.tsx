import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps, ReactNode } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { C, R, S } from '../lib/theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

/** Khung cuộn của một màn hình, có kéo xuống để tải lại. */
export function Screen({ children, onRefresh, refreshing, style }: {
  children: ReactNode; onRefresh?: () => void; refreshing?: boolean; style?: StyleProp<ViewStyle>;
}) {
  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.bg }} contentContainerStyle={[{ padding: S.lg, gap: S.md, paddingBottom: 40 }, style]}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={C.brand} colors={[C.brand]} /> : undefined}>
      {children}
    </ScrollView>
  );
}

export function Card({ children, style, onPress }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  if (onPress) {
    return <Pressable onPress={onPress} style={({ pressed }) => [st.card, pressed && { opacity: 0.85 }, style]}>{children}</Pressable>;
  }
  return <View style={[st.card, style]}>{children}</View>;
}

export function H1({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[st.h1, style]}>{children}</Text>;
}
export function H2({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[st.h2, style]}>{children}</Text>;
}
export function Muted({ children, style, numberOfLines }: { children: ReactNode; style?: StyleProp<TextStyle>; numberOfLines?: number }) {
  return <Text style={[st.muted, style]} numberOfLines={numberOfLines}>{children}</Text>;
}
export function Kicker({ children }: { children: ReactNode }) {
  return <Text style={st.kicker}>{children}</Text>;
}

export function Button({ title, onPress, variant = 'primary', icon, disabled, busy, style, small }: {
  title: string; onPress?: () => void; variant?: 'primary' | 'ghost' | 'soft'; icon?: IconName; disabled?: boolean; busy?: boolean;
  style?: StyleProp<ViewStyle>; small?: boolean;
}) {
  const fg = variant === 'primary' ? C.white : C.brand;
  return (
    <Pressable onPress={onPress} disabled={disabled || busy} accessibilityRole="button"
      style={({ pressed }) => [st.btn, small && st.btnSm, st[variant], (disabled || busy) && { opacity: 0.5 }, pressed && { opacity: 0.8 }, style]}>
      {busy ? <ActivityIndicator color={fg} size="small" /> : icon ? <Ionicons name={icon} size={small ? 16 : 18} color={fg} /> : null}
      <Text style={[st.btnText, small && { fontSize: 14 }, { color: fg }]}>{title}</Text>
    </Pressable>
  );
}

export function Progress({ value, style }: { value: number; style?: StyleProp<ViewStyle> }) {
  const pct = Math.max(0, Math.min(1, value || 0));
  return (
    <View style={[st.track, style]} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(pct * 100) }}>
      <View style={[st.fill, { width: `${pct * 100}%` }]} />
    </View>
  );
}

export function Spinner() {
  return <View style={{ padding: 32, alignItems: 'center' }}><ActivityIndicator color={C.brand} size="large" /></View>;
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={st.error}>
      <Ionicons name="alert-circle" size={20} color={C.wrong} />
      <Text style={{ flex: 1, color: C.ink }}>{message}</Text>
      {onRetry && <Button small variant="ghost" title="Thử lại" onPress={onRetry} />}
    </View>
  );
}

export function Empty({ title, children, icon = 'leaf-outline' }: { title: string; children?: ReactNode; icon?: IconName }) {
  return (
    <View style={{ alignItems: 'center', padding: 32, gap: 8 }}>
      <View style={st.emptyIcon}><Ionicons name={icon} size={30} color={C.brand} /></View>
      <Text style={[st.h2, { textAlign: 'center' }]}>{title}</Text>
      {children ? <Text style={[st.muted, { textAlign: 'center' }]}>{children}</Text> : null}
    </View>
  );
}

export function Pill({ label, active, onPress, count }: { label: string; active?: boolean; onPress?: () => void; count?: number }) {
  return (
    <Pressable onPress={onPress} style={[st.pill, active && st.pillOn]} accessibilityState={{ selected: !!active }}>
      <Text style={[st.pillText, active && { color: C.white }]}>{label}{count != null ? ` · ${count}` : ''}</Text>
    </Pressable>
  );
}

export function Tag({ label, tone = 'muted' }: { label: string; tone?: 'ok' | 'bad' | 'brand' | 'muted' }) {
  const map = { ok: [C.okSoft, C.okText], bad: [C.wrongSoft, C.wrong], brand: [C.brandSoft, C.brand], muted: [C.wash, C.muted] } as const;
  const [bg, fg] = map[tone];
  return <View style={[st.tag, { backgroundColor: bg }]}><Text style={{ color: fg, fontSize: 12, fontWeight: '700' }}>{label}</Text></View>;
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: S.sm }, style]}>{children}</View>;
}

export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const initials = (name || '?').trim().split(/\s+/).slice(-2).map((w) => w[0]).join('').toUpperCase();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: C.brandSoft, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: C.brand, fontWeight: '800', fontSize: size * 0.38 }}>{initials}</Text>
    </View>
  );
}

export const st = StyleSheet.create({
  card: { backgroundColor: C.card, borderRadius: R.lg, padding: S.lg, borderWidth: 1, borderColor: C.line, gap: S.sm },
  h1: { fontSize: 26, fontWeight: '800', color: C.ink, letterSpacing: -0.5 },
  h2: { fontSize: 18, fontWeight: '700', color: C.ink },
  muted: { fontSize: 14, color: C.muted, lineHeight: 20 },
  kicker: { fontSize: 12, fontWeight: '800', color: C.brand, textTransform: 'uppercase', letterSpacing: 1 },
  body: { fontSize: 16, color: C.ink, lineHeight: 24 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, paddingHorizontal: 20, borderRadius: R.pill },
  btnSm: { paddingVertical: 8, paddingHorizontal: 14 },
  primary: { backgroundColor: C.brand },
  ghost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: C.brandLine },
  soft: { backgroundColor: C.brandSoft },
  btnText: { fontSize: 16, fontWeight: '700' },
  track: { height: 8, borderRadius: 4, backgroundColor: C.brandSoft, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: C.brand, borderRadius: 4 },
  error: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: S.md, borderRadius: R.md, backgroundColor: C.wrongSoft },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: C.brandSoft, alignItems: 'center', justifyContent: 'center' },
  pill: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: R.pill, borderWidth: 1, borderColor: C.line, backgroundColor: C.card },
  pillOn: { backgroundColor: C.brand, borderColor: C.brand },
  pillText: { fontSize: 14, fontWeight: '600', color: C.ink },
  tag: { paddingVertical: 3, paddingHorizontal: 10, borderRadius: R.pill, alignSelf: 'flex-start' },
  input: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: R.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: C.ink },
  label: { fontSize: 14, fontWeight: '700', color: C.ink, marginBottom: 6 },
});
