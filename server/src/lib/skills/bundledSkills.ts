import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { runtimeRoot } from '../runtimePaths.ts';

/**
 * Имя встроенного навыка подчиняется той же грамматике kebab-case, что и пункт меню «/»:
 * прочие записи каталога-источника встроенными навыками не считаются.
 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface BundledSkillsOptions {
  home?: string;
  root?: string;
}

/**
 * Встроенные навыки лежат в комплекте по прежнему адресу tools/skills, как и seed-ресурсы:
 * и в исходниках, и в распакованном комплекте корень дерева возвращает runtimeRoot.
 */
export function bundledSkillsRoot(root: string = runtimeRoot()): string {
  return path.join(root, 'tools', 'skills');
}

/**
 * Убирает прежнюю копию встроенного навыка перед зеркалированием.
 * Симлинк и файл удаляются сами по себе, а не их цель; прочие записи трактуются как каталог.
 */
async function removePreviousCopy(target: string): Promise<void> {
  const stat = await fs.lstat(target).catch(() => null);

  if (!stat) {
    return;
  }

  if (stat.isSymbolicLink() || stat.isFile()) {
    await fs.unlink(target);

    return;
  }

  await fs.rm(target, { recursive: true, force: true });
}

/**
 * Зеркалит встроенные навыки комплекта в общий каталог ~/.agents/skills при старте сервера.
 *
 * Потребитель один и тот же у меню (readHarnessSkillCommands) и файлового provider-а
 * Harness, поэтому установка именно в этот каталог делает навык «встроенным»: пункт
 * меню и раскрытие тела появляются у всех чатов экземпляра без ручных шагов. Имена из
 * комплекта перезаписываются — репозиторий остаётся источником текста; записи пользователя
 * без такого имени не трогаются и не удаляются. Повреждённый или чужой по имени навык
 * пропускается, чтобы не блокировать соседей; отсутствие каталога-источника — норма для
 * комплектов без встроенных навыков, а не ошибка. Возвращает имена установленных навыков.
 */
export async function installBundledSkills(options: BundledSkillsOptions = {}): Promise<string[]> {
  const home = options.home ?? homedir();
  const sourceRoot = bundledSkillsRoot(options.root);
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true }).catch(() => []);
  const targetRoot = path.join(home, '.agents', 'skills');
  const installed: string[] = [];

  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    const name = entry.name;
    const source = path.join(sourceRoot, name);
    const target = path.join(targetRoot, name);

    if (!SKILL_NAME.test(name) || !entry.isDirectory()) {
      continue;
    }

    try {
      if (!(await fs.stat(path.join(source, 'SKILL.md'))).isFile()) {
        continue;
      }

      await removePreviousCopy(target);
      await fs.mkdir(targetRoot, { recursive: true });
      await fs.cp(source, target, { recursive: true });
      installed.push(name);
    } catch {
      // Нехватка прав или исчезнувший посреди синка источник не должны прятать соседние навыки.
    }
  }

  return installed;
}
