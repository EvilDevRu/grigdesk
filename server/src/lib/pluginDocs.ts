// Документация пользовательского плагина живёт в самом пакете, в постоянном месте:
// оглавление `docs/README.md`, документы рядом с ним. Манифест это место не настраивает —
// кокпит знает его заранее и проверяет только, что оглавление есть. Содержимое документов
// кокпит не читает: путь к оглавлению получает агент и дальше идёт по ссылкам сам.
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Каталог документации внутри пакета и его оглавление.
export const PLUGIN_DOCS_DIR = 'docs';
export const PLUGIN_DOCS_INDEX = 'README.md';

// Найденная документация: каталог — для права чтения, оглавление — для подсказки агенту.
export interface PluginDocsLocation {
  dir: string;
  index: string;
}

// Документация включённого плагина в том виде, в каком её называет ход чата.
export interface PluginDocsEntry extends PluginDocsLocation {
  id: string;
  name: string;
  description: string;
}

/**
 * Документация есть, когда `docs/` — обычный каталог, а `README.md` в нём — обычный файл.
 * Ссылку на месте любого из них не принимаем: агент получает право читать этот каталог,
 * и оно не должно уводить за пределы пакета.
 */
export async function resolvePluginDocs(pluginDir: string): Promise<PluginDocsLocation | null> {
  const dir = path.join(pluginDir, PLUGIN_DOCS_DIR);
  const index = path.join(dir, PLUGIN_DOCS_INDEX);
  const [dirStat, indexStat] = await Promise.all([
    fs.lstat(dir).catch(() => null),
    fs.lstat(index).catch(() => null),
  ]);

  if (!dirStat?.isDirectory() || !indexStat?.isFile()) {
    return null;
  }

  return { dir, index };
}
