import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyBrandMove, backBrandMove, dropBrandLinks, planBrandMove } from '../../tools/brandMoveCore.ts';
import type { BrandContext, BrandDeps } from '../../tools/brandMoveCore.ts';
import { rewriteJson } from '../../tools/rewriteJson.ts';
import { parseBrandRequest } from '../../tools/brandMove.mts';
import { renameEnvKeys } from '../../server/src/lib/envFile.ts';
import { LEGACY, LEGACY_DATA_PATHS } from '../../shared/runtime/legacyBrand.ts';
import { freePort } from './helpers/pluginBootFixture.js';

const deps: BrandDeps = { fs, checkRuntime: async () => [] };

/**
 * Копирует относительный граф импортов команды в отдельное дерево фикстуры.
 * Дочерний процесс не выполняет точку входа из настоящего checkout.
 */
function copyTool(targetRoot: string): string {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const queue = ['tools/brandMove.mts'];
  const seen = new Set<string>();

  while (queue.length) {
    const name = queue.pop()!;

    if (seen.has(name)) {
      continue;
    }

    seen.add(name);

    const source = fs.readFileSync(path.join(root, name), 'utf8');
    const target = path.join(targetRoot, name);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);

    for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
      queue.push(path.normalize(path.join(path.dirname(name), match[1]!)));
    }
  }

  fs.writeFileSync(path.join(targetRoot, 'package.json'), '{"type":"module"}');

  return path.join(targetRoot, 'tools/brandMove.mts');
}

/**
 * Создаёт только искусственные данные внутри временной папки теста.
 * Все ссылки остаются внутри неё, очистка зарегистрирована до заполнения.
 */
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grigdesk-brand-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const context: BrandContext = {
    codeRoot: path.join(root, 'code'),
    userHome: path.join(root, 'user'),
    env: {},
  };
  const home = path.join(context.userHome, '.grigdesk');
  const oldHome = path.join(context.userHome, LEGACY.dataHomeDir);
  const put = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: 0o640 });
  };

  fs.mkdirSync(path.join(context.codeRoot, 'server'), { recursive: true });

  for (const [oldName] of LEGACY_DATA_PATHS.slice(0, 2)) {
    put(path.join(home, oldName), 'fixture');
  }

  put(path.join(home, `${LEGACY_DATA_PATHS[0][0]}.1`), 'rotated');
  put(path.join(home, LEGACY_DATA_PATHS[2][0], 'receipts/p.json'), '{}');
  put(path.join(home, 'plugins/p/plugin.json'), JSON.stringify({ dir: `${oldHome}/plugins/p` }));
  put(path.join(home, '.env'), '# заметка\r\n'
    + `  export ${LEGACY.envPrefix}PORT = "8140" # порт\r\n`
    + `${LEGACY.envPrefix}LOG=${oldHome}/${LEGACY_DATA_PATHS[0][0]}\r\n`
    + `${LEGACY.envPrefix}UI_RELEASES_DIR=${oldHome}/state/ui-releases\r\n`
    + `${LEGACY.envPrefix}MEDIA_DIR='${oldHome}/state/media' # медиа\r\n`
    + `${LEGACY.envPrefix}S2_TOKEN=plugin-secret\r\n`
    + `${LEGACY.envPrefix}DEAD_KEY=kept\r\n`);

  for (const file of ['prefs.json', 'showcase-browser/browser.json', 'sandboxes/t1.json']) {
    put(path.join(home, 'state', file), JSON.stringify({
      pluginSettings: { p: { directory: `${oldHome}/state/work` } },
      unrelated: '/opt/other',
    }, null, 2) + '\n');
  }

  put(path.join(home, '.move-journal.json'), '{"finished":true}');
  put(path.join(context.userHome, '.config', LEGACY.configDir, 'mobile/key'), 'fixture-key');
  fs.symlinkSync(home, oldHome);
  fs.symlinkSync(path.join(oldHome, '.env'), path.join(context.codeRoot, '.env'));
  fs.symlinkSync(path.join(oldHome, 'state'), path.join(context.codeRoot, 'server/.state'));

  return {
    root,
    context,
    home,
    oldHome,
    put,
  };
}

/**
 * Снимок сравнивает байты, права и ссылки, не переходя по ссылкам.
 * Он ловит побочные записи даже у команд, которые только обещают составить план.
 */
