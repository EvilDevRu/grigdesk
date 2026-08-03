// Установка стандартного набора агентов из версионируемого посева (server/seed/agents).
// В отличие от legacy reseed (seed.js, apply отключён) это CREATE-ONLY операция:
// существующие файлы библиотеки никогда не перезаписываются — посев только
// восполняет отсутствующих. Поэтому атомарности всего набора не требуется:
// каждая запись атомарна сама по себе (AgentsStore.save). Идемпотентно.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ID_RE, parseAgentFile } from './store.js';

/**
 * Доустанавливает отсутствующих агентов из каталога посева.
 * @returns {Promise<{created: string[], skipped: string[]}>}
 */
export async function installAgents(store, seedDir) {
  let entries;
  try {
    entries = await fs.readdir(seedDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const missing = new Error(`каталог стандартного набора не найден: ${seedDir}`);
      missing.code = 'agents_seed_missing';
      throw missing;
    }
    throw error;
  }
  const created = [];
  const skipped = [];
  // Сортировка — детерминированный порядок создания и ответа.
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // Dirent.isFile() false для symlink: посев по ссылке не читаем.
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const id = entry.name.slice(0, -3);
    if (!ID_RE.test(id)) continue;
    if (await store.exists(id)) { skipped.push(id); continue; }
    const agent = parseAgentFile(await fs.readFile(path.join(seedDir, entry.name), 'utf8'));
    await store.save(id, agent);
    created.push(id);
  }
  return { created, skipped };
}
