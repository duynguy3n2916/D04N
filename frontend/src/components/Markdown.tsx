import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { forwardRef, useMemo } from 'react';

export function slugify(text: string) {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'muc';
}

export interface Heading { id: string; text: string; level: number }

/** Markdown → HTML an toàn (DOMPurify), tiêu đề có id để làm mục lục. */
export function renderMarkdown(md: string): { html: string; headings: Heading[] } {
  const headings: Heading[] = [];
  const used = new Set<string>();
  const tokens = marked.lexer(md || '');
  marked.walkTokens(tokens, (t: any) => {
    if (t.type === 'heading' && t.depth <= 3) {
      let id = slugify(t.text);
      while (used.has(id)) id += '-1';
      used.add(id);
      headings.push({ id, text: t.text, level: t.depth });
    }
  });
  let raw = marked.parser(tokens) as string;
  let i = 0;
  raw = raw.replace(/<h([1-3])>/g, (m, lvl) => {
    const h = headings[i];
    if (h && String(h.level) === lvl) { i++; return `<h${lvl} id="${h.id}">`; }
    return m;
  });
  return { html: DOMPurify.sanitize(raw), headings };
}

export const Markdown = forwardRef<HTMLDivElement, { source: string; className?: string }>(function Markdown({ source, className }, ref) {
  const { html } = useMemo(() => renderMarkdown(source), [source]);
  return <div ref={ref} className={`md ${className || ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
});
