import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyMove, assertSafeContext, backMove, dropLinks, planMove } from '../../tools/moveDataHomeCore.ts';
import type { MoveContext, MoveDeps } from '../../tools/moveDataHomeCore.ts';
import { updateEnvFile } from '../../server/src/lib/envFile.ts';
import { freePort } from './helpers/pluginBootFixture.js';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');

/**
 * Копирует только относительный граф импортов, никогда не ссылки на живое дерево.
 * Каждый дочерний CLI исполняется из временной копии инструмента.
 */
async function copyTool(targetRoot: string): Promise<string> {
  const queue = ['tools/moveDataHome.mts'];
  const seen = new Set<string>();

  while (queue.length) {
    const name = queue.pop()!;

    if (seen.has(name)) {
      continue;
    }

    seen.add(name);

    const source = await fs.readFile(path.join(repositoryRoot, name), 'utf8');
    const target = path.join(targetRoot, name);

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, source);

    const imports = /(?:from\s*|import\s*\(\s*|import\s*)['"](\.[^'"]+)['"]/g;

    for (const match of source.matchAll(imports)) {
      queue.push(path.normalize(path.join(path.dirname(name), match[1]!)));
    }
  }

  await fs.writeFile(path.join(targetRoot, 'package.json'), '{"type":"module"}');

  return path.join(targetRoot, 'tools/moveDataHome.mts');
}

/**
 * Временный домашний каталог, код и папка данных разделены внутри os.tmpdir().
 * Перед созданием файлов корень теста регистрирует собственную очистку.
 */
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-move-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const context: MoveContext = {
    codeRoot: path.join(root, 'code'),
    home: path.join(root, 'data'),
    userHome: path.join(root, 'user'),
    env: {},
  };
  const bin = path.join(root, 'bin');

  await fs.mkdir(context.codeRoot);
  await fs.mkdir(context.userHome);
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\nprintf "active\\n"\n', { mode: 0o755 });

  const entry = await copyTool(context.codeRoot);
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: context.userHome,
    COCKPIT_HOME: context.home,
    XDG_CONFIG_HOME: path.join(context.userHome, '.config'),
    XDG_DATA_HOME: path.join(context.userHome, '.local/share'),
  };

  return {
    root,
    context,
    bin,
    entry,
    env,
  };
}

/**
 * Собирает вывод собственного процесса и ждёт реального завершения.
 * Окружение полностью задано фикстурой, переменные живого сервера не наследуются.
 */
async function runTool(entry: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [entry, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  });
  let output = '';

  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

  const [code] = await once(child, 'exit');

  return { code, output };
}

test('MD-18: неверные аргументы отклоняются до доступа к данным', async (t) => {
  const f = await fixture(t);

  for (const args of [['--unknown'], ['--home', f.context.userHome],
    ['--code-root', '/home/user/code', '--home', '/home/user']]) {
    assert.equal((await runTool(f.entry, args, f.env)).code, 2);
  }

  const options = ['--code-root', f.context.codeRoot, '--home', f.context.userHome];

  assert.equal((await runTool(f.entry, options, { ...f.env, COCKPIT_HOME: 'relative' })).code, 2);
  assert.equal((await runTool(f.entry, options, {
    ...f.env,
    COCKPIT_HOME: path.join(f.context.codeRoot, 'data'),
  })).code, 1);
});

test('MD-19: чистая защита запрещает тесту настоящее дерево', () => {
  const guard = {
    testing: true,
    tempDir: os.tmpdir(),
    repositoryRoot,
  };
  const context: MoveContext = {
    codeRoot: path.join(os.tmpdir(), 'fixture/code'),
    home: path.join(os.tmpdir(), 'fixture/data'),
    userHome: path.join(os.tmpdir(), 'fixture/user'),
    env: {},
  };

  for (const key of ['codeRoot', 'home', 'userHome'] as const) {
    assert.throws(() => assertSafeContext({ ...context, [key]: '/home/user/unsafe' }, guard));
  }

  assert.throws(() => assertSafeContext({ ...context, codeRoot: repositoryRoot }, guard));
  assert.doesNotThrow(() => assertSafeContext(context, guard));
});

