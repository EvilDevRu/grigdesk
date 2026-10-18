// Продуктовый канон — то, что реально уезжает в поставку: документы docs/grigdesk/guide/
// и дополнительные runtime-контракты. Папки областей docs/grigdesk/<область>/ сюда НЕ входят:
// в них живёт и история снятых решений (удалённые панели, прежние API), которую сторожа
// «устаревшее не вернулось» читали бы как возврат. Их целостность проверяет
// documentation-structure.test.mts.
import { readFile, readdir } from 'node:fs/promises';

const ROOT = new URL('../../../', import.meta.url);

const CANON_DIRS = ['docs/grigdesk/reference/', 'docs/grigdesk/guide/'];

async function readMarkdown(relativeDir) {
  const dir = new URL(relativeDir, ROOT);
  const names = (await readdir(dir)).filter((name) => name.endsWith('.md')).sort();

  return Promise.all(names.map((name) => readFile(new URL(name, dir), 'utf8')));
}

/** Весь продуктовый канон одним текстом — им проверяются сквозные контракты. */
export async function canonDocs() {
  const parts = await Promise.all(CANON_DIRS.map((dir) => readMarkdown(dir)));

  return parts.flat().join('\n');
}

/** Корневые инструкции проекта, которые тоже входят в поставку. */
export async function rootDoc(name) {
  return readFile(new URL(name, ROOT), 'utf8');
}
