import os from 'node:os';
import path from 'node:path';

import { DataHomeError } from '../src/lib/dataHomeBoot.ts';
import { isDirectRun } from '../src/lib/helperEntry.ts';
import { runtimeRoot } from '../src/lib/runtimePaths.ts';
import { seaLaunchEnvironment } from '../src/lib/seaLaunch.ts';

/**
 * Ручной launcher применяет раннее окружение и заменяет себя собственным SEA.
 * Execve сохраняет PID и stdio; source flags интерпретатора серверу не передаются.
 */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const root = runtimeRoot();
    const binary = path.join(root, 'server/grigdesk-server');
    const env = seaLaunchEnvironment(root, process.env, os.homedir(), argv.length === 0);
    const execve = (process as typeof process & {
      execve?: (file: string, args: string[], environment: Record<string, string>) => never;
    }).execve;

    if (!execve) {
      throw new Error('Вложенный Node не поддерживает execve для запуска SEA');
    }

    execve(binary, [binary, ...argv], env);

    return 1;
  } catch (error) {
    process.stderr.write(`GrigDesk не запущен: ${(error as Error).message}\n`);

    return error instanceof DataHomeError ? 78 : 1;
  }
}

if (isDirectRun(import.meta.url)) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
