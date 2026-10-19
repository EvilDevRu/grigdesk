import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';

import { desktopRuntimePath, parseRuntimeDescriptor } from '../../../shared/desktop/desktopRuntime.ts';
import { verifySeaRuntime } from '../../../shared/node/seaRuntime.ts';
import { dataPath, envFilePath } from '../../../shared/runtime/dataHome.ts';
import { checkDataHome, processStarttime } from './dataHomeBoot.ts';

export interface SelectSeaServerInput {
  root: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  verify?: (root: string) => Promise<void>;
}

/**
 * Отсутствующий lock допустим, повреждённый или недоступный владелец закрывает выбор.
 * PID/starttime читаются через proc: ни нулевых, ни останавливающих сигналов нет.
 */
async function assertDataIdle(home: string): Promise<void> {
  let text: string;

  try {
    text = await readFile(dataPath(home, 'lock'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }

    throw error;
  }

  const owner = JSON.parse(text) as { pid?: number; starttime?: string };

  if (!Number.isSafeInteger(owner.pid) || !owner.pid || owner.pid < 1 || !owner.starttime) {
    throw new Error('Блокировка папки данных повреждена; проверьте владельца вручную.');
  }

  const current = processStarttime(owner.pid);
  const exists = await stat(`/proc/${owner.pid}`).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return false;
    }

    throw error;
  });

  if (current === owner.starttime || exists && !current) {
    throw new Error(`Папкой данных уже пользуется сервер (pid ${owner.pid}); закройте его перед выбором.`);
  }
}

/**
 * Старые профили не переносятся и не выбираются автоматически вместе с новым R.
 * Явный каталог задаёт человек; без него наличие source-профилей требует решения.
 */
async function assertProfiles(input: {
  previousRoot: string;
  root: string;
  env: NodeJS.ProcessEnv;
  home: string;
  dataHome: string;
}): Promise<void> {
  const settings = await readFile(envFilePath(input), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return '';
    }

    throw new Error('Не удалось проверить настройки профилей папки данных.');
  });
  const configured = parseEnv(settings).FACTORY_PROFILES_DIR;
  const explicit = input.env.FACTORY_PROFILES_DIR || configured;

  if (explicit) {
    if (!path.isAbsolute(explicit) || !(await stat(explicit)).isDirectory()) {
      throw new Error('FACTORY_PROFILES_DIR должен указывать на существующий абсолютный каталог.');
    }

    if (explicit !== configured && (configured
      || path.resolve(explicit) !== dataPath(input.dataHome, 'profiles'))) {
      throw new Error('Сохраните выбранный FACTORY_PROFILES_DIR в .env папки данных для будущего окна.');
    }

    return;
  }

  for (const candidate of new Set([input.previousRoot, input.root])) {
    if (await stat(path.join(candidate, 'profiles')).catch(() => null)) {
      throw new Error('Найдены прежние профили: явно выберите FACTORY_PROFILES_DIR перед сменой сервера.');
    }
  }
}

/**
 * Выбирает проверенный физический комплект для уже установленного окна v3.
 * Все проверки предшествуют записи; повтор того же R/D не перезаписывает резервную копию.
 */
export async function selectSeaServer(input: SelectSeaServerInput): Promise<string> {
  const env = input.env ?? process.env;
  const home = input.home ?? os.homedir();
  const runtimePath = desktopRuntimePath({ env, home });
  const directory = path.dirname(runtimePath);
  const supported = await readFile(path.join(directory, 'runtime-version'), 'utf8').catch(() => '');

  if (supported.trim() !== '3') {
    throw new Error('Сначала установите обновлённое окно: grigdesk-ctl desktop install.');
  }

  const previous = await readFile(runtimePath, 'utf8');
  const descriptor = parseRuntimeDescriptor(previous);

  if (!descriptor) {
    throw new Error('Описание прежнего сервера повреждено; восстановите runtime.json перед выбором.');
  }

  const root = await realpath(input.root);

  await (input.verify ?? verifySeaRuntime)(root);

  const selectedHome = checkDataHome({
    codeRoot: root,
    home,
    env,
  }, fs);

  await assertProfiles({
    previousRoot: descriptor.root,
    root,
    env,
    home,
    dataHome: selectedHome,
  });
  await assertDataIdle(selectedHome);

  if (descriptor.version !== 1 && descriptor.home !== selectedHome) {
    await assertDataIdle(descriptor.home);
  }

  const next = {
    version: 3 as const,
    kind: 'sea' as const,
    root,
    home: selectedHome,
  };

  if (descriptor.version === 3 && descriptor.root === root && descriptor.home === selectedHome) {
    return runtimePath;
  }

  const lock = `${runtimePath}.select-lock`;
  const temporary = `${runtimePath}.${randomUUID()}.tmp`;
  const temporaryBackup = `${temporary}.previous`;

  await mkdir(lock, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') {
      throw new Error(`Выбор сервера заблокирован: ${lock}. `
        + 'Проверьте, завершён ли другой выбор, и повторите; оставшуюся блокировку удалите вручную.');
    }

    throw error;
  });

  try {
    if (await readFile(runtimePath, 'utf8') !== previous) {
      throw new Error('Описание сервера изменилось во время проверки; повторите выбор.');
    }

    await assertDataIdle(selectedHome);

    if (descriptor.version !== 1 && descriptor.home !== selectedHome) {
      await assertDataIdle(descriptor.home);
    }

    await writeFile(temporary, JSON.stringify(next) + '\n', { flag: 'wx', mode: 0o600 });
    await writeFile(temporaryBackup, previous, { flag: 'wx', mode: 0o600 });
    await rename(temporaryBackup, `${runtimePath}.previous`);
    await rename(temporary, runtimePath);
  } finally {
    await rm(temporary, { force: true });
    await rm(temporaryBackup, { force: true });
    await rm(lock, { recursive: true, force: true });
  }

  return runtimePath;
}
