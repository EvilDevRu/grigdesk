import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DataHomeError, findLegacyData, checkDataHome, loadDataHomeEnv,
  acquireDataHomeLock, releaseDataHomeLock, prepareDataHome,
  processStarttime,
} from '../../server/src/lib/dataHomeBoot.ts';
import type { LockDeps, LockOwner } from '../../server/src/lib/dataHomeBoot.ts';
import { referencesOf } from '../../tools/entrypointGraph.mts';
import { freePort, isolatedEnv } from './helpers/pluginBootFixture.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Любая проверка файловой системы ограничена собственным временным деревом.
// Удаление регистрируется вместе с созданием и не зависит от результата assertions.
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grigdesk-data-boot-'));
  const codeRoot = path.join(root, 'code');
  const home = path.join(root, 'user');

  fs.mkdirSync(codeRoot);
  fs.mkdirSync(home);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  return {
    root,
    codeRoot,
    home,
    env: { HOME: home } as NodeJS.ProcessEnv
  };
}

function write(file: string, bytes: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

function owner(pid = 10): LockOwner {
  return {
    pid,
    starttime: '123',
    root: '/code',
    startedAt: '2026-01-01T00:00:00Z'
  };
}

function lockDeps(extra: Partial<LockDeps> = {}): LockDeps {
  let time = 0;

  return {
    fs,
    alive: () => false,
    starttime: () => '123',
    now: () => time,
    sleep: (ms) => {
       time += ms;
    },
    waitMs: 500,
    ...extra,
  };
}







test('GB-04: новая установка создаёт новую папку данных', (t) => {
  const f = fixture(t);
  const result = prepareDataHome(f, { ...lockDeps(), owner: owner() });

  assert.equal(result.home, path.join(f.home, '.grigdesk'));
  assert.equal(fs.existsSync(result.home), true);
});





test('GB-08: старая раскладка в коде требует ручного переноса', (t) => {
  const f = fixture(t);

  write(path.join(f.codeRoot, '.env'), 'FIXTURE=1');
  assert.throws(() => checkDataHome(f, fs), (error: Error) => {
    assert.match(error.message, /вручную/);
    assert.doesNotMatch(error.message, /tools\/moveDataHome.mts/);

    return true;
  });
});

test('DB-01 файл добавляет только отсутствующие ключи, включая пустые', (t) => {
  const f = fixture(t);
  const file = path.join(f.root, '.env');
  const env = { KEEP: 'process', EMPTY: '' } as NodeJS.ProcessEnv;

  assert.deepEqual(loadDataHomeEnv(file, env, fs), []);
  write(file, 'KEEP=file\nEMPTY=file\nADDED=value\n');
  assert.deepEqual(loadDataHomeEnv(file, env, fs), ['ADDED']);
  assert.deepEqual(env, {
    KEEP: 'process',
    EMPTY: '',
    ADDED: 'value'
  });
});

test('DB-02 зарезервированные ключи запрещены даже с пустым значением', (t) => {
  const f = fixture(t);
  const file = path.join(f.root, '.env');

  for (const key of ['GRIGDESK_HOME', 'GRIGDESK_ENV_FILE']) {
    write(file, `${key}=\n`);
    assert.throws(() => loadDataHomeEnv(file, {}, fs), DataHomeError);
  }
});

test('DB-03 сторож различает заглушки, старые данные и ссылки', (t) => {
  const f = fixture(t);
  const dirs = ['chats', 'telegram', 'github', '3d', 'agents', 'plugins'];

  for (const dir of dirs) {
    write(path.join(f.codeRoot, dir, dir === 'plugins' ? 'README.md' : '.gitignore'), '*');
  }

  assert.deepEqual(findLegacyData(f.codeRoot, fs), []);

  const sources = ['.env', 'server/.state/x', '.state/plugins/x', '.state/ui-releases/x',
    '.state/mobile/x', ...dirs.map((dir) => dir + '/x')];

  for (const source of sources) {
    const file = path.join(f.codeRoot, source);

    write(file, 'data');
    assert.ok(findLegacyData(f.codeRoot, fs).length > 0, source);
    fs.unlinkSync(file);
  }

  fs.symlinkSync(f.home, path.join(f.codeRoot, '.env'));
  assert.deepEqual(findLegacyData(f.codeRoot, fs), []);
});

test('DB-04 сторож объясняет чужую ссылку и незавершённый перенос', (t) => {
  const f = fixture(t);

  fs.symlinkSync(f.home, path.join(f.codeRoot, '.env'));
  assert.throws(() => checkDataHome(f, fs), new RegExp(f.home));
  fs.unlinkSync(path.join(f.codeRoot, '.env'));
  write(path.join(f.home, '.grigdesk/.move-journal.json'), '{"completed":false}');
  assert.throws(() => checkDataHome(f, fs), /Перенос не закончен.*вручную/s);
  write(path.join(f.home, '.grigdesk/.move-journal.json'), '{"completed":true}');
  write(path.join(f.codeRoot, '.env'), 'X=1');
  assert.throws(() => checkDataHome(f, fs), /уже завершён.*вручную/s);
  f.env.GRIGDESK_HOME = path.join(f.root, 'explicit');
  assert.doesNotThrow(() => checkDataHome(f, fs));
});

test('DB-13 вторая копия, журнал старого окна и висячая ссылка', (t) => {
  const f = fixture(t);

  write(path.join(f.codeRoot, 'server/.state/grigdesk-server.log'), 'log');
  write(path.join(f.codeRoot, 'server/.state/grigdesk-server.log.1'), 'log');
  assert.deepEqual(findLegacyData(f.codeRoot, fs), []);
  assert.doesNotThrow(() => checkDataHome(f, fs));

  write(path.join(f.codeRoot, '.git'), 'gitdir: /somewhere/.git/worktrees/x');
  assert.throws(() => checkDataHome(f, fs), /вторая копия/);
  fs.unlinkSync(path.join(f.codeRoot, '.git'));

  fs.symlinkSync(path.join(f.root, 'missing-state'), path.join(f.codeRoot, '.env'));
  assert.throws(() => checkDataHome(f, fs), /несуществующее место/);
});

test('DB-05 права, канонический путь и границы папки', (t) => {
  const f = fixture(t);
  const deps = { ...lockDeps(), owner: owner() };
  const result = prepareDataHome(f, deps);

  assert.ok(fs.existsSync(path.join(result.home, 'state')));
  assert.equal(fs.statSync(result.home).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(result.home, 'state')).mode & 0o777, 0o700);
  fs.chmodSync(result.home, 0o755);
  fs.chmodSync(path.join(result.home, 'state'), 0o755);
  prepareDataHome(f, deps);
  assert.equal(fs.statSync(result.home).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(result.home, 'state')).mode & 0o777, 0o700);

  const alias = path.join(f.root, 'alias');

  fs.symlinkSync(result.home, alias);
  f.env.GRIGDESK_HOME = alias;
  prepareDataHome(f, deps);
  assert.equal(f.env.GRIGDESK_HOME, fs.realpathSync(result.home));

  for (const bad of [f.home, path.join(f.codeRoot, 'data'), f.root]) {
    f.env.GRIGDESK_HOME = bad;
    assert.throws(() => prepareDataHome(f, deps), DataHomeError);
  }
});

