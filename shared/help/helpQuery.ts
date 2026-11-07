import { HELP_PAGE_SIZE, parseHelpInput } from './helpContracts.ts';
import type { HelpArticle, HelpBundle } from './helpContracts.ts';
/**
 * Одинаковая нормализация запроса и текста обеспечивает русский поиск с ё/е.
 * Это поиск подстрок с явными синонимами keywords, не обещание морфологического поиска.
 */
function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е');
}

function summary(article: HelpArticle) {
  return {
    id: article.id,
    title: article.title,
    section: article.section,
    file: article.file,

    routes: [...article.routes],
    href: `#/help/${article.id}`
  };
}
/**
 * Один чистый query используется интерфейсом, сайтом и серверным инструментом.
 * Выдача не содержит полных статей, а чтение явно сообщает следующую порцию.
 */
export function queryHelp(bundle: HelpBundle, raw: unknown) {
  const input = parseHelpInput(raw);
  const identity = {
    version: bundle.version,
    commit: bundle.commit,
    revision: bundle.revision,
    locale: bundle.locale
  };

  if (input.action === 'index') {
    return {
      ok: true,
      ...identity,
      items: bundle.articles.map(summary)
    };
  }
  if (input.action === 'read') {
    const article = bundle.articles.find((item) => item.id === input.id);

    if (!article) {
      return {
        ok: false,
        ...identity,
        error: 'help_not_found'
      };
    }

    const chars = Array.from(article.markdown);
    const text = chars.slice(input.offset, input.offset + HELP_PAGE_SIZE).join('');
    const next = input.offset + Array.from(text).length;

    return {
      ok: true,
      ...identity,
      article: summary(article),
      text,
      offset: input.offset,
      nextOffset: next < chars.length ? next : null
    };
  }

  const words = normalized(input.query).match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? [];
  const items = words.length === 0 ? [] : bundle.articles.flatMap((article) => {
    const title = normalized(article.title);
    const keywords = normalized(article.keywords.join(' '));
    const body = normalized(article.markdown);

    if (!words.every((word) => `${title} ${keywords} ${body}`.includes(word))) {
      return [];
    }

    const score = words.reduce((total, word) => total + (title.includes(word) ? 8 : 0)
      + (keywords.includes(word) ? 4 : 0) + (body.includes(word) ? 1 : 0), 0);
    const offset = Math.max(0, body.indexOf(words[0]!) - 60);
    const fragment = article.markdown.slice(offset, offset + 240).replace(/\s+/gu, ' ');

    return [{
      ...summary(article),
      fragment,
      score
    }];
  }).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, 20);

  return {
    ok: true,
    ...identity,
    items
  };
}
