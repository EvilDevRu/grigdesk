import os from 'node:os';
import path from 'node:path';

import { dataHome, dataPath } from '../../shared/runtime/dataHome.ts';
import { installBinary, type InstallOptions } from './installSteps.mts';

const GLM_MODES = ['api', 'coding-plan'] as const;

type GlmMode = typeof GLM_MODES[number];

/**
 * Все три обязательных пути задаёт вызывающий установленного потребителя.
 * Режим GLM передаёт тот же потребитель: admission сверяется для фактического
 * режима работы службы, а не только для default контракта.
 * Неизвестные и повторные флаги отвергаются до lock, probes и файловых эффектов.
 */
function parseArguments(args: string[]): InstallOptions {
  const flags = new Map<string, string>();
  const allowed = ['--binary', '--target', '--host-contract', '--releases-dir', '--glm-mode'];

  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    const value = args[index + 1];

    if (!allowed.includes(name) || flags.has(name) || !value || value.startsWith('--')) {
      throw new Error('Некорректные аргументы установщика');
    }

    flags.set(name, name === '--glm-mode' ? value : path.resolve(value));
  }

  for (const required of allowed.slice(0, 3)) {
    if (!flags.has(required)) {
      throw new Error('Не задан обязательный путь установщика');
    }
  }

  const glmMode = flags.get('--glm-mode') ?? 'api';

  if (!GLM_MODES.includes(glmMode as GlmMode)) {
    throw new Error('Неизвестный режим GLM установщика');
  }

  return {
    binary: flags.get('--binary')!,
    target: flags.get('--target')!,
    hostContract: flags.get('--host-contract')!,
    releasesDir: flags.get('--releases-dir') ?? path.join(
      dataPath(dataHome({ env: process.env, home: os.homedir() }), 'deepseekRuntime'), 'releases',
    ),
    glmMode: glmMode as GlmMode,
  };
}

/**
 * Ошибка аргументов отличается от отказа безопасной установки.
 * Предупреждение памяти выводится только после успешной публикации несовместимого ELF.
 */
async function main(): Promise<void> {
  let options: InstallOptions;

  try {
    options = parseArguments(process.argv.slice(2));
  } catch {
    process.stderr.write('Использование: install:binary -- --binary <ELF> --target <путь> '
      + '--host-contract <файл> [--releases-dir <каталог>] [--glm-mode api|coding-plan]\n');
    process.exitCode = 2;

    return;
  }

  try {
    const result = await installBinary(options);

    process.stdout.write(`${JSON.stringify(result)}\n`);

    if (result.memory === 'resets') {
      process.stderr.write('чаты DeepSeek/GLM начнут память заново, лента сохранится\n');
    }
  } catch (error) {
    process.stderr.write(`Установка DeepSeek не выполнена: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}

await main();
