import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { InTurnAttachment } from '../../../../shared/chat/chatInTurnContracts.ts';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
// Тип картинки по расширению: окно рисует миниатюру только для image/*.
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const ATTACHMENT_NAME_LIMIT = 200;

/**
 * Превращает присланный клиентом token в обычный файл внутри server-owned каталога.
 * Симлинки и любые варианты выхода по пути отклоняются до чтения содержимого.
 */
// Вложение чата после проверки: имя файла и его реальный путь внутри каталога.
export interface ChatAttachment {
  file: string;
  path: string;
}

export async function resolveChatAttachment(
  root: string,
  token: unknown,
  { imageOnly = true } = {},
): Promise<ChatAttachment | null> {
  const file = String(token || '').trim();
  if (!root || !file || path.basename(file) !== file || (imageOnly && !IMAGE_EXTENSIONS.has(
    path.extname(file).toLowerCase(),
  ))) {
    return null;
  }

  try {
    const [rootReal, entryStat] = await Promise.all([
      fs.realpath(root),
      fs.lstat(path.join(root, file)),
    ]);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
      return null;
    }

    const resolved = await fs.realpath(path.join(root, file));
    const relative = path.relative(rootReal, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return null;
    }

    return { file, path: resolved };
  } catch {
    return null;
  }
}

/** Старый клиент сохранял абсолютный path; принимаем его только внутри того же root. */
export async function resolveLegacyChatAttachment(
  root: string,
  candidate: unknown,
): Promise<ChatAttachment | null> {
  const requested = String(candidate || '').trim();
  if (!root || !path.isAbsolute(requested) || !IMAGE_EXTENSIONS.has(
    path.extname(requested).toLowerCase(),
  )) {
    return null;
  }

  try {
    const [rootReal, entryStat] = await Promise.all([
      fs.realpath(root),
      fs.lstat(requested),
    ]);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
      return null;
    }
    const resolved = await fs.realpath(requested);
    const relative = path.relative(rootReal, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return null;
    }
    return { file: path.basename(resolved), path: resolved };
  } catch {
    return null;
  }
}

/**
 * Блок вложений в prompt агента: пути файлов, которые он откроет сам. Одна формулировка
 * для обычного хода и уточнения, чтобы агент видел приложенное одинаково.
 */
export function chatAttachmentsBlock(paths: readonly string[]): string {
  if (!paths.length) {
    return '';
  }

  const list = paths.map((file) => `- ${file}`).join('\n');

  return '[Вложения]\nПользователь приложил файлы. Изображения открой подходящим инструментом '
    + `чтения изображений (Read или read_image — что доступно в этом окружении):\n${list}\n[/Вложения]\n\n`;
}

/**
 * Картинки уточнения от окна → записи вложений в форме сообщения истории. Любой негодный
 * элемент отклоняет весь список: молча потерянная картинка выглядела бы переданной агенту.
 */
export async function resolveInTurnAttachments(
  root: string,
  value: unknown,
): Promise<InTurnAttachment[] | null> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }

  const attachments: InTurnAttachment[] = [];

  for (const item of value as Array<{ file?: unknown; name?: unknown } | null>) {
    const resolved = await resolveChatAttachment(root, item?.file, { imageOnly: true });

    if (!resolved) {
      return null;
    }

    attachments.push({
      file: resolved.file,
      name: String(item?.name || resolved.file).slice(0, ATTACHMENT_NAME_LIMIT),
      url: `/api/chat/attachment/${resolved.file}`,
      mime: IMAGE_MIME[path.extname(resolved.file).toLowerCase()] || '',
    });
  }

  return attachments;
}

export default resolveChatAttachment;
