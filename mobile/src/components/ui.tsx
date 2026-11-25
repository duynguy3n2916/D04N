import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import type { ComponentProps, ReactNode } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { C, R, S, shadow } from '../lib/theme';
import { Text } from './Text';

// Bộ thành phần giao diện, bám theo bản web (theme.css): thẻ trắng bo 24, nút viên tròn, bộ lọc nền mực, bìa khoá học đỏ đô.

export type IconName = ComponentProps<typeof Ionicons>['name'];

/** Khung cuộn của một màn hình, có kéo xuống để tải lại. */
export function Screen({ children, onRefresh, refreshing, style }: {
  children: ReactNode; onRefresh?: () => void; refreshing?: boolean; style?: StyleProp<ViewStyle>;
}) {
  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.bg }} contentContainerStyle={[{ padding: S.lg, gap: 14, paddingBottom: 40 }, style]}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={C.brand} colors={[C.brand]} /> : undefined}>
      {children}
    </ScrollView>
  );
}

export function Card({ children, style, onPress }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  if (onPress) {
    return <Pressable onPress={onPress} style={({ pressed }) => [st.card, pressed && { transform: [{ scale: 0.99 }], opacity: 0.92 }, style]}>{children}</Pressable>;
  }
  return <View style={[st.card, style]}>{children}</View>;
}

/** Tiêu đề trang kiểu web: dòng nhỏ đỏ đô viết hoa + tiêu đề lớn. */
export function PageHead({ kicker, title, sub }: { kicker?: string; title: ReactNode; sub?: string }) {
  return (
    <View style={{ gap: 4, marginBottom: 2 }}>
      {!!kicker && <Kicker>{kicker}</Kicker>}
      <Text style={st.h1}>{title}</Text>
      {!!sub && <Muted>{sub}</Muted>}
    </View>
  );
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
export function Kicker({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[st.kicker, style]}>{children}</Text>;
}

/** primary = đỏ đô; ghost = viền mực (như web); soft = nền hồng nhạt; dark = nền mực. */
export function Button({ title, onPress, variant = 'primary', icon, iconRight, disabled, busy, style, small }: {
  title: string; onPress?: () => void; variant?: 'primary' | 'ghost' | 'soft' | 'dark'; icon?: IconName; iconRight?: IconName;
  disabled?: boolean; busy?: boolean; style?: StyleProp<ViewStyle>; small?: boolean;
}) {
  const fg = variant === 'primary' || variant === 'dark' ? C.white : variant === 'soft' ? C.brandStrong : C.ink;
  const off = disabled || busy;
  return (
    <Pressable onPress={onPress} disabled={off} accessibilityRole="button"
      style={({ pressed }) => [st.btn, small && st.btnSm, st[variant], off && variant === 'primary' && { backgroundColor: C.line }, off && { opacity: 0.6 },
        pressed && { transform: [{ translateY: 1 }], opacity: 0.88 }, style]}>
      {busy ? <ActivityIndicator color={fg} size="small" /> : icon ? <Ionicons name={icon} size={small ? 15 : 18} color={off && variant === 'primary' ? C.muted : fg} /> : null}
      <Text style={[st.btnText, small && { fontSize: 14 }, { color: off && variant === 'primary' ? C.muted : fg }]}>{title}</Text>
      {iconRight && !busy && <Ionicons name={iconRight} size={small ? 15 : 18} color={fg} />}
    </Pressable>
  );
}

export function Progress({ value, style, light }: { value: number; style?: StyleProp<ViewStyle>; light?: boolean }) {
  const pct = Math.max(0, Math.min(1, value || 0));
  return (
    <View style={[st.track, light && { backgroundColor: 'rgba(255,255,255,0.25)' }, style]} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(pct * 100) }}>
      <View style={[st.fill, light && { backgroundColor: C.white }, { width: `${pct * 100}%` }]} />
    </View>
  );
}

/** Vòng tiến độ (mục tiêu XP hôm nay), giống web. */
export function Ring({ value, size = 76, stroke = 9, label }: { value: number; size?: number; stroke?: number; label?: string }) {
  const pct = Math.max(0, Math.min(1, value || 0));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={C.brandSoft} strokeWidth={stroke} fill="none" />
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={C.brand} strokeWidth={stroke} fill="none" strokeLinecap="round"
          strokeDasharray={`${c} ${c}`} strokeDashoffset={c * (1 - pct)} />
      </Svg>
      <Text style={{ fontWeight: '800', fontSize: size * 0.22 }}>{label ?? `${Math.round(pct * 100)}%`}</Text>
    </View>
  );
}

