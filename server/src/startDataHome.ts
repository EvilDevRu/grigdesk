// Этот импорт обязан завершиться до вычисления config.ts.
import * as fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  prepareDataHome, releaseDataHomeLock, processAlive, processStarttime,
} from './lib/dataHomeBoot.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const owner = {
  pid: process.pid,
  starttime: processStarttime(process.pid) ?? '',
  root,
  startedAt: new Date().toISOString(),
};

try {
  const prepared = prepareDataHome({
    codeRoot: root,
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
      const raw = process.env.COCKPIT_LOCK_WAIT_MS ?? '';
      const value = /^\d+$/.test(raw) ? Number(raw) : 15000;

      return Number.isFinite(value) && value >= 0 ? value : 15000;
    },
    sleep: (ms) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    },
  });

  process.on('exit', () => releaseDataHomeLock(prepared.lockPath, owner, fs));
} catch (error) {
  process.stderr.write(`Папка данных: ${(error as Error).message}\n`);
  process.exit(78);
}
