import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';


const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Каждый ранний старт ограничен собственным HOME и папкой данных во временном каталоге.
 * Запускается только модуль подготовки: сервер, сеть и настоящие настройки не участвуют.
 */
function fixture(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grigdesk-brand-env-'));
  const data = path.join(home, 'data');

  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const run = (extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [
    path.join(ROOT, 'server/src/startDataHome.ts'),
  ], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      GRIGDESK_HOME: data,
      ...extra,
    },
    encoding: 'utf8',
    timeout: 10000,
  });

  return {
    home,
    data,
    run,
  };
}

test('GE-03: корневые ключи запрещены в файле настроек', (t) => {
  const f = fixture(t);

  fs.mkdirSync(f.data);

  for (const prefix of ['GRIGDESK_']) {
    for (const suffix of ['HOME', 'ENV_FILE']) {
      fs.writeFileSync(path.join(f.data, '.env'), `${prefix}${suffix}=\n`);

      const result = f.run();

      assert.equal(result.status, 78, result.stderr);
      assert.match(result.stderr, /запрещён в файле настроек/);
    }
  }
});



test('GE-05: ключ плагина загружается без предупреждения', (t) => {
  const f = fixture(t);
  const key = 'COCKPIT_S2_CONTROL_URL';

  fs.mkdirSync(f.data);
  fs.writeFileSync(path.join(f.data, '.env'), `${key}=fixture-plugin\n`);

  // Чтение файла проверяется без одноимённого ключа в окружении дочернего процесса.
  // Приоритет настоящего окружения сохраняется и отдельно проверяется в DB-01.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { loadDataHomeEnv } from './server/src/lib/dataHomeBoot.ts';
    import * as fs from 'node:fs';
    loadDataHomeEnv(process.argv[1], process.env, fs);
    console.log(process.env[process.argv[2]]);
  `, path.join(f.data, '.env'), key], {
    env: {
      ...process.env,
      [key]: undefined,
    },
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'fixture-plugin');
  assert.equal(result.stderr, '');
});