/** Logo "mầm": mầm hai lá lệch nhau + chữ, giống web (frontend/src/components/Logo.tsx). */
export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Path d="M32 56V30" stroke={C.brand} strokeWidth={6} strokeLinecap="round" fill="none" />
      <Path d="M32 32C32 18 22 10 8 10c0 14 10 22 24 22z" fill={C.brand} />
      <Path d="M32 28c0-12 9-19 22-19 0 12-9 19-22 19z" fill={C.brandMid} />
    </Svg>
  );
}
export function Logo({ size = 30, color = C.ink }: { size?: number; color?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <LogoMark size={size} />
      <Text style={{ fontWeight: '800', fontSize: size * 0.9, letterSpacing: -1, color }}>mầm</Text>
    </View>
  );
}

/** Bìa khoá học: nền màu chủ đạo chuyển sắc, biểu tượng sách, tên khoá (giống thẻ khoá học trên web). */
export function Cover({ title, height = 150, chip, style, radius = R.lg }: { title: string; height?: number; chip?: string; style?: StyleProp<ViewStyle>; radius?: number }) {
  return (
    <LinearGradient colors={[C.brandLight, C.brand, C.brandStrong]} start={{ x: 0.1, y: 0 }} end={{ x: 0.9, y: 1 }}
      style={[{ height, borderRadius: radius, padding: 16, justifyContent: 'flex-end', overflow: 'hidden' }, style]}>
      <View style={{ position: 'absolute', top: -40, right: -30, width: 160, height: 160, borderRadius: 80, backgroundColor: 'rgba(255,255,255,0.07)' }} />
      {!!chip && <View style={{ position: 'absolute', top: 12, left: 12, backgroundColor: C.white, borderRadius: R.pill, paddingVertical: 4, paddingHorizontal: 10 }}>
        <Text style={{ fontSize: 12, fontWeight: '700', color: C.brandStrong }}>{chip}</Text></View>}
      <Ionicons name="book-outline" size={22} color={C.white} style={{ marginBottom: 6 }} />
      <Text style={{ color: C.white, fontSize: 19, fontWeight: '700', letterSpacing: -0.3 }} numberOfLines={2}>{title}</Text>
    </LinearGradient>
  );
}

const ITEM_STYLE: Record<string, { icon: IconName; bg: string; fg: string }> = {
  video: { icon: 'play', bg: C.brand, fg: C.white },
  reading: { icon: 'book-outline', bg: C.brandTint, fg: C.brandStrong },
  slide: { icon: 'desktop-outline', bg: C.ink, fg: C.white },
  quiz: { icon: 'star', bg: C.brandStrong, fg: C.white },
};
/** Ô biểu tượng loại mục (video / bài đọc / slide / kiểm tra) như danh sách nội dung bài trên web. */
export function ItemIcon({ type, size = 40, locked }: { type: string; size?: number; locked?: boolean }) {
  const s = ITEM_STYLE[type] || ITEM_STYLE.reading;
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: locked ? C.wash : s.bg, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name={locked ? 'lock-closed-outline' : s.icon} size={size * 0.45} color={locked ? C.muted : s.fg} />
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
      <Text style={{ flex: 1, fontSize: 14 }}>{message}</Text>
      {onRetry && <Button small variant="ghost" title="Thử lại" onPress={onRetry} />}
    </View>
  );
}

export function Empty({ title, children, icon = 'leaf-outline' }: { title: string; children?: ReactNode; icon?: IconName }) {
  return (
    <View style={{ alignItems: 'center', padding: 28, gap: 8 }}>
      <View style={st.emptyIcon}><Ionicons name={icon} size={28} color={C.brand} /></View>
      <Text style={[st.h2, { textAlign: 'center' }]}>{title}</Text>
      {children ? <Text style={[st.muted, { textAlign: 'center' }]}>{children}</Text> : null}
    </View>
  );
}

