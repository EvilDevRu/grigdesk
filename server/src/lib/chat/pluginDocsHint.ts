// Подсказка хода о документации включённых плагинов. Блок принадлежит серверному prompt:
// в историю уходит исходный текст человека, а не эта подсказка.
import path from 'node:path';

import type { PluginDocsEntry } from '../pluginDocs.ts';

// Сколько плагинов назвать в одном ходе и сколько символов отдать подписи каждого.
const MAX_LISTED = 20;
const MAX_LABEL = 200;

/**
 * Имя и описание приходят из манифеста установленного пакета. Перевод строки или
 * квадратная скобка в них не должны рвать рамку блока, поэтому подпись сводится
 * к одной строке ограниченной длины без управляющих символов.
 */
function oneLine(value: string): string {
  const text = String(value || '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/gu, ' ')
    .replace(/\[/gu, '(')
    .replace(/\]/gu, ')')
    .replace(/\s+/gu, ' ')
    .trim();

  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text;
}

/**
 * Строка плагина: подпись из манифеста и абсолютный путь оглавления — рабочая папка
 * разговора может лежать далеко от каталога плагинов.
 */
function entryLine(entry: PluginDocsEntry): string {
  const name = oneLine(entry.name) || entry.id;
  const description = oneLine(entry.description);
  const label = description ? `«${name}» (${entry.id}) — ${description}` : `«${name}» (${entry.id})`;

  return `- ${label}: ${entry.index}`;
}

/**
 * Дописывает к ходу оглавления документации включённых плагинов. Без них текст хода
 * не меняется: пустая подсказка тратила бы контекст каждого хода впустую.
 */
export function withPluginDocsHint(message: string, entries: readonly PluginDocsEntry[]): string {
  const first = entries[0];

  if (!first) {
    return message;
  }

  const listed = entries.slice(0, MAX_LISTED);
  const rest = entries.length - listed.length;
  const root = path.dirname(path.dirname(first.dir));
  const lines = [
    '[Подсказка Cockpit: документация плагинов]',
    'Включённые плагины держат документацию у себя, оглавление — docs/README.md в папке плагина.',
    'Открывай его, только если просьба касается плагина, и читай документы по ссылкам из него.',
    ...listed.map(entryLine),
    ...(rest > 0 ? [`- ещё ${rest} не названы: их оглавления — ${root}/<id>/docs/README.md`] : []),
    '[/Подсказка]',
  ];

  return `${message}\n\n${lines.join('\n')}`;
}
