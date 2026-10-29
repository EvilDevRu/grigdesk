import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { glmCompatibilityHash } from '../../shared/node/glmCompatibility.ts';

const run = promisify(execFile);

/**
 * Разбирает аргументы: кандидат, режим и host-контракт обязательны и абсолютны.
 * Неизвестный флаг или режим завершают проверку до запуска кандидата.
 */
function parseArguments(argv: string[]) {
  const flags = new Map<string, string>();
  const allowed = ['--binary', '--mode', '--host-contract'];

  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]!;
    const value = argv[index + 1];

    if (!allowed.includes(name) || flags.has(name) || !value || value.startsWith('--')) {
      throw new Error('Использование: admissionCheck.mts --binary <ELF> --mode api|coding-plan'
        + ' --host-contract <файл>');
    }

    flags.set(name, value);
  }

  const binary = flags.get('--binary')!;
  const mode = flags.get('--mode')!;
  const hostContract = flags.get('--host-contract')!;

  if (!path.isAbsolute(binary) || !path.isAbsolute(hostContract)) {
    throw new Error('Пути проверки допуска должны быть абсолютными');
  }

  if (!['api', 'coding-plan'].includes(mode)) {
    throw new Error('Неизвестный режим GLM проверки допуска');
  }

  return {
    binary,
    mode: mode as 'api' | 'coding-plan',
    hostContract,
  };
}

/**
 * Admission кандидата для режима: identity по фактическим входам ELF сверяется
 * со списком допусков в его metadata. Код 0 — допуск есть, 3 — требуется живой
 * smoke; скрипт не меняет файлы и не запускает модель.
 */
async function main(): Promise<void> {
  const check = parseArguments(process.argv.slice(2));
  const host = JSON.parse(await readFile(check.hostContract, 'utf8')) as {
    glm: { profileRevision: string; policyRevision: string };
  };
  const info = JSON.parse(
    (await run(check.binary, ['--runtime-info', '--json'], {
      timeout: 60000,
      maxBuffer: 1 << 20,
    })).stdout,
  ) as {
    glm?: {
      inputs?: Parameters<typeof glmCompatibilityHash>[0];
      admission?: Array<{ mode: string; compatibility: string }>;
    };
  };

  if (!info.glm?.inputs || !Array.isArray(info.glm.admission)) {
    throw new Error('Metadata кандидата не содержит входы GLM');
  }

  const identity = glmCompatibilityHash(info.glm.inputs, check.mode, {
    profile: host.glm.profileRevision,
    policy: host.glm.policyRevision,
  });
  const admitted = info.glm.admission.some((entry) => entry.mode === check.mode
    && entry.compatibility === identity);

  process.stdout.write(`${admitted ? 'ok' : 'missing'} ${check.mode} ${identity}\n`);
  process.exitCode = admitted ? 0 : 3;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
