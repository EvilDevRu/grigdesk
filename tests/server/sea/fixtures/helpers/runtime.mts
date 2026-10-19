import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  helperCommand,
  runtimeKind,
  runtimeRoot,
} from '../../../../../server/src/lib/runtimePaths.ts';

/**
 * Проверяет контекст самого бандла и вложенный запуск по каталогу helper-ов.
 * Ошибка ресурса возвращается в отчёте, чтобы assertion называл нарушенный контракт.
 */
export function main(args: string[]): void {
  const command = helperCommand('direct-ssh-policy-hook', ['--no-ssh']);
  const nested = spawnSync(command.command, command.args, {
    env: { PATH: '/nonexistent' },
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
    encoding: 'utf8',
  });
  let resource = '';

  try {
    resource = readFileSync(new URL('./runtime.txt', import.meta.url), 'utf8');
  } catch (error) {
    resource = String(error);
  }

  console.log(JSON.stringify({
    kind: runtimeKind(),
    root: runtimeRoot(),
    args,
    resource,
    nested: {
      code: nested.status,
      stdout: nested.stdout,
      stderr: nested.stderr,
    },
  }));
}