test('DB-06 блокировка: ожидание, перехват, гонка и снятие только своей', (t) => {
  const f = fixture(t);
  const file = path.join(f.root, 'server.lock');
  const own = owner();

  acquireDataHomeLock(file, own, lockDeps());
  assert.ok(fs.existsSync(file));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), own);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  releaseDataHomeLock(file, owner(11), fs);
  assert.equal(fs.existsSync(file), true);
  releaseDataHomeLock(file, own, fs);
  assert.equal(fs.existsSync(file), false);
  write(file, JSON.stringify(owner(11)));
  assert.throws(
    () => acquireDataHomeLock(file, own, lockDeps({ alive: () => true })), /уже пользуется сервер/,
  );

  let checks = 0;

  acquireDataHomeLock(file, own, lockDeps({ alive: () => ++checks < 3 }));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, own.pid);

  for (const bytes of [JSON.stringify(own), JSON.stringify({ ...owner(11), starttime: 'old' }), 'garbage']) {
    write(file, bytes);
    acquireDataHomeLock(file, own, lockDeps({ alive: () => true }));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, own.pid);
  }

  write(file, 'old');

  const newer = JSON.stringify(owner(99));
  const racingFs = { ...fs, renameSync: (from: fs.PathLike, to: fs.PathLike) => {
    fs.writeFileSync(from, newer);
    fs.renameSync(from, to);
  } };

  assert.throws(() => acquireDataHomeLock(file, own, lockDeps({ fs: racingFs })), DataHomeError);
  assert.equal(fs.readFileSync(file, 'utf8'), newer);
});

test('DB-07 ранний импорт синхронен и не зависит от config', () => {
  const app = fs.readFileSync(path.join(ROOT, 'server/src/app.ts'), 'utf8');

  assert.equal(app.match(/^import .+$/m)?.[0], "import './startDataHome.ts';");

  const seen = new Set<string>();
  const queue = [path.join(ROOT, 'server/src/startDataHome.ts')];

  while (queue.length) {
    const file = queue.pop()!;

    if (seen.has(file)) {
      continue;
    }

    seen.add(file);
    assert.notEqual(path.basename(file), 'config.ts');

    const source = fs.readFileSync(file, 'utf8');

    assert.doesNotMatch(source, /\basync\b|\bawait\b/);

    for (const spec of referencesOf(source)) {
      const target = path.resolve(path.dirname(file), spec);

      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        queue.push(target);
      }
    }
  }
});