function snapshot(root: string, base = root): Record<string, string> {
  const result: Record<string, string> = {};

  for (const name of fs.readdirSync(root).sort()) {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    const relative = path.relative(base, file);

    if (stat.isSymbolicLink()) {
      result[relative] = `link:${fs.readlinkSync(file)}`;
    } else if (stat.isDirectory()) {
      result[relative] = `dir:${stat.mode & 0o777}`;
      Object.assign(result, snapshot(file, base));
    } else {
      result[relative] = `${stat.mode & 0o777}:${createHash('sha256')
        .update(fs.readFileSync(file)).digest('hex')}`;
    }
  }

  return result;
}

/**
 * Проверяет итог независимо от внутренней структуры журнала миграции.
 * Содержимое плагина и старый журнал должны оставаться побайтно прежними.
 */
function assertMoved(f: ReturnType<typeof fixture>): void {
  for (const [oldName, newName] of LEGACY_DATA_PATHS) {
    assert.equal(fs.existsSync(path.join(f.home, oldName)), false, oldName);
    assert.equal(fs.existsSync(path.join(f.home, newName)), true, newName);
  }

  assert.equal(fs.readFileSync(path.join(f.home, 'state/grigdesk-server.log.1'), 'utf8'), 'rotated');

  const env = fs.readFileSync(path.join(f.home, '.env'), 'utf8');

  assert.ok(env.startsWith('# заметка\r\n  export GRIGDESK_PORT = "8140" # порт\r\n'));
  assert.ok(env.includes(`GRIGDESK_MEDIA_DIR='${f.home}/state/media' # медиа\r\n`));
  assert.ok(env.includes(`${LEGACY.envPrefix}S2_TOKEN=plugin-secret\r\n`));
  assert.ok(env.includes(`${LEGACY.envPrefix}DEAD_KEY=kept\r\n`));
  assert.doesNotMatch(env, /^GRIGDESK_(LOG|UI_RELEASES_DIR)=/m);
  assert.equal(fs.statSync(path.join(f.home, '.env')).mode & 0o777, 0o640);
  assert.equal(fs.statSync(path.join(f.home, 'state/brand-move-backup/.env')).mode & 0o777, 0o600);

  for (const file of ['prefs.json', 'showcase-browser/browser.json', 'sandboxes/t1.json']) {
    const value = JSON.parse(fs.readFileSync(path.join(f.home, 'state', file), 'utf8'));

    assert.equal(value.pluginSettings.p.directory, `${f.home}/state/work`);
  }

  assert.equal(fs.readlinkSync(path.join(f.context.codeRoot, '.env')), `${f.home}/.env`);
  assert.equal(fs.readlinkSync(path.join(f.context.codeRoot, 'server/.state')), `${f.home}/state`);
  assert.equal(fs.readlinkSync(f.oldHome), f.home);
  assert.equal(fs.readFileSync(path.join(f.home, '.move-journal.json'), 'utf8'), '{"finished":true}');
  assert.equal(fs.readFileSync(path.join(f.context.userHome, '.config/grigdesk/mobile/key'), 'utf8'),
    'fixture-key');
}

test('GM-01: план называет пять действий и ничего не пишет', async (t) => {
  const f = fixture(t);
  const before = snapshot(f.root);
  const plan = await planBrandMove(f.context, deps);

  assert.equal(plan.code, 0, plan.messages.join('\n'));
  assert.equal(plan.actions.length, 5);
  assert.deepEqual(snapshot(f.root), before);
});

test('GM-02: перенос сохраняет права, комментарии, плагины и копии до изменений', async (t) => {
  const f = fixture(t);
  const pluginBefore = fs.readFileSync(path.join(f.home, 'plugins/p/plugin.json'));
  const result = await applyBrandMove(f.context, deps);

  assert.equal(result.code, 0, result.messages.join('\n'));
  assertMoved(f);
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'plugins/p/plugin.json')), pluginBefore);
  assert.doesNotMatch(result.messages.join('\n'), /plugin-secret/);
});

test('GM-03: прерывание каждого действия допускает продолжение и повтор без записи', async (t) => {
  const probe = fixture(t);
  const points: string[] = [];

  assert.equal((await applyBrandMove(probe.context, {
    ...deps,
    checkpoint: async (name) => {
      points.push(name);
    },
  })).code, 0);
  assert.ok(points.length >= 5);

  for (const point of points) {
    const f = fixture(t);
    const failed = await applyBrandMove(f.context, {
      ...deps,
      checkpoint: async (name) => {
        if (name === point) {
          throw new Error('fixture interruption');
        }
      },
    });

    assert.equal(failed.code, 1, point);
    assert.equal((await applyBrandMove(f.context, deps)).code, 0, point);
    assertMoved(f);

    const before = snapshot(f.root);

    assert.equal((await applyBrandMove(f.context, deps)).code, 0);
    assert.deepEqual(snapshot(f.root), before);
  }
});