test('MD-20: запуск с подменённым HOME не доходит до условий и записи', async (t) => {
  const f = await fixture(t);
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ configured: true, authenticated: false }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address();

  assert.ok(address && typeof address === 'object');

  const before = await fs.readdir(f.context.codeRoot);
  const result = await runTool(f.entry, ['--apply'], { ...f.env, COCKPIT_PORT: String(address.port) });

  assert.equal(result.code, 2, result.output);
  assert.deepEqual(await fs.readdir(f.context.codeRoot), before);
  await assert.rejects(fs.stat(f.context.home), { code: 'ENOENT' });
});

test('MD-21: CLAUDECODE запрещает изменения даже с тестовыми опциями', async (t) => {
  const f = await fixture(t);
  const result = await runTool(f.entry, ['--apply', '--code-root', f.context.codeRoot,
    '--home', f.context.userHome], { ...f.env, CLAUDECODE: '1' });

  assert.equal(result.code, 2, result.output);
  await assert.rejects(fs.stat(f.context.home), { code: 'ENOENT' });
});

/**
 * Подменяются внешние условия, но файловая система остаётся настоящей.
 * Каждый отказ проверяется на снимке своей временной раскладки.
 */
function fakeDeps(overrides: Partial<MoveDeps> = {}): MoveDeps {
  return {
    fs,
    checkRuntime: async () => [],
    updateEnv: updateEnvFile,
    ...overrides,
  };
}

/**
 * Пишет только файлы внутри фикстуры и создаёт их родителей.
 * Содержимое нарочно включает вложенные пути и посторонние значения для проверки границ замены.
 */
async function put(file: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}

/**
 * Создаёт полную старую раскладку, включая данные, которые не должны переезжать.
 * Все ключи искусственные, а пути находятся в os.tmpdir().
 */
async function legacyFixture(t: TestContext) {
  const f = await fixture(t);
  const code = f.context.codeRoot;
  const state = path.join(code, 'server/.state');

  for (const [name, value] of Object.entries({
    '.env': `# комментарий\nCOCKPIT_MEDIA_PYTHON=${state}/media-venv/bin/python\n`
      + `COCKPIT_MEDIA_HF_DIR=${state}/hf\nOTHER_PATH=/opt/x\n`
      + `BOUNDARY=${code}/chats-old/x\nCOCKPIT_SANDBOX_DOWN_CMD=bash ${state}/down.sh\n`,
    'server/.state/cli-token': 'fixture-token',
    'server/.state/prefs.json': JSON.stringify({ path: `${state}/media-venv/bin/python` }),
    'server/.state/media-venv/bin/python': 'fixture-python',
    'server/.state/hf/x': 'model',
    'server/.state/showcase-browser/browser.json': JSON.stringify({ path: `${state}/browser` }),
    'server/.state/sandboxes/t1.json': JSON.stringify({ nested: [`${state}/sandbox`] }),
    '.state/plugins/p/data.json': '{}',
    '.state/ui-releases/abc/index.html': 'release',
    '.state/mobile/cockpit-mobile.apk': 'apk',
    '.state/artifacts/keep.txt': 'keep',
    'chats/.gitignore': '*\n!.gitignore\n',
    'chats/2026-10/a.json': '{}',
    'telegram/.gitignore': '*\n!.gitignore\n',
    'telegram/accounts/x.json': '{}',
    'github/.gitignore': '*\n!.gitignore\n',
    '3d/.gitignore': '*\n!.gitignore\n',
    '3d/m.glb': 'model',
    'agents/.gitignore': '*\n!.gitignore\n',
    'agents/a.md': 'agent',
    'plugins/README.md': 'tracked',
    'plugins/demo/plugin.json': '{}',
    'profiles/demo/profile.sh': 'keep',
  })) {
    await put(path.join(code, name), value);
  }

  await fs.mkdir(path.join(code, 'plugins/.cockpit-install/jobs'), { recursive: true });
  await fs.mkdir(path.join(code, 'server/runtime/deepseek'), { recursive: true });
  await put(path.join(f.context.userHome, '.config/cockpit/mobile/brain-cert.pem'), 'fixture-cert');
  await put(path.join(f.context.userHome, '.config/cockpit/mobile/devices.json'), '{}');
  await put(path.join(f.context.userHome, '.config/cockpit/android-signing/k'), 'keep');
  await fs.chmod(path.join(code, '.env'), 0o640);
  await fs.chmod(state, 0o750);

  return f;
}

/**
 * Снимок учитывает тип, права и байты, не следуя символическим ссылкам.
 * Возврат сравнивается с исходным деревом, а не с ожиданиями алгоритма переноса.
 */
