import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

import { readNodeRuntime } from './buildSteps.mts';

/**
 * Проверяет право выпуска и отсутствие метки до установки зависимостей.
 * Выходы шага дописываются одной операцией только после всех успешных проверок.
 */
function prepareRelease(): number {
  if (process.argv.length > 2) {
    console.error('Запуск: node relay/scripts/releaseTag.mts без аргументов');

    return 2;
  }

  for (const variable of ['GITHUB_REF', 'DEFAULT_BRANCH', 'GITHUB_OUTPUT']) {
    if (!process.env[variable]) {
      console.error(`Не задана переменная ${variable}`);

      return 2;
    }
  }

  const { GITHUB_REF: ref, DEFAULT_BRANCH: branch, GITHUB_OUTPUT: output } = process.env;

  if (ref !== `refs/heads/${branch}`) {
    console.error(`Выпуск разрешён только из ветки по умолчанию ${branch}; выбран ${ref}`);

    return 1;
  }

  let version: unknown;

  try {
    const manifest = JSON.parse(readFileSync('relay/package.json', 'utf8'));

    version = manifest?.version;
  } catch {
    console.error('Не удалось прочитать relay/package.json: версия недоступна');

    return 1;
  }

  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`Некорректная версия ${JSON.stringify(version) ?? 'не указана'}: ожидается X.Y.Z`);

    return 1;
  }

  let nodeVersion: string;

  try {
    const runtime = JSON.parse(readFileSync('relay/build/node-runtime.json', 'utf8'));

    nodeVersion = readNodeRuntime(runtime).version;
  } catch {
    console.error('Некорректный relay/build/node-runtime.json');

    return 1;
  }

  const tag = `relay-v${version}`;
  const existing = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], {
    stdio: 'ignore',
  });

  if (existing.status === 0) {
    console.error(
      `Версия ${version} уже выпущена: метка ${tag} есть. Поднимите version в relay/package.json`,
    );

    return 1;
  }

  if (existing.error || existing.status !== 1) {
    console.error('Не удалось проверить метки');

    return 1;
  }

  try {
    appendFileSync(output!, `tag=${tag}\nnode=${nodeVersion}\n`);
  } catch {
    console.error('Не удалось записать GITHUB_OUTPUT');

    return 1;
  }

  console.log(tag);

  return 0;
}

process.exitCode = prepareRelease();