test('GM-04: полный и частичный откат возвращают дерево, чужие изменения защищены', async (t) => {
  for (const partial of [false, true]) {
    const f = fixture(t);
    const before = snapshot(f.root);

    await applyBrandMove(f.context, {
      ...deps,
      checkpoint: async () => {
        if (partial) {
          throw new Error('fixture interruption');
        }
      },
    });

    const result = await backBrandMove(f.context, deps);

    assert.equal(result.code, 0, result.messages.join('\n'));
    assert.deepEqual(snapshot(f.root), before);
  }

  const f = fixture(t);

  await applyBrandMove(f.context, deps);
  fs.appendFileSync(path.join(f.home, '.env'), 'USER_EDIT=yes\n');

  const before = snapshot(f.root);
  const result = await backBrandMove(f.context, deps);

  assert.equal(result.code, 1);
  assert.match(result.messages.join('\n'), /\.env/);
  assert.deepEqual(snapshot(f.root), before);
});

test('GM-05: опасные условия отказывают до изменений', async (t) => {
  for (const blocker of ['step0', 'port', 'profile', 'transaction', 'config', 'agent', 'lock']) {
    const f = fixture(t);

    if (blocker === 'step0') {
      fs.unlinkSync(f.oldHome);
    } else if (blocker === 'profile') {
      const profile = path.join(f.context.userHome, '.config', LEGACY.profileDir);

      fs.mkdirSync(profile, { recursive: true });
      fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(profile, 'SingletonLock'));
    } else if (blocker === 'transaction') {
      f.put(path.join(f.home, LEGACY_DATA_PATHS[2][0], 'transactions/job.json'), '{}');
    } else if (blocker === 'config') {
      f.put(path.join(f.context.userHome, '.config/grigdesk/conflict'), 'keep');
    } else if (blocker === 'agent') {
      f.context.env = { CLAUDECODE: '1' };
    } else if (blocker === 'lock') {
      const stat = fs.readFileSync('/proc/self/stat', 'utf8');
      const starttime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];

      f.put(path.join(f.home, 'state/server.lock'), JSON.stringify({
        pid: process.pid,
        starttime,
        root: f.context.codeRoot,
      }));
    }

    const before = snapshot(f.root);
    const result = await applyBrandMove(f.context, {
      ...deps,
      checkRuntime: async () => blocker === 'port'
        ? [{
          id: 'server',
          ok: false,
          message: 'Порт отвечает.',
        }] : [],
    });

    assert.equal(result.code, 1, blocker);
    assert.deepEqual(snapshot(f.root), before, blocker);
  }
});

test('GM-06: разные значения форм ключа запрещены, одинаковые убирают старую строку', () => {
  const old = `${LEGACY.envPrefix}PORT`;
  const names = { [old]: 'GRIGDESK_PORT' };

  assert.throws(() => renameEnvKeys(Buffer.from(`${old}=1\nGRIGDESK_PORT=2\n`), names), /PORT/);
  assert.equal(renameEnvKeys(Buffer.from(`# keep\n${old}=1\nGRIGDESK_PORT=1\n`), names),
    '# keep\nGRIGDESK_PORT=1\n');
});

test('GM-07: совпадения в плагинах перечислены без правки содержимого', async (t) => {
  const f = fixture(t);
  const before = snapshot(path.join(f.home, 'plugins/p'));
  const plan = await planBrandMove(f.context, deps);

  assert.ok(plan.kept.some((line) => line.includes('plugins/p/plugin.json')));
  assert.ok(plan.kept.some((line) => line.includes(`${LEGACY.envPrefix}S2_TOKEN`)));
  assert.equal((await applyBrandMove(f.context, deps)).code, 0);
  assert.deepEqual(snapshot(path.join(f.home, 'plugins/p')), before);
});