async function snapshot(root: string, base = root): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  for (const name of (await fs.readdir(root)).sort()) {
    const file = path.join(root, name);
    const stat = await fs.lstat(file);
    const relative = path.relative(base, file);

    if (stat.isSymbolicLink()) {
      result[relative] = `link:${await fs.readlink(file)}`;
    } else if (stat.isDirectory()) {
      result[relative] = `dir:${stat.mode & 0o777}`;
      Object.assign(result, await snapshot(file, base));
    } else {
      result[relative] = `${stat.mode & 0o777}:${createHash('sha256')
        .update(await fs.readFile(file)).digest('hex')}`;
    }
  }

  return result;
}

/**
 * Проверяет видимую раскладку и права независимо от внутреннего журнала шагов.
 * Символические ссылки остаются абсолютными мостами для старого окна.
 */
async function assertMoved(context: MoveContext): Promise<void> {
  const { codeRoot, home } = context;

  assert.equal(await fs.readlink(path.join(codeRoot, '.env')), path.join(home, '.env'));
  assert.equal(await fs.readlink(path.join(codeRoot, 'server/.state')), path.join(home, 'state'));

  for (const name of ['chats', 'telegram', '3d', 'agents', 'plugins']) {
    const keep = name === 'plugins' ? 'README.md' : '.gitignore';

    assert.deepEqual(await fs.readdir(path.join(codeRoot, name)), [keep]);
    assert.ok((await fs.stat(path.join(home, name))).isDirectory());
  }

  assert.equal((await fs.stat(home)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(home, 'state'))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(home, '.env'))).mode & 0o777, 0o600);
  assert.ok(JSON.parse(await fs.readFile(path.join(home, '.move-journal.json'), 'utf8')).completed);
  await assert.rejects(fs.lstat(path.join(home, '.move-lock')), { code: 'ENOENT' });

  for (const name of ['state/plugins/p/data.json', 'state/ui-releases/abc/index.html',
    'state/mobile-apk/cockpit-mobile.apk', 'mobile/brain-cert.pem']) {
    assert.ok((await fs.stat(path.join(home, name))).isFile());
  }
}

test('MD-01: план перечисляет перенос и не меняет дерево', async (t) => {
  const f = await legacyFixture(t);
  const before = await snapshot(f.root);
  const plan = await planMove(f.context, fakeDeps());

  assert.equal(plan.code, 0, plan.messages.join('\n'));
  assert.ok(plan.steps.length >= 10);
  assert.deepEqual(await snapshot(f.root), before);
});

test('MD-02: перенос создаёт полную раскладку и ссылки', async (t) => {
  const f = await legacyFixture(t);
  const result = await applyMove(f.context, fakeDeps());

  assert.equal(result.code, 0, result.messages.join('\n'));
  await assertMoved(f.context);
  assert.equal((await applyMove(f.context, fakeDeps())).code, 0);
});

test('MD-03: каждое условие отказывает до изменений', async (t) => {
  for (const id of ['server', 'server-process', 'unit', 'bus', 'window', 'holders', 'update-unit']) {
    const f = await legacyFixture(t);
    const before = await snapshot(f.root);
    const deps = fakeDeps({ checkRuntime: async () => [{
      id,
      ok: false,
      message: id,
    }] });

    assert.equal((await applyMove(f.context, deps)).code, 1, id);
    assert.deepEqual(await snapshot(f.root), before, id);
  }

  for (const [name, value] of [
    ['code/plugins/.cockpit-install/transactions/job.json', '{}'],
    ['code/server/runtime/deepseek/publish-pending.json', '{}'],
    ['code/server/.state/cockpit-update.json', '{"job":{"status":"building"}}'],
    ['code/server/.state/cockpit-update.json.job-lock', '{}'],
    ['data/unrelated', 'keep'],
    ['code/.env', 'MULTILINE="one\ntwo"'],
  ]) {
    const f = await legacyFixture(t);

    await put(path.join(f.root, name!), value!);

    const before = await snapshot(f.root);

    assert.equal((await applyMove(f.context, fakeDeps())).code, 1, name);
    assert.deepEqual(await snapshot(f.root), before, name);
  }

  const f = await legacyFixture(t);
  const before = await snapshot(f.root);
  const differentDisk = new Proxy(fs, {
    get(target, key) {
      if (key === 'stat') {
        return async (...args: Parameters<typeof fs.stat>) => {
          const result = await fs.stat(...args);

          if (String(args[0]).includes('/code/server/.state')) {
            Object.defineProperty(result, 'dev', { value: Number(result.dev) + 1 });
          }

          return result;
        };
      }

      return Reflect.get(target, key);
    },
  });

  assert.equal((await applyMove(f.context, fakeDeps({ fs: differentDisk }))).code, 1);
  assert.deepEqual(await snapshot(f.root), before);
});

