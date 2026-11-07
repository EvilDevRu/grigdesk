// Строки кода сохраняют исходный текст независимо от подсветки и вида диффа.
export interface FenceToken {
  content: string;
  color?: string;
}

export type FenceLineKind = '' | 'add' | 'del' | 'hunk' | 'meta';

export interface FenceLine {
  kind: FenceLineKind;
  tokens: FenceToken[];
}

export const COLLAPSE_AFTER_LINES = 24;

/**
 * Строки простого кода для показа без тяжёлой библиотеки.
 * Пустой код тоже представляет одну строку блока.
 */
export function plainLines(code: string): FenceLine[] {
  return String(code ?? '').split('\n').map((content) => ({ kind: '', tokens: [{ content }] }));
}

/**
 * Дифф использует те же текстовые строки, что и обычный код.
 * Классификация строки добавляет только её визуальный смысл.
 */
export function diffLines(code: string): FenceLine[] {
  return plainLines(code).map((line) => ({
    kind: diffLineKind(line.tokens[0]?.content || ''),
    tokens: line.tokens,
  }));
}

/**
 * Служебные заголовки отличаются от добавления и удаления строки.
 * Проверяем их раньше знаков + и -, сохраняя текст без изменений.
 */
export function diffLineKind(line: string): FenceLineKind {
  if (/^(?:\+\+\+[ \t]|---[ \t]|diff |index )/.test(line)) {
    return 'meta';
  }

  if (line.startsWith('@@')) {
    return 'hunk';
  }

  if (line.startsWith('+')) {
    return 'add';
  }

  return line.startsWith('-') ? 'del' : '';
}

/**
 * Только diff и patch имеют построчные цвета изменения.
 * Другие языки проходят обычный путь подсветки.
 */
export function isDiffLanguage(lang: string): boolean {
  return ['diff', 'patch'].includes(String(lang || '').toLowerCase());
}

/**
 * Ограничение высоты включается по числу строк кода.
 * Одна длинная строка остаётся доступной через горизонтальный скролл.
 */
export function shouldCollapse(code: string): boolean {
  return String(code ?? '').split('\n').length > COLLAPSE_AFTER_LINES;
}