// Настоящий сервер получает только allowlist окружения и пути внутри фикстуры.
// Готовность подтверждает HTTP, завершение ожидается до удаления данных.
async function boot(t: TestContext, root: string, overrides: NodeJS.ProcessEnv = {}) {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...isolatedEnv(root, port, await freePort()), ...overrides };
  const child = spawn(process.execPath, [path.join(ROOT, 'server/src/app.ts')], { env });
  const exited = once(child, 'exit');
  let log = '';

  child.stdout.on('data', (bytes) => {
     log += bytes;
  });
  child.stderr.on('data', (bytes) => {
     log += bytes;
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  });

  const address = `http://127.0.0.1:${port}/api/health`;
  // Ждём только собственный порт и прерываем ожидание сразу при падении процесса.
  // Общий срок ограничивает зависший старт, отдельный запрос ограничен полусекундой.
  const ready = async () => {
    const deadline = Date.now() + 20_000;

    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, log);

      try {
        if ((await fetch(address, { signal: AbortSignal.timeout(500) })).status === 401) {
          return;
        }
      } catch {}

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.fail(log || 'Сервер не открыл порт');
  };

  return {
    child,
    exited,
    ready,
    address,
    log: () => log
  };
}

test('DB-08 SIGTERM снимает блокировку; DB-09 второй сервер получает 78', { timeout: 50_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grigdesk-data-server-'));
  // Удаление после процессов: после-hooks исполняются в порядке регистрации.
  const first = await boot(t, root, { GRIGDESK_CLI_TOKEN_PATH: undefined });

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await first.ready();
  assert.ok(fs.existsSync(path.join(root, 'state/cli-token')));

  const lock = path.join(root, 'state/server.lock');

  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, first.child.pid);

  const second = await boot(t, root, { GRIGDESK_LOCK_WAIT_MS: '500' });
  const started = Date.now();
  const [code] = await second.exited;

  assert.equal(code, 78, second.log());
  assert.ok(Date.now() - started < 20_000);
  assert.match(second.log(), /уже пользуется сервер/);
  assert.equal((await fetch(first.address)).status, 401);
  first.child.kill('SIGTERM');
  await first.exited;
  assert.equal(fs.existsSync(lock), false);
});

test('DB-10 сервер сам читает файл настроек до config', { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grigdesk-data-env-'));

  write(path.join(root, '.env'), `GRIGDESK_CLI_TOKEN_PATH=${root}/custom-token\n`);

  const server = await boot(t, root, { GRIGDESK_CLI_TOKEN_PATH: undefined });

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await server.ready();
  assert.ok(fs.readFileSync(path.join(root, 'custom-token'), 'utf8').trim());
  server.child.kill('SIGTERM');
  await server.exited;
});

test('DB-11 CLI проверки старой раскладки ничего не создаёт', (t) => {
  const f = fixture(t);
  const run = () => spawnSync(process.execPath,
    [path.join(ROOT, 'server/scripts/dataHomeCheck.mts'), '--code-root', f.codeRoot], {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: f.home,
        NODE_ENV: 'test'
      }, encoding: 'utf8',
    });

  assert.equal(run().status, 0);
  assert.deepEqual(fs.readdirSync(f.home), []);
  write(path.join(f.codeRoot, '.env'), 'TEST=value');

  const result = run();

  assert.equal(result.status, 78);
  assert.match(result.stderr, /вручную/);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test('DB-12 срок ожидания блокировки читается из файла настроек', (t) => {
  const f = fixture(t);
  const data = path.join(f.root, 'data');

  write(path.join(data, '.env'), 'GRIGDESK_LOCK_WAIT_MS=0\n');
  write(path.join(data, 'state/server.lock'), JSON.stringify({
    ...owner(process.pid),
    starttime: processStarttime(process.pid),
  }));

  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(ROOT, 'server/src/startDataHome.ts')], {
    env: {
      PATH: '/usr/bin:/bin',
      HOME: f.home,
      GRIGDESK_HOME: data,
      NODE_ENV: 'test',
    },
    encoding: 'utf8',
    timeout: 22_000,
  });

  assert.equal(result.status, 78, result.stderr);
  assert.match(result.stderr, /уже пользуется сервер/);
  assert.ok(Date.now() - started < 8000, 'Файл задаёт немедленный отказ, без ожидания 15 секунд');
});

test('GB-NEW: старая папка Кокпита не мешает новой установке', (t) => {
  const f = fixture(t);

  fs.mkdirSync(path.join(f.home, '.cockpit'), { recursive: true });

  assert.doesNotThrow(() => checkDataHome(f, fs));
});
