// Подсветка блоков кода через shiki. Ядро, движок и грамматики грузятся по требованию:
// пока в ответе нет кода с известным языком, ядро shiki не выполняется.
// Service Worker может заранее скачать чанки в precache.
import type { HighlighterCore, LanguageInput } from 'shiki/core';

import type { FenceToken } from './fenceLines.ts';

const MAX_HIGHLIGHT_CHARS = 20_000;
const THEME = 'grigdesk';

// Каждый import — отдельный чанк сборки. Строки обязаны быть литералами: Vite видит
// только их.
const LANGUAGE_LOADERS: Record<string, () => LanguageInput> = {
  bash: () => import('shiki/langs/bash.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  nginx: () => import('shiki/langs/nginx.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
};
const LANGUAGE_ALIASES: Record<string, string> = {
  cjs: 'javascript',
  console: 'bash',
  docker: 'dockerfile',
  js: 'javascript',
  jsonc: 'json',
  md: 'markdown',
  mjs: 'javascript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  svg: 'xml',
  ts: 'typescript',
  yml: 'yaml',
  zsh: 'bash',
};

let highlighter: Promise<HighlighterCore> | null = null;

/**
 * Каноничное имя грамматики или пустая строка. Проверка через Object.hasOwn: язык
 * `constructor` из ответа не должен найти функцию в прототипе словаря.
 */
export function canonicalLanguage(lang: string): string {
  const key = String(lang || '').toLowerCase();
  const name = Object.hasOwn(LANGUAGE_ALIASES, key) ? LANGUAGE_ALIASES[key] || key : key;

  return Object.hasOwn(LANGUAGE_LOADERS, name) ? name : '';
}

/**
 * Один подсветчик на вкладку. Тема css-variables: цвета задаёт tokens.css, поэтому
 * подсветка меняется вместе с палитрой GrigDesk, а не живёт своей.
 */
async function createHighlighter(): Promise<HighlighterCore> {
  const [core, engine] = await Promise.all([
    import('shiki/core'),
    import('shiki/engine/javascript'),
  ]);

  return core.createHighlighterCore({
    themes: [core.createCssVariablesTheme({ name: THEME, variablePrefix: '--md-code-' })],
    langs: [],
    engine: engine.createJavaScriptRegexEngine(),
  });
}

/**
 * Общий подсветчик. Неудачная загрузка (сеть, офлайн без кэша) не запоминается:
 * следующий блок попробует снова.
 */
function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighter().catch((error: unknown) => {
    highlighter = null;

    throw error;
  });

  return highlighter;
}

/**
 * Токены подсветки по строкам или null. null — честный отказ: неизвестный язык,
 * слишком длинный код или сбой загрузки; блок тогда остаётся простым кодом.
 */
export async function highlightCode(code: string, lang: string): Promise<FenceToken[][] | null> {
  const name = canonicalLanguage(lang);
  const loader = name ? LANGUAGE_LOADERS[name] : undefined;

  if (!loader || code.length > MAX_HIGHLIGHT_CHARS) {
    return null;
  }

  try {
    const instance = await getHighlighter();

    if (!instance.getLoadedLanguages().includes(name)) {
      await instance.loadLanguage(loader());
    }

    const { tokens } = instance.codeToTokens(code, { lang: name, theme: THEME });

    return tokens.map((line) => line.map((token) => ({
      content: token.content,
      color: token.color,
    })));
  } catch {
    return null;
  }
}