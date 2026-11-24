import { Fragment, type ReactElement } from 'react';
import { Text, View } from 'react-native';
import { C } from '../lib/theme';

// Trình hiển thị Markdown tối giản (tiêu đề, đoạn, danh sách, khối code, **đậm**, *nghiêng*, `code`).
// Đủ cho bài đọc và câu trả lời của Trợ lý; không kéo thêm thư viện để chạy được trên Expo Go.

function inline(text: string, key: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)]+\))/g).filter(Boolean);
  return parts.map((p, i) => {
    const k = `${key}-${i}`;
    if (p.startsWith('**') && p.endsWith('**')) return <Text key={k} style={{ fontWeight: '700' }}>{p.slice(2, -2)}</Text>;
    if (p.startsWith('`') && p.endsWith('`')) return <Text key={k} style={{ fontFamily: 'monospace', backgroundColor: C.wash, color: C.brandStrong }}>{p.slice(1, -1)}</Text>;
    if (p.startsWith('*') && p.endsWith('*') && p.length > 2) return <Text key={k} style={{ fontStyle: 'italic' }}>{p.slice(1, -1)}</Text>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(p);
    if (link) return <Text key={k} style={{ color: C.brand, fontWeight: '600' }}>{link[1]}</Text>;
    return <Fragment key={k}>{p}</Fragment>;
  });
}

export function Markdown({ text, size = 16 }: { text: string; size?: number }) {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactElement[] = [];
  let i = 0;
  const body = { fontSize: size, lineHeight: size * 1.5, color: C.ink };
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++]);
      i++;
      blocks.push(
        <View key={`c${i}`} style={{ backgroundColor: C.ink, borderRadius: 12, padding: 12 }}>
          <Text style={{ fontFamily: 'monospace', color: '#F5E6E8', fontSize: size - 3, lineHeight: (size - 3) * 1.45 }}>{code.join('\n')}</Text>
        </View>,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      blocks.push(<Text key={`h${i}`} style={{ fontSize: size + (lvl === 1 ? 8 : lvl === 2 ? 5 : 2), fontWeight: '800', color: C.ink, marginTop: 6 }}>{inline(h[2], `h${i}`)}</Text>);
      i++; continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const bullet = /\d/.test(li[1]) ? li[1] : '•';
      blocks.push(
        <View key={`l${i}`} style={{ flexDirection: 'row', gap: 8, paddingLeft: 4 }}>
          <Text style={[body, { color: C.brand, fontWeight: '700' }]}>{bullet}</Text>
          <Text style={[body, { flex: 1 }]}>{inline(li[2], `l${i}`)}</Text>
        </View>,
      );
      i++; continue;
    }
    if (line.startsWith('>')) {
      blocks.push(
        <View key={`q${i}`} style={{ borderLeftWidth: 3, borderLeftColor: C.brandLine, paddingLeft: 10 }}>
          <Text style={[body, { color: C.muted }]}>{inline(line.replace(/^>\s?/, ''), `q${i}`)}</Text>
        </View>,
      );
      i++; continue;
    }
    if (!line.trim()) { i++; continue; }
    // gộp các dòng liền nhau thành một đoạn
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*([-*+]|\d+[.)])\s|>|```)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<Text key={`p${i}`} style={body}>{inline(para.join(' '), `p${i}`)}</Text>);
  }
  return <View style={{ gap: 10 }}>{blocks}</View>;
}
