// Этот импорт обязан завершиться до вычисления config.ts.
import * as fs from 'node:fs';
import os from 'node:os';
import { packagedChildEnvironment } from '../../shared/node/packagedEnvironment.ts';
import { captureUserCliParent, USER_CLI_PARENT_KEY } from '../../shared/node/userCliParentEnvironment.ts';
import {
  nodeExecutable, runtimeInstallationRoot, runtimeKind, runtimeRoot,
} from './lib/runtimePaths.ts';
import {
  prepareDataHome, releaseDataHomeLock, processAlive, processStarttime,
} from './lib/dataHomeBoot.ts';

const root = runtimeRoot();
const owner = {
  pid: process.pid,
  starttime: processStarttime(process.pid) ?? '',
  root,
  startedAt: new Date().toISOString(),
};

try {
  const prepared = prepareDataHome({
    codeRoot: runtimeInstallationRoot(),
    home: os.homedir(),
    env: process.env
  }, {
    fs,
    owner,
    alive: processAlive,
    starttime: processStarttime,
    now: Date.now,
    // Срок запрашивается только при захвате блокировки, после загрузки .env.
    // Иначе прямой запуск сервера потеряет настройку, которую запускалки уже видят.
    get waitMs() {
      // Пустое или нечисловое значение — умолчание, а не нулевое ожидание.
      const raw = process.env.GRIGDESK_LOCK_WAIT_MS ?? '';
      const value = /^\d+$/.test(raw) ? Number(raw) : 15000;

      return Number.isFinite(value) && value >= 0 ? value : 15000;
    },
    sleep: (ms) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    },
  });

  process.on('exit', () => releaseDataHomeLock(prepared.lockPath, owner, fs));

  process.env[USER_CLI_PARENT_KEY] = captureUserCliParent(process.env);

  if (runtimeKind() === 'packaged') {
    Object.assign(process.env, packagedChildEnvironment({
      node: nodeExecutable(),
      env: process.env,
      home: os.homedir(),
    }));
    delete process.env.NPM_CONFIG_PREFIX;
  }
} catch (error) {
  process.stderr.write(`Папка данных: ${(error as Error).message}\n`);
  process.exit(78);
}
