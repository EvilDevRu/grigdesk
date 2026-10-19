import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256File } from '../../shared/node/hash.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const shared = [
  'shared/chat/deepSeekBinary.ts',
  'shared/lib/canonicalJson.ts',
  'shared/lib/contractDecoders.ts',
  'shared/node/nodeRuntime.ts',
  'shared/node/deepSeekArtifact.ts',
  'shared/node/directoryLock.ts',
  'shared/node/files.ts',
  'shared/node/hash.ts',
  'shared/node/seaBuild.ts',
  'shared/runtime/dataHome.ts',
  'shared/runtime/nodeVersion.ts',
];
const scripts = [
  'binaryInputs.mts', 'buildBinary.mts', 'buildPayload.mts', 'buildSteps.mts',
  'packagePayload.mts', 'prepareRuntimeDeps.mts',
];

/**
 * Перечисляются собственные source-файлы без node_modules, upstream или чужого UI.
 * Относительные имена и сортировка исключают случайный путь приватной build fixture.
 */
async function sourceFiles(relative: string): Promise<string[]> {
  const result: string[] = [];

  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = `${relative}/${entry.name}`;

    if (entry.isDirectory()) {
      result.push(...await sourceFiles(file));
    } else if (entry.isFile() && /\.(?:ts|mjs)$/u.test(entry.name)) {
      result.push(file);
    }
  }

  return result;
}

/**
 * Отпечаток пакета включает только его builder/resources и реально используемые shared helpers.
 * Generation хранит собственную полную identity; посторонний UI не является входом поставки.
 */
export async function binaryPackageInputs(): Promise<Record<string, string>> {
  const files = [
    ...shared,
    ...scripts.map((name) => `deepseek/scripts/${name}`),
    ...await sourceFiles('deepseek/src'),
    'deepseek/package.json',
    'deepseek/package-lock.json',
    'deepseek/build/node-runtime.json',
    'deepseek/compatibility/glm.json',
  ].sort();
  const entries = await Promise.all(files.map(async (name) => [
    name, await sha256File(path.join(root, name)),
  ]));

  return Object.fromEntries(entries);
}