test('MD-04: сбой каждого rename допускает повторный перенос', async (t) => {
  const probe = await legacyFixture(t);
  let count = 0;
  const counting = new Proxy(fs, {
    get(target, key) {
      return key === 'rename' ? async (...args: Parameters<typeof fs.rename>) => {
        count += 1;
        await fs.rename(...args);
      } : Reflect.get(target, key);
    },
  });

  assert.equal((await applyMove(probe.context, fakeDeps({ fs: counting }))).code, 0);
  assert.ok(count > 10);

  for (let failure = 1; failure <= count; failure += 1) {
    const f = await legacyFixture(t);
    let index = 0;
    const failing = new Proxy(fs, {
      get(target, key) {
        return key === 'rename' ? async (...args: Parameters<typeof fs.rename>) => {
          index += 1;

          if (index === failure) {
            throw new Error('fixture rename failure');
          }

          await fs.rename(...args);
        } : Reflect.get(target, key);
      },
    });

    assert.equal((await applyMove(f.context, fakeDeps({ fs: failing }))).code, 1, String(failure));

    const result = await applyMove(f.context, fakeDeps());

    assert.equal(result.code, 0, `${failure}: ${result.messages.join('\n')}`);
    await assertMoved(f.context);
  }
});

test('MD-05: сбой после rename до записи журнала допускает apply и back', async (t) => {
  for (const resume of ['apply', 'back']) {
    const f = await legacyFixture(t);
    const before = await snapshot(f.root);
    const deps = fakeDeps({
      checkpoint: async (name) => {
        if (name === 'rename:state') {
          throw new Error('fixture journal failure');
        }
      },
    });

    assert.equal((await applyMove(f.context, deps)).code, 1);

    if (resume === 'apply') {
      assert.equal((await applyMove(f.context, fakeDeps())).code, 0);
      await assertMoved(f.context);
    } else {
      const result = await backMove(f.context, fakeDeps());

      assert.equal(result.code, 0, result.messages.join('\n'));
      assert.deepEqual(await snapshot(f.root), before);
    }
  }
});

test('MD-06: возврат восстанавливает все байты и права', async (t) => {
  const f = await legacyFixture(t);
  const before = await snapshot(f.root);

  assert.equal((await applyMove(f.context, fakeDeps())).code, 0);

  const result = await backMove(f.context, fakeDeps());

  assert.equal(result.code, 0, result.messages.join('\n'));
  assert.deepEqual(await snapshot(f.root), before);
});

test('MD-07: возврат незавершённого переноса', async (t) => {
  const f = await legacyFixture(t);
  const before = await snapshot(f.root);

  assert.equal((await applyMove(f.context, fakeDeps({
    checkpoint: async (name) => {
      if (name === 'rename:chats') {
        throw new Error('fixture interrupt');
      }
    },
  }))).code, 1);

  const result = await backMove(f.context, fakeDeps());

  assert.equal(result.code, 0, result.messages.join('\n'));
  assert.deepEqual(await snapshot(f.root), before);
});

test('MD-08: возврат сохраняет новые данные и исходную заглушку', async (t) => {
  const f = await legacyFixture(t);
  const { home, codeRoot, userHome } = f.context;

  assert.equal((await applyMove(f.context, fakeDeps())).code, 0);
  await fs.appendFile(path.join(home, '.env'), `NEW_PATH=${home}/chats/new.json\n`);

  for (const name of ['chats/new.json', 'state/plugins/q/data.json', 'mobile/new.json']) {
    await put(path.join(home, name), 'new');
  }

  await put(path.join(home, 'chats/.gitignore'), 'storage-generated');

  const result = await backMove(f.context, fakeDeps());

  assert.equal(result.code, 0, result.messages.join('\n'));
  assert.equal(await fs.readFile(path.join(codeRoot, 'chats/.gitignore'), 'utf8'), '*\n!.gitignore\n');
  assert.equal(await fs.readFile(path.join(codeRoot, 'chats/new.json'), 'utf8'), 'new');
  assert.equal(await fs.readFile(path.join(codeRoot, '.state/plugins/q/data.json'), 'utf8'), 'new');
  assert.equal(await fs.readFile(path.join(userHome, '.config/cockpit/mobile/new.json'), 'utf8'), 'new');

  const env = await fs.readFile(path.join(codeRoot, '.env'), 'utf8');

  assert.ok(env.includes(`NEW_PATH=${codeRoot}/chats/new.json`));
  assert.doesNotMatch(env, /^COCKPIT_(?:LOG|UI_RELEASES_DIR)=/m);
  assert.ok(result.messages.some((message) => message.includes('env.before-move')));
});

