// Разбиение ответа на куски для RichMarkdown: обычный Markdown и блоки кода верхнего уровня.
import type { Token, Tokens } from 'marked';

import { lexMarkdown } from '../md.ts';

export type FenceKind = 'code' | 'mermaid';

export interface MarkdownSegment {
  key: string;
  kind: 'markdown';
  tokens: Token[];
}

export interface FenceSegment {
  key: string;
  kind: 'fence';
  fence: FenceKind;
  lang: string;
  code: string;
  closed: boolean;
}

export type RichSegment = MarkdownSegment | FenceSegment;

// Язык блока → особый вид. Всё, чего здесь нет, рисуется обычным блоком кода.
const FENCE_KINDS: Record<string, FenceKind> = {
  mermaid: 'mermaid',
};
const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Язык из info string блока: первое слово в нижнем регистре. То, что не похоже на имя
 * языка (`{.python}`, кавычки), даёт пустую строку — такой блок рисуется без подсветки.
 */
export function fenceLanguage(info: unknown): string {
  const word = String(info || '').trim().split(/\s+/)[0]?.toLowerCase() || '';

  return /^[a-z0-9_+#.-]+$/.test(word) ? word : '';
}

/**
 * Вид блока по языку. Новый вид — значение FenceKind, строка в FENCE_KINDS и ветка в
 * RichMarkdown.vue; разбиение при этом не меняется.
 */
export function fenceKind(lang: string): FenceKind {
  return Object.hasOwn(FENCE_KINDS, lang) ? FENCE_KINDS[lang] ?? 'code' : 'code';
}

/**
 * Закрыт ли блок кода. marked отдаёт незакрытый блок до конца текста — так выглядит
 * ответ, который агент ещё печатает; тяжёлую отрисовку такому блоку начинать рано.
 */
export function isClosedFence(raw: string): boolean {
  const lines = String(raw || '').replace(/\n+$/, '').split('\n');
  const open = lines[0]?.match(OPEN_FENCE)?.[1] || '';
  const close = lines.length > 1 ? lines.at(-1)?.match(CLOSE_FENCE)?.[1] || '' : '';

  return Boolean(open && close && close[0] === open[0] && close.length >= open.length);
}

/**
 * Куски ответа по порядку. Ключ — позиция и вид куска: пока агент печатает, меняется
 * только хвост, а готовые блоки сохраняют ключ и DOM. Куски из одних пустых строк
 * отбрасываются; ссылки-сноски уже разрешены общим lexer'ом.
 */
export function splitMarkdown(src: unknown): RichSegment[] {
  const segments: RichSegment[] = [];
  let pending: Token[] = [];

  const flush = () => {
    if (pending.some((token) => token.type !== 'space')) {
      segments.push({
        key: `${segments.length}:markdown`,
        kind: 'markdown',
        tokens: pending,
      });
    }

    pending = [];
  };

  for (const token of lexMarkdown(src)) {
    if (token.type !== 'code' || (token as Tokens.Code).codeBlockStyle === 'indented') {
      pending.push(token);

      continue;
    }

    const code = token as Tokens.Code;
    const lang = fenceLanguage(code.lang);

    flush();
    segments.push({
      key: `${segments.length}:fence`,
      kind: 'fence',
      fence: fenceKind(lang),
      lang,
      code: code.text,
      closed: isClosedFence(code.raw),
    });
  }

  flush();

  return segments;
}