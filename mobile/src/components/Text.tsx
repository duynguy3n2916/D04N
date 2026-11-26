import { StyleSheet, Text as RNText, TextInput as RNTextInput, type TextInputProps, type TextProps } from 'react-native';
import { C, F } from '../lib/theme';

// Text / TextInput dùng chữ Be Vietnam Pro như bản web. Viết fontWeight như bình thường,
// component tự đổi sang đúng họ chữ (React Native không tự chọn độ đậm cho font tải ngoài).
function fontFor(style: any) {
  const flat = StyleSheet.flatten(style) || {};
  const w = String(flat.fontWeight ?? '400');
  const n = w === 'bold' ? 700 : w === 'normal' ? 400 : Math.min(800, Math.max(400, Math.round(Number(w) / 100) * 100));
  // hạ một bậc đậm (F đã đổi 700 -> SemiBold, 800 -> Bold); 600 -> Medium
  const key = (n === 600 ? 500 : n) as keyof typeof F;
  const { fontWeight, ...rest } = flat;
  return rest.fontFamily ? flat : { ...rest, fontFamily: F[key] || F[500] };
}

export function Text({ style, ...props }: TextProps) {
  return <RNText {...props} style={[{ color: C.ink }, fontFor(style)]} />;
}

export function TextInput({ style, ...props }: TextInputProps) {
  return <RNTextInput placeholderTextColor={C.muted} {...props} style={fontFor(style)} />;
}