test('MD-09: занятое старое место останавливает возврат до rename', async (t) => {
  const f = await legacyFixture(t);

  assert.equal((await applyMove(f.context, fakeDeps())).code, 0);
  await put(path.join(f.context.codeRoot, 'chats/conflict'), 'keep');

  const before = await snapshot(f.root);

  assert.equal((await backMove(f.context, fakeDeps())).code, 1);
  assert.deepEqual(await snapshot(f.root), before);
});

test('MD-10: уборка ссылок проверяет юнит, JSON, настоящие файлы, .env и сборку окна', async (t) => {
  for (const block of ['none', 'file', 'unit', 'json', 'env', 'window', 'window-new']) {
    const f = await legacyFixture(t);
    const desktop = path.join(f.context.userHome, '.local/share/cockpit/desktop');

    assert.equal((await applyMove(f.context, fakeDeps())).code, 0);

    // Встроенный старый путь в команде владелец правит сам; без правки уборка отказывает.
    if (block !== 'env') {
      const envFile = path.join(f.context.home, '.env');
      const text = await fs.readFile(envFile, 'utf8');

      await fs.writeFile(envFile, text.replace(/^COCKPIT_SANDBOX_DOWN_CMD=.*\n/m, ''));
    }

    if (block === 'window' || block === 'window-new') {
      await put(path.join(desktop, 'cockpit-desktop.AppImage'), 'app');
    }

    if (block === 'window-new') {
      await put(path.join(desktop, 'data-home'), '');
    }

    if (block === 'file') {
      await fs.unlink(path.join(f.context.codeRoot, '.env'));
      await put(path.join(f.context.codeRoot, '.env'), 'keep');
    } else if (block === 'unit') {
      await put(path.join(f.context.userHome, '.config/systemd/user/cockpit-server.service'),
        `EnvironmentFile=-${f.context.codeRoot}/.env`);
    } else if (block === 'json') {
      await put(path.join(f.context.home, 'state/prefs.json'),
        JSON.stringify({ path: `${f.context.codeRoot}/server/.state/x` }));
    }

    const before = await snapshot(f.root);
    const result = await dropLinks(f.context, fakeDeps());

    const allowed = ['none', 'window-new'].includes(block);

    assert.equal(result.code, allowed ? 0 : 1, result.messages.join('\n'));

    if (!allowed) {
      assert.deepEqual(await snapshot(f.root), before);
    } else {
      await assert.rejects(fs.lstat(path.join(f.context.codeRoot, '.env')), { code: 'ENOENT' });
      await assert.rejects(fs.lstat(path.join(f.context.codeRoot, 'server/.state')), { code: 'ENOENT' });
    }
  }
});

test('MD-11: чистая копия получает только пустую папку', async (t) => {
  const f = await fixture(t);

  await put(path.join(f.context.codeRoot, 'chats/.gitignore'), 'tracked');
  assert.deepEqual((await planMove(f.context, fakeDeps())).steps, []);
  assert.equal((await applyMove(f.context, fakeDeps())).code, 0);
  assert.deepEqual(await fs.readdir(f.context.home), []);
  assert.equal((await applyMove(f.context, fakeDeps())).code, 0);
});

test('MD-12: следы запуска вливаются без потери старых версий', async (t) => {
  const f = await legacyFixture(t);

  await put(path.join(f.context.home, 'state/cockpit-server.log'), 'boot-log');
  await put(path.join(f.context.home, 'state/ui-releases/abc/x'), 'duplicate');
  await put(path.join(f.context.home, 'state/mobile-apk/cockpit-mobile.apk'), 'new-apk');

  const result = await applyMove(f.context, fakeDeps());

  assert.equal(result.code, 0, result.messages.join('\n'));
  assert.equal(await fs.readFile(path.join(f.context.home, 'state/cockpit-server.log.pre-move'), 'utf8'),
    'boot-log');
  assert.equal(await fs.readFile(path.join(f.context.home, 'state/mobile-apk/cockpit-mobile.apk.pre-move'),
    'utf8'), 'new-apk');
  await assertMoved(f.context);
});

