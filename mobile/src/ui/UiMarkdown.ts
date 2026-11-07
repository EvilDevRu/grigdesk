import { defineComponent, h } from 'vue';
import type { VNodeChild } from 'vue';
import { Lexer } from 'marked';
import type { Token, Tokens } from 'marked';

/**
 * Из Markdown строятся только явно разрешённые Vue-узлы, сырой HTML остаётся текстом.
 * Картинки загружает отдельный компонент через авторизованный мобильный API.
 */
function nodes(tokens: Token[], depth = 0): VNodeChild[] {
  if (depth > 24) {
    return tokens.map((token) => token.raw);
  }

  return tokens.map((token): VNodeChild => {
    const nested = () => nodes('tokens' in token ? token.tokens || [] : [], depth + 1);

    switch (token.type) {
      case 'space':
        return null;
      case 'heading':
        return h(`h${Math.min(6, Math.max(2, token.depth))}`, nested());
      case 'paragraph':
        return h('p', nested());
      case 'strong':
      case 'em':
      case 'del':
      case 'blockquote':
        return h(token.type, nested());
      case 'br':
      case 'hr':
        return h(token.type);
      case 'codespan':
        return h('code', token.text);
      case 'code':
        return h('pre', { class: 'markdown-code' }, [h('code', token.text)]);
      case 'link': {
        const href = externalUrl(token.href);

        return href
          ? h('a', {
            href,
            target: '_blank',
            rel: 'noopener noreferrer',
          }, nested())
          : h('span', { class: 'markdown-path', title: token.href }, nested());
      }
      case 'list':
        return h(token.ordered ? 'ol' : 'ul', { start: token.start || undefined },
          token.items.map((item: Tokens.ListItem) => h('li', [
            item.task ? (item.checked ? '✓ ' : '□ ') : '',
            ...nodes(item.tokens, depth + 1),
          ])),
        );
      case 'table':
        return table(token as Tokens.Table, depth);
      case 'image':
        return `[Картинка: ${token.text}]`;
      case 'text':
        return 'tokens' in token && token.tokens ? nested() : token.text;
      case 'escape':
      case 'html':
        return token.text;
      default:
        return token.raw;
    }
  });
}

/**
 * Ссылки разрешены только во внешний браузер; скрипты, data и локальные схемы закрыты.
 * Относительный путь остаётся читаемой подписью и не навигирует сам WebView.
 */
function externalUrl(value: string): string | null {
  try {
    const url = new URL(value);

    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Таблица сохраняет заголовки и горизонтальную прокрутку внутри своего блока.
 * Широкие технические значения не расширяют колонку разговора или весь документ.
 */
function table(token: Tokens.Table, depth: number): VNodeChild {
  const row = (cells: Tokens.TableCell[], tag: 'th' | 'td') => h('tr',
    cells.map((cell) => h(tag, nodes(cell.tokens, depth + 1))),
  );

  return h('div', { class: 'markdown-table' }, [h('table', [
    h('thead', [row(token.header, 'th')]),
    h('tbody', token.rows.map((cells) => row(cells, 'td'))),
  ])]);
}

export default defineComponent({
  name: 'UiMarkdown',
  props: {
    text: {
      type: String,
      required: true,
    },
  },
  setup(props) {
    return () => h('div', { class: 'mobile-markdown' }, nodes(Lexer.lex(props.text, {
      gfm: true,
      breaks: true,
    })));
  },
});
