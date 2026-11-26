// Bảng màu và chữ giống bản web (frontend/src/styles/theme.css): mặc định Xanh mầm, chữ Be Vietnam Pro (dễ đọc tiếng Việt).
export const C = {
  brand: '#287F39',
  brandHover: '#247233',
  brandStrong: '#1F632C',
  brandLight: '#2F9442', // đầu dải chuyển sắc của bìa khoá học
  brandMid: '#73AC7E',
  brandLine: '#ADCEB4',
  brandTint: '#D8E8DB',
  brandSoft: '#ECF3ED',
  bg: '#F7FBF8',
  wash: '#EEF5EF',
  card: '#FFFFFF',
  cardLine: '#E1EAE3',
  ink: '#191D13',
  muted: '#62655B',
  line: '#D8DAD2',
  ok: '#2F9E44',
  okSoft: '#E6F6EA',
  okLine: '#9BD8A8',
  okText: '#1F7A33',
  // trạng thái "sai" dùng cam đất, không dùng đỏ để khỏi lẫn với màu thương hiệu
  wrong: '#B45309',
  wrongSoft: '#FDF0E1',
  white: '#FFFFFF',
};

/** Mỗi độ đậm của Be Vietnam Pro là một họ chữ riêng trong React Native.
 *  Chữ đậm được hạ một bậc để giao diện bớt rối mắt (800 -> 600, 700 -> 600). */
export const F = {
  400: 'BeVietnamPro_400Regular',
  500: 'BeVietnamPro_500Medium',
  600: 'BeVietnamPro_600SemiBold',
  700: 'BeVietnamPro_600SemiBold',
  800: 'BeVietnamPro_700Bold',
} as const;

export const R = { xl: 28, lg: 24, md: 16, sm: 12, pill: 999 };
export const S = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };

export const shadow = {
  shadowColor: '#17120F', shadowOpacity: 0.05, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 1,
};
