import type { HelpBundle } from './helpContracts.ts';

export const HELP_CONTEXT_ARTICLES: Readonly<Record<string, string>> = {
  '/chats': 'chats',
  '/projects': 'projects',
  '/board': 'tasks',
  '/shelf': 'tasks',

  '/pipeline': 'pipelines',
  '/routes': 'routes',
  '/code': 'code',
  '/diff': 'code',

  '/browser': 'browser',
  '/docker': 'docker',
  '/sandboxes': 'sandboxes',
  '/showcase': 'showcase',

  '/3d': 'studio3d',
  '/video': 'speech',
  '/inbox': 'incoming',
  '/github': 'incoming',

  '/telegram': 'incoming',
  '/tools': 'plugins',
  '/ext': 'plugins',
  '/ssh': 'plugins',

  '/db': 'plugins',
  '/terminal': 'plugins',
  '/documents': 'plugins',
  '/settings': 'settings',
};
/**
 * Один синхронный справочник используется до загрузки статей и при сборке их metadata.
 * Никаких файловых прав или маршрутов API этот выбор не создаёт.
 */
export function helpContextId(route: string, settingsPageId = ''): string {
  if (settingsPageId) {
    return settingsPageId.startsWith('speech.') ? 'speech'
      : settingsPageId.startsWith('agents.') ? 'chats' : 'settings';
  }

  const prefix = `/${route.split('/').filter(Boolean)[0] ?? ''}`;

  return HELP_CONTEXT_ARTICLES[prefix] ?? 'overview';
}
/**
 * Относительный Markdown-путь разрешается только среди статей закрытого корпуса.
 * Абсолютные файлы, неподдержанные схемы и выход к документации разработки не открываются.
 */
export function helpHref(bundle: HelpBundle, articleId: string, href: string): string | false {
  const article = bundle.articles.find((item) => item.id === articleId);

  if (!article || !href || /[\u0000-\u001f\\]/u.test(href)) {
    return false;
  }

  try {
    const target = new URL(href, `https://help.invalid/${article.file}`);

    if (target.origin !== 'https://help.invalid') {
      return href.startsWith('https://') && target.protocol === 'https:'
        && !target.username && !target.password ? target.href : false;
    }
    if (target.search) {
      return false;
    }

    const file = decodeURIComponent(target.pathname.slice(1));
    const linked = bundle.articles.find((item) => item.file === file);

    return linked ? `#/help/${linked.id}${target.hash}` : false;
  }
  catch {
    return false;
  }
}
/**
 * Контекст задаёт только выбор статьи, не права или рабочую папку агента.
 * Неизвестный экран возвращает оглавление; настройки имеют собственный pageId.
 */
export function helpArticleForContext(bundle: HelpBundle, route: string, settingsPageId = ''): string {
  const id = helpContextId(route, settingsPageId);

  return bundle.articles.some((entry) => entry.id === id) ? id : 'overview';
}