/** Nút lọc: đang chọn = nền mực, chưa chọn = nền hồng nhạt; số đếm trong ô nhỏ (giống web). */
export function Pill({ label, active, onPress, count }: { label: string; active?: boolean; onPress?: () => void; count?: number }) {
  return (
    <Pressable onPress={onPress} style={[st.pill, active && st.pillOn]} accessibilityState={{ selected: !!active }}>
      <Text style={[st.pillText, active && { color: C.white }]}>{label}</Text>
      {count != null && (
        <View style={{ backgroundColor: active ? 'rgba(255,255,255,0.22)' : C.brandTint, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 }}>
          <Text style={{ fontSize: 12, fontWeight: '700', color: active ? C.white : C.brandStrong }}>{count}</Text>
        </View>
      )}
    </Pressable>
  );
}

export function Tag({ label, tone = 'muted' }: { label: string; tone?: 'ok' | 'bad' | 'brand' | 'muted' | 'dark' }) {
  const map = { ok: [C.okSoft, C.okText], bad: [C.wrongSoft, C.wrong], brand: [C.brandSoft, C.brandStrong], muted: [C.wash, C.muted], dark: [C.ink, C.white] } as const;
  const [bg, fg] = map[tone];
  return <View style={[st.tag, { backgroundColor: bg }]}><Text style={{ color: fg, fontSize: 12, fontWeight: '700' }}>{label}</Text></View>;
}

/** Ô số liệu (Chuỗi ngày, Tổng XP...) như cột phải trang học của web. */
export function Stat({ icon, label, value, brand }: { icon?: IconName; label: string; value: string; brand?: boolean }) {
  return (
    <View style={[st.card, { flex: 1, gap: 2, paddingVertical: 14 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        {icon && <Ionicons name={icon} size={14} color={C.muted} />}
        <Text style={{ fontSize: 13, color: C.muted, fontWeight: '600' }}>{label}</Text>
      </View>
      <Text style={{ fontSize: 24, fontWeight: '800', letterSpacing: -0.6, color: brand ? C.brand : C.ink }}>{value}</Text>
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: S.sm }, style]}>{children}</View>;
}

export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const initials = (name || '?').trim().split(/\s+/).slice(-1).map((w) => w[0]).join('').toUpperCase();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: C.brand, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: C.white, fontWeight: '700', fontSize: size * 0.42 }}>{initials}</Text>
    </View>
  );
}

/** Danh sách liền khối trong một thẻ (các dòng cách nhau bằng đường kẻ mảnh). */
export function ListCard({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[st.card, { padding: 6, gap: 0 }, style]}>{children}</View>;
}

export const st = StyleSheet.create({
  card: { backgroundColor: C.card, borderRadius: R.lg, padding: S.lg, borderWidth: 1, borderColor: C.cardLine, gap: S.sm, ...shadow },
  h1: { fontSize: 30, fontWeight: '800', letterSpacing: -1, lineHeight: 34 },
  h2: { fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },
  muted: { fontSize: 14, color: C.muted, lineHeight: 20 },
  kicker: { fontSize: 12, fontWeight: '800', color: C.brand, textTransform: 'uppercase', letterSpacing: 1.2 },
  body: { fontSize: 16, lineHeight: 24 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, paddingHorizontal: 22, borderRadius: R.pill },
  btnSm: { paddingVertical: 8, paddingHorizontal: 14 },
  primary: { backgroundColor: C.brand },
  dark: { backgroundColor: C.ink },
  ghost: { backgroundColor: 'transparent', borderWidth: 2, borderColor: C.ink, paddingVertical: 12 },
  soft: { backgroundColor: C.brandSoft },
  btnText: { fontSize: 16, fontWeight: '700' },
  track: { height: 8, borderRadius: 4, backgroundColor: C.brandSoft, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: C.brand, borderRadius: 4 },
  error: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: S.md, borderRadius: R.md, backgroundColor: C.wrongSoft },
  emptyIcon: { width: 60, height: 60, borderRadius: 30, backgroundColor: C.brandSoft, alignItems: 'center', justifyContent: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 14, borderRadius: R.pill, backgroundColor: C.wash },
  pillOn: { backgroundColor: C.ink },
  pillText: { fontSize: 14, fontWeight: '600', color: C.muted },
  tag: { paddingVertical: 3, paddingHorizontal: 10, borderRadius: R.pill, alignSelf: 'flex-start' },
  input: { backgroundColor: C.card, borderWidth: 2, borderColor: C.line, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, fontWeight: '600', color: C.ink },
  label: { fontSize: 14, fontWeight: '700', marginBottom: 6 },
});