test('MD-13: отсутствие старого state не мешает вложенным данным', async (t) => {
  const f = await legacyFixture(t);

  await fs.rm(path.join(f.context.codeRoot, 'server/.state'), { recursive: true });

  const result = await applyMove(f.context, fakeDeps());

  assert.equal(result.code, 0, result.messages.join('\n'));
  assert.equal(await fs.readFile(path.join(f.context.home, 'state/plugins/p/data.json'), 'utf8'), '{}');
});

test('MD-13: данные без старого env получают настройки совместимости и возвращаются', async (t) => {
  const f = await legacyFixture(t);

  await fs.unlink(path.join(f.context.codeRoot, '.env'));

  const before = await snapshot(f.root);

  assert.equal((await applyMove(f.context, fakeDeps())).code, 0);
  assert.ok((await fs.stat(path.join(f.context.home, '.env')).catch(() => null))?.isFile(),
    'Перенос должен создать файл настроек совместимости');
  assert.ok((await fs.readFile(path.join(f.context.home, '.env'), 'utf8')).includes('COCKPIT_LOG='));
  assert.equal((await backMove(f.context, fakeDeps())).code, 0);
  assert.deepEqual(await snapshot(f.root), before);
});

test('MD-14: замена путей сохраняет соседние строки и отвергает дубли', async (t) => {
  const f = await legacyFixture(t);

  assert.equal((await applyMove(f.context, fakeDeps())).code, 0);

  const env = await fs.readFile(path.join(f.context.home, '.env'), 'utf8');

  assert.ok(env.includes(`COCKPIT_MEDIA_PYTHON=${f.context.home}/state/media-venv/bin/python`));
  assert.ok(env.includes(`BOUNDARY=${f.context.codeRoot}/chats-old/x`));
  assert.ok(env.includes('# комментарий\n'));
  assert.ok(env.includes('OTHER_PATH=/opt/x\n'));
  assert.ok(env.includes(`COCKPIT_SANDBOX_DOWN_CMD=bash ${f.context.codeRoot}/server/.state/down.sh`));

  const other = await legacyFixture(t);

  await fs.appendFile(path.join(other.context.codeRoot, '.env'),
    `COCKPIT_MEDIA_HF_DIR=${other.context.codeRoot}/server/.state/hf\n`);

  const before = await snapshot(other.root);

  assert.equal((await planMove(other.context, fakeDeps())).code, 1);
  assert.deepEqual(await snapshot(other.root), before);
});

test('MD-15: вывод содержит только имена ключей, без значений', async (t) => {
  const f = await legacyFixture(t);
  const result = await applyMove(f.context, fakeDeps());
  const output = result.messages.join('\n');

  assert.equal(result.code, 0);
  assert.match(output, /COCKPIT_MEDIA_PYTHON/);
  assert.match(output, /COCKPIT_SANDBOX_DOWN_CMD/);
  assert.ok(!output.includes(`${f.context.home}/state/media-venv/bin/python`));
});

test('MD-16: известные JSON переписываются в обе стороны', async (t) => {
  const f = await legacyFixture(t);

  assert.equal((await applyMove(f.context, fakeDeps())).code, 0);

  for (const name of ['prefs.json', 'showcase-browser/browser.json', 'sandboxes/t1.json']) {
    const content = await fs.readFile(path.join(f.context.home, 'state', name), 'utf8');

    assert.ok(content.includes(`${f.context.home}/state`));
    assert.ok(!content.includes(`${f.context.codeRoot}/server/.state`));
  }

  assert.equal((await backMove(f.context, fakeDeps())).code, 0);
});

test('MD-17: потенциально висячие ссылки названы в плане', async (t) => {
  const f = await legacyFixture(t);

  await fs.symlink('../outside', path.join(f.context.codeRoot, 'chats/relative'));
  await fs.symlink(path.join(f.context.codeRoot, 'agents/a.md'),
    path.join(f.context.codeRoot, 'chats/absolute'));

  const plan = await planMove(f.context, fakeDeps());

  assert.ok(plan.warnings.some((message) => message.includes('relative')));
  assert.ok(plan.warnings.some((message) => message.includes('absolute')));
  assert.equal((await applyMove(f.context, fakeDeps())).code, 0);
});

