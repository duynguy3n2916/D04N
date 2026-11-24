// Bảng màu và chữ giống bản web (frontend/src/styles/theme.css): tông Đỏ đô, chữ Bricolage Grotesque.
export const C = {
  brand: '#8B1E2D',
  brandHover: '#7D1B29',
  brandStrong: '#6C1723',
  brandMid: '#B6707A',
  brandLine: '#D5A0A7',
  brandTint: '#EBCFD3',
  brandSoft: '#F5E6E8',
  bg: '#FCF8F8',
  wash: '#F7EFF0',
  card: '#FFFFFF',
  cardLine: '#EFE2E4',
  ink: '#22131A',
  muted: '#6A5A5C',
  line: '#E6DDDD',
  ok: '#2F9E44',
  okSoft: '#E6F6EA',
  okLine: '#9BD8A8',
  okText: '#1F7A33',
  // trạng thái "sai" dùng cam đất, không dùng đỏ để khỏi lẫn với màu thương hiệu
  wrong: '#B45309',
  wrongSoft: '#FDF0E1',
  white: '#FFFFFF',
};

/** Mỗi độ đậm của Bricolage Grotesque là một họ chữ riêng trong React Native. */
export const F = {
  400: 'BricolageGrotesque_400Regular',
  500: 'BricolageGrotesque_500Medium',
  600: 'BricolageGrotesque_600SemiBold',
  700: 'BricolageGrotesque_700Bold',
  800: 'BricolageGrotesque_800ExtraBold',
} as const;

export const R = { xl: 28, lg: 24, md: 16, sm: 12, pill: 999 };
export const S = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };

export const shadow = {
  shadowColor: '#17120F', shadowOpacity: 0.05, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 1,
};
