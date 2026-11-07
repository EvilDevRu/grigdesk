import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HOST_ENV_SUFFIXES, LEGACY } from '../../shared/runtime/legacyBrand.ts';

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

for (const [id, suffix] of [['GE-01', 'HOME'], ['GE-02', 'ENV_FILE']]) {
  test(`${id}: старый ключ корня отвергается до записи`, (t) => {
    const f = fixture(t);
    const result = f.run({ [`${LEGACY.envPrefix}${suffix}`]: '/forbidden' });

    assert.equal(result.status, 78, result.stderr);
    assert.match(result.stderr, new RegExp(`GRIGDESK_${suffix}`));
    assert.equal(fs.existsSync(f.data), false);
  });
}

test('GE-03: все четыре ключа корней запрещены в файле настроек', (t) => {
  const f = fixture(t);

  fs.mkdirSync(f.data);

  for (const prefix of [LEGACY.envPrefix, 'GRIGDESK_']) {
    for (const suffix of ['HOME', 'ENV_FILE']) {
      fs.writeFileSync(path.join(f.data, '.env'), `${prefix}${suffix}=\n`);

      const result = f.run();

      assert.equal(result.status, 78, result.stderr);
      assert.match(result.stderr, /запрещён в файле настроек/);
    }
  }
});

test('GE-04: старый ключ хоста предупреждает один раз, без значения и подстановки', (t) => {
  const f = fixture(t);
  const key = `${LEGACY.envPrefix}LOG`;

  fs.mkdirSync(f.data);
  fs.writeFileSync(path.join(f.data, '.env'), `${key}=secret-fixture-value\n`);

  const result = f.run({ [key]: 'another-secret' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.split('\n').filter((line) => line.includes(key)).length, 1);
  assert.match(result.stderr, /node tools\/brandMove.mts/);
  assert.doesNotMatch(result.stderr, /secret/);

  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { loadDataHomeEnv } from './server/src/lib/dataHomeBoot.ts';
    import * as fs from 'node:fs';
    const env = {};
    loadDataHomeEnv(process.argv[1], env, fs);
    console.log(String(env.GRIGDESK_LOG));
  `, path.join(f.data, '.env')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10000,
  });

  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), 'undefined');
});

test('GE-05: ключ плагина загружается без предупреждения', (t) => {
  const f = fixture(t);
  const key = `${LEGACY.envPrefix}S2_CONTROL_URL`;

  fs.mkdirSync(f.data);
  fs.writeFileSync(path.join(f.data, '.env'), `${key}=fixture-plugin\n`);

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { loadDataHomeEnv } from './server/src/lib/dataHomeBoot.ts';
    import * as fs from 'node:fs';
    loadDataHomeEnv(process.argv[1], process.env, fs);
    console.log(process.env[process.argv[2]]);
  `, path.join(f.data, '.env'), key], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'fixture-plugin');
  assert.equal(result.stderr, '');
});

test('GE-06: список ключей хоста совпадает с исходниками продукта', () => {
  const roots = ['server/src/', 'server/scripts/', 'cli/', 'deploy/', 'shared/', 'engine/',
    'desktop/src/', 'tracker/src/', 'tools/'];
  const extensions = new Set(['', '.ts', '.mts', '.js', '.mjs', '.cjs', '.sh', '.py', '.service']);
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 << 20,
  }).split('\n');
  const found = new Set<string>();

  for (const file of new Set(files)) {
    const full = path.join(ROOT, file);

    if (!roots.some((root) => file.startsWith(root)) || file.startsWith('tools/deepseek')
      || !extensions.has(path.extname(file)) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      continue;
    }

    const bytes = fs.readFileSync(full);

    if (!bytes.includes(0)) {
      for (const match of bytes.toString('utf8').matchAll(/GRIGDESK_([A-Z0-9_]+)/g)) {
        found.add(match[1]!);
      }
    }
  }

  assert.deepEqual([...HOST_ENV_SUFFIXES], [...found].sort());
});

// Эти три host-owned значения образуют один неделимый контекст bind новой попытки.
// Частичный набор отвергается движком до active pointer и первого provider.
test('GE-runtime-pin: host inventory содержит все поля reservation context', () => {
  for (const name of ['SERVER_RUNTIME_RESERVATION', 'SERVER_RUNTIME_NODE', 'SERVER_RUNTIME_PIN_HELPER']) {
    assert.ok(HOST_ENV_SUFFIXES.includes(name));
  }
});