test('MD-22: копия CLI выполняет план и перенос с настоящими проверками', async (t) => {
  const f = await legacyFixture(t);

  await put(path.join(f.bin, 'systemctl'), '#!/bin/sh\nprintf "inactive\\n"\nexit 3\n');
  await fs.chmod(path.join(f.bin, 'systemctl'), 0o755);

  const env = { ...f.env, COCKPIT_PORT: String(await freePort()) };
  const args = ['--code-root', f.context.codeRoot, '--home', f.context.userHome];

  assert.equal((await runTool(f.entry, args, env)).code, 0);

  const result = await runTool(f.entry, ['--apply', ...args], env);

  assert.equal(result.code, 0, result.output);
  await assertMoved(f.context);
});

test('MD-23: живой замок не допускает второй перенос', async (t) => {
  const f = await legacyFixture(t);
  const stat = await fs.readFile('/proc/self/stat', 'utf8');
  const starttime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];

  await put(path.join(f.context.home, '.move-lock'), JSON.stringify({ pid: process.pid, starttime }));

  const before = await snapshot(f.root);

  assert.equal((await applyMove(f.context, fakeDeps())).code, 1);
  assert.deepEqual(await snapshot(f.root), before);
});

test('MD-24: копия .env от прошлого возврата останавливает план', async (t) => {
  const f = await legacyFixture(t);

  await put(path.join(f.context.codeRoot, 'server/.state/env.before-move'), 'old-copy');

  const before = await snapshot(f.root);
  const plan = await planMove(f.context, fakeDeps());

  assert.equal(plan.code, 1);
  assert.match(plan.messages.join('\n'), /env\.before-move/);
  assert.equal((await applyMove(f.context, fakeDeps())).code, 1);
  assert.deepEqual(await snapshot(f.root), before);
});

test('MD-25: обновление в restarting без живого воркера не держит перенос', async (t) => {
  for (const [workerPid, expected] of [[2 ** 22 + 7, 0], [process.pid, 1]] as const) {
    const f = await legacyFixture(t);

    await put(path.join(f.context.codeRoot, 'server/.state/cockpit-update.json'),
      JSON.stringify({ job: { status: 'restarting', workerPid } }));

    assert.equal((await planMove(f.context, fakeDeps())).code, expected, String(workerPid));
  }
});

test('MD-26: после завершённого переноса остатки в коде называются, а не переносятся', async (t) => {
  const f = await legacyFixture(t);

  assert.equal((await applyMove(f.context, fakeDeps())).code, 0);

  const clean = await applyMove(f.context, fakeDeps());

  assert.equal(clean.code, 0);
  assert.match(clean.messages.join('\n'), /Перенос завершён/);

  await put(path.join(f.context.codeRoot, 'plugins/dev-plugin/plugin.json'), '{}');

  const again = await applyMove(f.context, fakeDeps());
  const plan = await planMove(f.context, fakeDeps());

  assert.equal(again.code, 1);
  assert.match(again.messages.join('\n'), /plugins.*вручную/);
  assert.equal(plan.code, 1);
  await fs.access(path.join(f.context.codeRoot, 'plugins/dev-plugin/plugin.json'));
});

test('MD-27: битый JSON называется по имени файла без его содержимого', async (t) => {
  const f = await legacyFixture(t);

  await put(path.join(f.context.codeRoot, 'server/.state/prefs.json'), '{"secret-value-123": oops');

  const plan = await planMove(f.context, fakeDeps());
  const text = plan.messages.join('\n');

  assert.equal(plan.code, 1);
  assert.match(text, /prefs\.json/);
  assert.doesNotMatch(text, /secret-value-123/);
});

test('MD-28: файл настроек с жёсткой ссылкой останавливает план до переноса', async (t) => {
  const f = await legacyFixture(t);

  await fs.link(path.join(f.context.codeRoot, '.env'), path.join(f.context.userHome, 'env-copy'));

  const before = await snapshot(f.root);
  const plan = await planMove(f.context, fakeDeps());

  assert.equal(plan.code, 1);
  assert.match(plan.messages.join('\n'), /жёсткие ссылки/);
  assert.equal((await applyMove(f.context, fakeDeps())).code, 1);
  assert.deepEqual(await snapshot(f.root), before);
});
