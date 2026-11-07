import { promises as fs } from 'node:fs';
import path from 'node:path';

// Официальный слот `kimi login` — kimi-code.json; при входе через кастомное
// OAuth-окружение (свой oauth_host, нестандартный регион) CLI пишет scoped-файл
// kimi-code-env-<hash>.json. Оба варианта означают «авторизован», содержимое
// файлов GrigDesk не читает, не копирует и не логирует.
export const KIMI_CREDENTIAL_FILE = 'kimi-code.json';

const SCOPED_CREDENTIAL_PATTERN = /^kimi-code-env-[0-9a-f]+\.json$/u;

/**
 * Находит фактический credential-файл в каталоге credentials, ничего не читая.
 * Официальный слот важнее scoped; несколько scoped выбираются по имени для
 * детерминизма. Чужие файлы и каталоги с похожими именами не подходят.
 */
export async function findKimiCredentialFile(credentialsDir: string): Promise<string | null> {
  const official = path.join(credentialsDir, KIMI_CREDENTIAL_FILE);

  try {
    if ((await fs.lstat(official)).isFile()) {
      return official;
    }
  } catch {
    // Нет официального слота — смотрим scoped-файлы.
  }

  let entries: string[];

  try {
    entries = await fs.readdir(credentialsDir);
  } catch {
    return null;
  }

  const scoped = entries.filter((entry) => SCOPED_CREDENTIAL_PATTERN.test(entry)).sort();

  for (const entry of scoped) {
    const candidate = path.join(credentialsDir, entry);

    try {
      if ((await fs.lstat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Запись могла исчезнуть между readdir и lstat — пробуем следующую.
    }
  }

  return null;
}
