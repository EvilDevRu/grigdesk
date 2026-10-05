import { h, type FunctionalComponent } from 'vue';

import type { FenceLine } from './fenceLines.ts';

/**
 * Строки кода строятся render-функцией: шаблон внутри <pre> сохранил бы свои отступы и
 * переносы как текст кода. Между строками — ровно один перенос, как в исходнике.
 */
export const FenceCodeLines: FunctionalComponent<{ lines: FenceLine[] }> = (lineProps) => h(
  'code',
  null,
  lineProps.lines.flatMap((line, index) => {
    const node = h(
      'span',
      { class: line.kind ? ['md-line', `md-line--${line.kind}`] : 'md-line' },
      line.tokens.map((token) => h('span', token.color ? { style: { color: token.color } } : null,
        token.content)),
    );

    return index < lineProps.lines.length - 1 ? [node, '\n'] : [node];
  }),
);

FenceCodeLines.props = ['lines'];

