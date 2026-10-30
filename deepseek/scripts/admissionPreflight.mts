// Preflight сверяет identity входов дерева со списком допуска без сборки и живого API.
// Его вердикт управляет вопросом CLI; окончательный допуск проверяет admission:check кандидата.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { glmCompatibilityHash } from '../../shared/node/glmCompatibility.ts';
import { glmRuntimeIdentity } from './buildRuntime.mts';
import { deepSeekPackagePaths } from './paths.ts';

const MODES = ['api', 'coding-plan'] as const;

/**
 * Читает значение флага, не принимая следующий флаг за его аргумент.
 * Отсутствующее значение остаётся пустым для проверки или выбора стандартного пути.
 */
function shellArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : '';

  return value && !value.startsWith('--') ? value : '';
}

/**
 * Вердикт preflight содержит режим потребителя и режимы без совпавшей записи допуска.
 * Отсутствие плагина llm-pi-ai закрывает оба режима: живой smoke невозможен.
 */
async function main(): Promise<void> {
  const consumerMode = shellArgument('--mode');
  const compatibilityFile = shellArgument('--compatibility')
    || path.join(deepSeekPackagePaths().root, 'compatibility/glm.json');
  const hostContractFile = shellArgument('--host-contract')
    || fileURLToPath(new URL('../../server/deepseek-host-contract.json', import.meta.url));

  if (!MODES.includes(consumerMode as 'api' | 'coding-plan')) {
    throw new Error('Использование: admissionPreflight.mts --mode api|coding-plan'
      + ' [--compatibility <файл>] [--host-contract <файл>]');
  }

  const host = JSON.parse(await readFile(hostContractFile, 'utf8')) as {
    glm: { profileRevision: string; policyRevision: string };
  };
  const list = JSON.parse(await readFile(compatibilityFile, 'utf8')) as {
    admission: Array<{ mode: string; compatibility: string }>;
  };
  const identity = await glmRuntimeIdentity();
  const plugin = identity.llmPiAi;

  if (!plugin) {
    process.stdout.write(`${JSON.stringify({
      consumerMode,
      missing: [...MODES],
      pluginMissing: true,
    })}\n`);

    return;
  }

  const missing = MODES.filter((mode) => {
    const compatibility = glmCompatibilityHash({ ...identity, llmPiAi: plugin }, mode, {
      profile: host.glm.profileRevision,
      policy: host.glm.policyRevision,
    });

    return !list.admission.some((entry) => entry.mode === mode
      && entry.compatibility === compatibility);
  });

  process.stdout.write(`${JSON.stringify({
    consumerMode,
    missing,
    pluginMissing: false,
  })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
