// Каталог установленных исполнителей (LLM-провайдеров) для API кокпита.
//
// Зеркало `factory runners` движка (engine/lib/runner-cli.sh): адаптер — это
// *.sh-модуль в lib/runners, служебные index/policy/catalog исполнителями не
// являются. Имя обязано проходить тот же формат, что проверяет CLI движка,
// иначе его нельзя передать обратно аргументом (`--runner-primary`, runner set).
import { promises as fs } from 'node:fs';
import path from 'node:path';

const RUNNER_ID = /^[a-z][a-z0-9_-]*$/;
const SERVICE_MODULES = new Set(['index', 'policy', 'catalog']);

/**
 * Список установленных исполнителей, отсортированный. Каталога нет — список
 * пустой (выбор исполнителя в UI просто не предлагается, это не авария).
 *
 * @returns {Promise<string[]>}
 */
export async function listInstalledRunners(config) {
  const dir = config.factoryRunnersDir || path.join(config.factoryHome, 'lib', 'runners');
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const runners = entries
    .filter((name) => name.endsWith('.sh'))
    .map((name) => name.slice(0, -'.sh'.length))
    .filter((id) => RUNNER_ID.test(id) && !SERVICE_MODULES.has(id));
  return [...new Set(runners)].sort();
}
