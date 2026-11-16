import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

import { isRecord } from '../../../../shared/lib/objects.ts';

interface UserSkillCommand {
  cmd: string;
  desc: string;
  run: 'prompt';
  kind: 'skill';
}

/**
 * Повторяет строгую грамматику invocation-полей файлового provider Harness.
 * Неизвестное значение запрещает публикацию навыка вместо расширения его видимости.
 */
function invocationFlag(value: unknown): boolean | null | undefined {
  if (value === undefined || typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const text = String(value).toLowerCase();

  if (['true', 'yes', 'on', '1'].includes(text)) {
    return true;
  }

  if (['false', 'no', 'off', '0'].includes(text)) {
    return false;
  }

  return null;
}

/**
 * Читает только метаданные навыка; раскрытие тела по /имя остаётся у native CLI.
 * Навык без model invocation допустим человеку, а user-invocable: false скрывает пункт.
 */
function skillCommand(text: string): UserSkillCommand | null {
  const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const data: unknown = header ? parse(header[1]!) : null;

  if (!isRecord(data) || typeof data.name !== 'string'
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name)
    || typeof data.description !== 'string' || !data.description.trim()) {
    return null;
  }

  const legacy = ['disableModelInvocation', 'modelInvocable', 'userInvocable'];
  const model = invocationFlag(data['disable-model-invocation']);
  const user = invocationFlag(data['user-invocable']);

  if (legacy.some((key) => Object.hasOwn(data, key)) || model === null || user === null || user === false) {
    return null;
  }

  return {
    cmd: `/${data.name}`,
    desc: data.description.replace(/\s+/g, ' ').trim().slice(0, 120),
    run: 'prompt',
    kind: 'skill',
  };
}

/**
 * Общий каталог содержит только независимый от cwd user-agents root.
 * Qwen принимает bundles, Harness дополнительно поддерживает плоские Markdown-файлы.
 */
export async function readUserSkillCommands({
  home = homedir(), bundlesOnly = false,
}: { home?: string; bundlesOnly?: boolean } = {}): Promise<UserSkillCommand[]> {
  const directory = path.join(home, '.agents', 'skills');
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const commands = new Map<string, UserSkillCommand>();

  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    try {
      const target = path.join(directory, entry.name);
      const stat = entry.isSymbolicLink() ? await fs.stat(target) : entry;
      const file = stat.isDirectory() ? path.join(target, 'SKILL.md')
        : !bundlesOnly && stat.isFile() && entry.name.endsWith('.md') ? target : null;

      if (!file) {
        continue;
      }

      const command = skillCommand(await fs.readFile(file, 'utf8'));

      if (command && !commands.has(command.cmd)) {
        commands.set(command.cmd, command);
      }
    } catch {
      // Исчезнувший файл, сломанная ссылка или неверный YAML не прячут соседние навыки.
    }
  }

  return [...commands.values()].sort((left, right) => left.cmd.localeCompare(right.cmd));
}
