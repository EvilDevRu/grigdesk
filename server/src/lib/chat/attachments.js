import { promises as fs } from 'node:fs';
import path from 'node:path';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/**
 * Превращает присланный клиентом token в обычный файл внутри server-owned каталога.
 * Симлинки и любые варианты выхода по пути отклоняются до чтения содержимого.
 */
export async function resolveChatAttachment(root, token, { imageOnly = true } = {}) {
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
export async function resolveLegacyChatAttachment(root, candidate) {
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

export default resolveChatAttachment;