test('GM-08: уборка удаляет только наши ссылки кода и сохраняет старую домашнюю ссылку', async (t) => {
  const f = fixture(t);

  await applyBrandMove(f.context, deps);
  fs.unlinkSync(path.join(f.context.codeRoot, '.env'));
  f.put(path.join(f.context.codeRoot, '.env'), 'ours=no\n');
  assert.equal((await dropBrandLinks(f.context, deps)).code, 0);
  assert.equal(fs.readFileSync(path.join(f.context.codeRoot, '.env'), 'utf8'), 'ours=no\n');
  assert.equal(fs.existsSync(path.join(f.context.codeRoot, 'server/.state')), false);
  assert.equal(fs.readlinkSync(f.oldHome), f.home);
});

test('GM-09: тест вне временной папки отказывает до первого чтения файлов', async () => {
  let reads = 0;
  const denied = new Proxy(fs, {
    get() {
      reads += 1;

      throw new Error('unexpected fs access');
    },
  });
  const context: BrandContext = {
    codeRoot: '/home/user/code',
    userHome: '/home/user',
    env: {},
  };
  const result = await planBrandMove(context, { ...deps, fs: denied });

  assert.equal(result.code, 1);
  assert.equal(reads, 0);
  assert.throws(() => parseBrandRequest([
    '--code-root', '/home/user/code', '--home', '/home/user',
  ], {}), /os.tmpdir/);
  assert.throws(() => parseBrandRequest([
    '--code-root', '/tmp/unused', '--home', '/home/user',
  ], {}), /os.tmpdir/);
});

test('GM-04: повреждённая резервная копия останавливает весь откат до изменений', async (t) => {
  const f = fixture(t);

  assert.equal((await applyBrandMove(f.context, deps)).code, 0);
  fs.appendFileSync(path.join(f.home, 'state/brand-move-backup/.env'), 'CORRUPTED=yes\n');

  const before = snapshot(f.root);
  const result = await backBrandMove(f.context, deps);

  assert.equal(result.code, 1);
  assert.match(result.messages.join('\n'), /копия.*\.env/);
  assert.deepEqual(snapshot(f.root), before);
});

test('GM-05: ссылка в данных не расширяет область переноса', async (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  const prefs = path.join(f.home, 'state/prefs.json');

  f.put(path.join(outside, 'prefs.json'), '{}');
  fs.unlinkSync(prefs);
  fs.symlinkSync(path.join(outside, 'prefs.json'), prefs);

  const before = snapshot(f.root);

  assert.equal((await applyBrandMove(f.context, deps)).code, 1);
  assert.deepEqual(snapshot(f.root), before);
});

test('GM-10: вынесенная замена JSON сохраняет формат, ключи, границы и обратный ход', () => {
  const entries = [
    { source: '/old/state', target: '/new/state' },
    { source: '/old/state/plugins', target: '/new/plugins' },
  ];
  const source = '{ "/old/state": ["/old/state/a", "/old/state/plugins/p", "/old/state-other"] }\n';
  const result = rewriteJson(Buffer.from(source), entries, false);

  assert.equal(result.count, 2);
  assert.equal(result.text,
    '{ "/old/state": ["/new/state/a", "/new/plugins/p", "/old/state-other"] }\n');
  assert.equal(rewriteJson(Buffer.from(result.text), entries, true).text, source);
  assert.throws(() => rewriteJson(Buffer.from('{bad'), entries, false), /JSON/);
});

test('GM-CLI: копия команды выполняет план, перенос и откат на временной раскладке', async (t) => {
  const f = fixture(t);
  const entry = copyTool(f.context.codeRoot);
  const bin = path.join(f.root, 'bin');

  f.put(path.join(bin, 'systemctl'), '#!/bin/sh\nprintf "inactive\\n"\nexit 3\n');
  fs.chmodSync(path.join(bin, 'systemctl'), 0o755);

  const env = {
    HOME: f.context.userHome,
    PATH: `${bin}:/usr/bin:/bin`,
    GRIGDESK_PORT: String(await freePort()),
    XDG_CONFIG_HOME: path.join(f.context.userHome, '.config'),
  };
  const before = snapshot(f.root);

  for (const mode of ['', '--apply', '--back']) {
    const args = [entry, ...mode ? [mode] : [], '--code-root', f.context.codeRoot,
      '--home', f.context.userHome];
    const result = spawnSync(process.execPath, args, {
      env,
      encoding: 'utf8',
      timeout: 30000,
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);

    if (mode === '--apply') {
      assertMoved(f);
    } else {
      assert.deepEqual(snapshot(f.root), before);
    }
  }
});
