import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { parseRuntimeDescriptor } from '../../shared/desktop/desktopRuntime.ts';
import { loadServerRuntime, runtimeDependencies } from '../../desktop/src/runtimeConfig.ts';
import { recoverRuntimeSelection, selectSeaServer } from '../../server/src/lib/selectSeaServer.ts';
import { acquireDirectoryLock } from '../../shared/node/directoryLock.ts';
import { processStarttime } from '../../server/src/lib/dataHomeBoot.ts';
import { verifyServerBinary } from '../../shared/node/serverBinaryRuntime.ts';

const execute = promisify(execFile);

test('PB-SELECT-01: пустой XDG принимает portable ELF без marker и previous', async (t) => {
  const fixture = await binaryFixture(t);
  const directory = path.dirname(fixture.runtimePath);

  await fs.rm(directory, { recursive: true });
  await selectSeaServer({
    root: fixture.binary,
    env: fixture.env,
    home: fixture.home,
    windowVersion: 4,
    expectedPrevious: null,
    verifyBinary: async () => {},
  });

  const selected = JSON.parse(await fs.readFile(fixture.runtimePath, 'utf8'));

  assert.deepEqual(selected, {
    version: 4,
    kind: 'binary',
    binary: fixture.binary,
    home: path.join(fixture.home, '.grigdesk'),
    cliPaths: [],
  });
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(fixture.runtimePath)).mode & 0o777, 0o600);
  await assert.rejects(fs.stat(`${fixture.runtimePath}.previous`), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(directory, 'runtime-version')), { code: 'ENOENT' });
});

test('PB-SELECT-02: verify failure, CAS race и abort не публикуют выбор', async (t) => {
  for (const initial of [false, true]) {
    for (const failure of ['verify', 'race', 'abort']) {
      await t.test(`${initial ? 'initial' : 'saved'}: ${failure}`, async (t) => {
        const fixture = await binaryFixture(t);
        const previous = initial ? null : await fs.readFile(fixture.runtimePath, 'utf8');
        const foreign = JSON.stringify({ ...fixture.descriptor, cliPaths: [] }) + '\n';
        const controller = new AbortController();
        let verified = false;

        if (initial) {
          await fs.rm(path.dirname(fixture.runtimePath), { recursive: true });
        }

        await assert.rejects(selectSeaServer({
          root: fixture.binary,
          env: fixture.env,
          home: fixture.home,
          windowVersion: 4,
          expectedPrevious: previous,
          signal: controller.signal,
          verifyBinary: async () => {
            verified = true;

            if (failure === 'verify') {
              throw new Error('Отказ проверки тестового ELF');
            }

            if (failure === 'race') {
              await fs.writeFile(fixture.runtimePath, foreign);
            }

            if (failure === 'abort') {
              controller.abort();
            }
          },
        }));
        assert.equal(verified, true, 'отказ должен наступить после входа в нужную проверку');

        if (failure === 'race') {
          assert.equal(await fs.readFile(fixture.runtimePath, 'utf8'), foreign);
        } else if (initial) {
          await assert.rejects(fs.stat(fixture.runtimePath), { code: 'ENOENT' });
        } else {
          assert.equal(await fs.readFile(fixture.runtimePath, 'utf8'), previous);
        }

        await assert.rejects(fs.stat(`${fixture.runtimePath}.previous`), { code: 'ENOENT' });
      });
    }
  }

  await t.test('signal доходит до фонового probe/verify', async (t) => {
    const fixture = await binaryFixture(t);
    const controller = new AbortController();
    let forwarded;
    const checking = verifyServerBinary(fixture.binary, {
      home: fixture.data,
      signal: controller.signal,
      run: async (_binary, _args, options) => {
        forwarded = options.signal;

        if (!options.signal) {
          return { stdout: JSON.stringify({
            ok: true,
            verified: true,
            packageId: 'a'.repeat(64),
            elfSha256: 'b'.repeat(64),
            runtime: {
              node: '24.21.0',
              abi: '137',
              platform: 'linux',
              arch: 'x64',
            },
            filesVerified: 1,
            nativeBindingsVerified: 2,
          }) };
        }

        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('Проверка отменена'), { name: 'AbortError' }));
          }, { once: true });
        });
      },
    });

    controller.abort();
    await assert.rejects(checking, { name: 'AbortError' });
    assert.equal(forwarded, controller.signal);
  });
});

test('PB-SELECT-03: journal без прежнего primary восстанавливает обе стороны commit', async (t) => {
  for (const committed of [false, true]) {
    await t.test(committed ? 'после primary' : 'до primary', async (t) => {
      const fixture = await binaryFixture(t);
      const next = await fs.readFile(fixture.runtimePath, 'utf8');
      const journal = {
        format: 1,
        token: '12345678-1234-4234-8234-123456789abc',
        previous: null,
        next,
        backup: 'прежняя резервная копия',
      };

      if (!committed) {
        await fs.rm(fixture.runtimePath);
      }

      await fs.writeFile(`${fixture.runtimePath}.previous`, journal.backup);
      await fs.writeFile(`${fixture.runtimePath}.transaction`, JSON.stringify(journal), { mode: 0o600 });
      await recoverRuntimeSelection(fixture.runtimePath);

      if (committed) {
        assert.equal(await fs.readFile(fixture.runtimePath, 'utf8'), next);
        await assert.rejects(fs.stat(`${fixture.runtimePath}.previous`), { code: 'ENOENT' });
      } else {
        await assert.rejects(fs.stat(fixture.runtimePath), { code: 'ENOENT' });
        assert.equal(await fs.readFile(`${fixture.runtimePath}.previous`, 'utf8'), journal.backup);
      }

      await assert.rejects(fs.stat(`${fixture.runtimePath}.transaction`), { code: 'ENOENT' });
    });
  }
});

test('SB10: v4 хранит внешний ELF и пользовательские CLI directories', () => {
  const value = {
    version: 4,
    kind: 'binary',
    binary: '/I/bin/grigdesk-server',
    home: '/D',
    cliPaths: ['/user/node/bin'],
  };

  assert.deepEqual(parseRuntimeDescriptor(JSON.stringify(value)), value);
  assert.equal(parseRuntimeDescriptor(JSON.stringify({ ...value, binary: 'relative' })), null);
  assert.equal(parseRuntimeDescriptor(JSON.stringify({ ...value, root: '/R' })), null);

  for (const invalid of [
    { version: 5 }, { kind: 'sea' }, { binary: '/bad\0name' }, { home: 'D' },
    { cliPaths: ['relative'] }, { cliPaths: ['/bad\0name'] }, { cliPaths: null },
  ]) {
    assert.equal(parseRuntimeDescriptor(JSON.stringify({ ...value, ...invalid })), null);
  }
});

/**
 * Фикстура использует одноразовые descriptor/D и настоящий поиск каталогов CLI.
 * Порт prepare отделяет окно от ещё собирающегося launcher, сохраняя точный JSON G1.
 */
async function binaryFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'binary-selection-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const binary = path.join(root, 'installation/bin/grigdesk-server');
  const runtimePath = path.join(root, 'xdg/grigdesk/desktop/runtime.json');
  const descriptor = {
    version: 4,
    kind: 'binary',
    binary,
    home: data,
    cliPaths: [path.join(root, 'saved/bin')],
  };
  const prepared = {
    packageId: 'a'.repeat(64),
    root: path.join(data, 'runtimes/server/packages', 'a'.repeat(64)),
    node: '',
    engine: '',
    installationBin: path.dirname(binary),
    preparationToken: '12345678-1234-4234-8234-123456789abc',
  };

  prepared.node = path.join(prepared.root, 'runtime/node/bin/node');
  prepared.engine = path.join(prepared.root, 'engine/bin/factory');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  for (const directory of [home, data, path.dirname(binary), path.dirname(runtimePath),
    path.join(home, '.nvm/versions/node/v24.21.0/bin')]) {
    await fs.mkdir(directory, { recursive: true });
  }

  await fs.writeFile(binary, '\x7fELF-fixture', { mode: 0o555 });
  await fs.writeFile(runtimePath, JSON.stringify(descriptor));
  await fs.writeFile(path.join(path.dirname(runtimePath), 'runtime-version'), '4\n');

  return {
    root,
    home,
    data,
    binary,
    descriptor,
    prepared,
    runtimePath,
    env: {
      HOME: home,
      XDG_DATA_HOME: path.join(root, 'xdg'),
      PATH: '/usr/bin:/bin',
    },
  };
}

test('SB24-load: prepare даёт R/Node/id; v4 discovery подключён к buildServerEnv', async (t) => {
  const fixture = await binaryFixture(t);
  const calls = [];
  const loaded = await loadServerRuntime({
    env: { ...fixture.env, NODE_OPTIONS: '--inspect' },
    home: fixture.home,
    deps: {
      readText: (file) => fs.readFile(file, 'utf8').catch(() => null),
      exists: async () => true,
      nodeVersion: async () => assert.fail('Node -p в v4 запрещён'),
      checkRelease: async () => assert.fail('legacy R verifier в v4 запрещён'),
      prepareBinary: async (binary, env) => {
        calls.push(binary);
        assert.equal(env.NODE_OPTIONS, undefined);
        assert.equal(env.GRIGDESK_HOME, fixture.data);

        return fixture.prepared;
      },
      releasePreparation: async () => {},
    },
  });

  assert.deepEqual(calls, [fixture.binary], 'v4 вызывает prepare external ELF');
  assert.equal(loaded.runtime?.root, fixture.prepared.root);
  assert.equal(loaded.runtime.serverCommand, fixture.binary);
  assert.deepEqual(loaded.runtime.serverArgs, [
    '--expect-package-id', fixture.prepared.packageId,
    '--preparation-token', fixture.prepared.preparationToken,
  ]);
  assert.equal(loaded.runtime.env.PATH.split(':')[0], path.dirname(fixture.binary));
  assert.ok(loaded.runtime.env.PATH.includes(fixture.descriptor.cliPaths[0]));
  assert.ok(loaded.runtime.env.PATH.includes(path.join(fixture.home, '.nvm/versions/node/v24.21.0/bin')));
  await loaded.runtime.preparation.release();
});

test('SB24-select: source→v4→v3, backup 0600 и same binary не стирает previous', async (t) => {
  const fixture = await binaryFixture(t);
  const previous = JSON.stringify({
    version: 2,
    root: fixture.root,
    node: process.execPath,
    home: fixture.data,
  });
  const source = path.join(fixture.root, 'source');
  const original = JSON.parse(previous);

  original.root = source;
  await fs.mkdir(source);
  await fs.writeFile(fixture.runtimePath, JSON.stringify(original));

  const input = {
    root: fixture.binary,
    env: { ...fixture.env, GRIGDESK_HOME: fixture.data },
    home: fixture.home,
    verify: async () => {},
    verifyBinary: async () => {},
  };

  const accepted = await selectSeaServer(input).then(() => true, () => false);

  assert.equal(accepted, true, 'окно v4 выбирает внешний ELF');

  const selected = JSON.parse(await fs.readFile(fixture.runtimePath, 'utf8'));

  assert.equal(selected.version, 4, 'обычный ELF выбирает v4');
  assert.equal(selected.binary, fixture.binary);
  assert.deepEqual(selected.cliPaths, [path.dirname(process.execPath)]);
  assert.equal((await fs.stat(`${fixture.runtimePath}.previous`)).mode & 0o777, 0o600);
  await selectSeaServer(input);
  assert.equal(await fs.readFile(`${fixture.runtimePath}.previous`, 'utf8'), JSON.stringify(original));

  const legacy = path.join(fixture.root, 'legacy');

  await fs.mkdir(legacy);
  await selectSeaServer({ ...input, root: legacy });
  assert.equal(JSON.parse(await fs.readFile(fixture.runtimePath, 'utf8')).version, 3);
  assert.equal(JSON.parse(await fs.readFile(`${fixture.runtimePath}.previous`, 'utf8')).version, 4);
});

test('SB24-shell: install сохраняет v4 и marker4, use-source использует общий выбор', async (t) => {
  const fixture = await binaryFixture(t);
  const repo = path.join(fixture.root, 'shell-copy');
  const repository = new URL('../../', import.meta.url);

  for (const dir of ['deploy/lib', 'desktop/release', 'bin']) {
    await fs.mkdir(path.join(repo, dir), { recursive: true });
  }

  for (const file of ['deploy/desktop.sh', 'deploy/lib/desktop-app.sh', 'deploy/lib/runtime-env.sh']) {
    await fs.copyFile(new URL(file, repository), path.join(repo, file));
  }

  for (const dir of ['server', 'shared']) {
    await fs.symlink(new URL(dir, repository).pathname, path.join(repo, dir));
  }

  await fs.writeFile(path.join(repo, 'desktop/package.json'), '{"version":"0.1.0"}');
  await fs.writeFile(path.join(repo, 'desktop/release/grigdesk-desktop-0.1.0-x86_64.AppImage'), 'window');

  const env = {
    ...fixture.env,
    GRIGDESK_HOME: fixture.data,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
  };
  const before = await fs.readFile(fixture.runtimePath, 'utf8');

  await execute('/bin/bash', [path.join(repo, 'deploy/desktop.sh'), 'install'], { env });
  assert.equal(await fs.readFile(fixture.runtimePath, 'utf8'), before, 'install сохраняет выбор v4');

  const marker = path.join(path.dirname(fixture.runtimePath), 'runtime-version');

  assert.equal(await fs.readFile(marker, 'utf8'), '4\n');

  const source = path.join(fixture.root, 'new-source');

  await fs.mkdir(path.join(source, 'server/src'), { recursive: true });
  await fs.writeFile(path.join(source, 'server/src/app.ts'), '');
  await execute('/bin/bash', [
    path.join(repo, 'deploy/desktop.sh'), 'use-source', source, '--node', process.execPath,
  ], { env });
  assert.equal(JSON.parse(await fs.readFile(fixture.runtimePath, 'utf8')).version, 2);
  assert.equal(await fs.readFile(`${fixture.runtimePath}.previous`, 'utf8'), before);
});

test('SB24-recovery: предыдущий primary откатывает backup, новый primary завершает commit', async (t) => {
  const fixture = await binaryFixture(t);
  const previous = await fs.readFile(fixture.runtimePath, 'utf8');
  const next = JSON.stringify({
    version: 3,
    kind: 'sea',
    root: '/fixture/R',
    home: fixture.data,
  });
  const journal = {
    format: 1,
    token: '12345678-1234-4234-8234-123456789abc',
    previous,
    next,
    backup: 'older backup',
  };

  for (const primary of [previous, next]) {
    await fs.writeFile(fixture.runtimePath, primary);
    await fs.writeFile(`${fixture.runtimePath}.previous`, 'interrupted backup');
    await fs.writeFile(`${fixture.runtimePath}.transaction`, JSON.stringify(journal), { mode: 0o600 });
    await recoverRuntimeSelection(fixture.runtimePath);
    assert.equal(await fs.readFile(`${fixture.runtimePath}.previous`, 'utf8'),
      primary === previous ? 'older backup' : previous, 'recovery выбирает backup по commit point');
    assert.equal(await fs.stat(`${fixture.runtimePath}.transaction`).catch(() => null), null);
  }
});

test('SB24-recovery: оба rename и конфликт bytes', async (t) => {
  const fixture = await binaryFixture(t);
  const previous = await fs.readFile(fixture.runtimePath, 'utf8');
  const legacy = path.join(fixture.root, 'legacy');

  await fs.mkdir(legacy);

  for (const failed of ['backup', 'primary']) {
    await fs.writeFile(fixture.runtimePath, previous);
    await fs.writeFile(`${fixture.runtimePath}.previous`, 'older');
    await assert.rejects(selectSeaServer({
      root: legacy,
      home: fixture.home,
      env: { ...fixture.env, GRIGDESK_HOME: fixture.data },
      verify: async () => {},
      afterRename: async (phase) => {
        if (phase === failed) {
          throw new Error('injected publication failure');
        }
      },
    }), /publication failure/u);
    await recoverRuntimeSelection(fixture.runtimePath);
    assert.equal(await fs.readFile(`${fixture.runtimePath}.previous`, 'utf8'),
      failed === 'backup' ? 'older' : previous);
  }

  const transaction = `${fixture.runtimePath}.transaction`;

  await fs.writeFile(transaction, JSON.stringify({
    format: 1,
    token: '12345678-1234-4234-8234-123456789abc',
    previous: 'A',
    next: 'B',
    backup: 'older',
  }), { mode: 0o600 });
  await assert.rejects(recoverRuntimeSelection(fixture.runtimePath), { code: 'server_selection_conflict' });
  assert.ok(await fs.stat(transaction));
});

test('SB24-lock: live, unknown и ownerless не обходятся loader или writer', async (t) => {
  const fixture = await binaryFixture(t);
  const directory = `${fixture.runtimePath}.select-lock`;
  const live = await acquireDirectoryLock(directory);

  await assert.rejects(recoverRuntimeSelection(fixture.runtimePath), { code: 'server_selection_busy' });
  await live.release();

  for (const owner of [null, '{"pid":"unknown"}']) {
    await fs.mkdir(directory);

    if (owner) {
      await fs.writeFile(path.join(directory, 'owner.json'), owner);
    }

    await assert.rejects(recoverRuntimeSelection(fixture.runtimePath), { code: 'server_selection_busy' });
    assert.ok(await fs.stat(directory));
    await fs.rm(directory, { recursive: true });
  }
});

test('SB24-crash: SIGKILL writer и recovery новым процессом', async (t) => {
  const fixture = await binaryFixture(t);
  const legacy = path.join(fixture.root, 'legacy');
  const before = await fs.readFile(fixture.runtimePath, 'utf8');
  const module = new URL('../../server/src/lib/selectSeaServer.ts', import.meta.url).href;

  await fs.mkdir(legacy);
  await fs.writeFile(`${fixture.runtimePath}.previous`, 'older');

  const input = {
    root: legacy,
    home: fixture.home,
    env: { ...fixture.env, GRIGDESK_HOME: fixture.data },
  };
  const script = `
    const { selectSeaServer } = await import(${JSON.stringify(module)});
    await selectSeaServer({ ...${JSON.stringify(input)}, verify: async () => {},
      afterRename: async () => {
        process.send('renamed');
        await new Promise(() => { setInterval(() => {}, 1000); });
      }
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: fixture.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const exited = once(child, 'exit');

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }

    await exited;
  });
  assert.equal((await once(child, 'message'))[0], 'renamed');
  assert.ok(await fs.stat(`${fixture.runtimePath}.select-lock/owner.json`));
  assert.ok(await fs.stat(`${fixture.runtimePath}.transaction`));
  child.kill('SIGKILL');
  await exited;
  await execute(process.execPath, ['--input-type=module', '-e',
    `const { recoverRuntimeSelection } = await import(${JSON.stringify(module)});`
    + `await recoverRuntimeSelection(${JSON.stringify(fixture.runtimePath)});`], { env: fixture.env });
  assert.equal(await fs.readFile(fixture.runtimePath, 'utf8'), before);
  assert.equal(await fs.readFile(`${fixture.runtimePath}.previous`, 'utf8'), 'older');
  assert.equal(await fs.stat(`${fixture.runtimePath}.transaction`).catch(() => null), null);
  assert.equal(await fs.stat(`${fixture.runtimePath}.select-lock`).catch(() => null), null);
});

test('SB24-inspect: адрес и настройки окна загружаются без prepare/spawn-ready runtime', async (t) => {
  const fixture = await binaryFixture(t);
  let prepares = 0;
  const loaded = await loadServerRuntime({
    env: fixture.env,
    home: fixture.home,
    purpose: 'inspect',
    deps: {
      readText: (file) => fs.readFile(file, 'utf8').catch(() => null),
      exists: async () => true,
      nodeVersion: async () => null,
      checkRelease: async () => false,
      prepareBinary: async () => {
        prepares += 1;

        return fixture.prepared;
      },
    },
  });

  assert.equal(prepares, 0, 'inspect не materialize и не создаёт prepare lease');
  assert.equal(loaded.inspection?.origin, 'http://127.0.0.1:8140');
  assert.equal('runtime' in loaded, false);
});

test('SB24-shared-port: окно использует общий probe/prepare/release контракт B', async (t) => {
  const fixture = await binaryFixture(t);
  const calls = [];
  const prepared = fixture.prepared;
  const info = {
    format: 1,
    hostContract: 1,
    version: '0.1.0',
    packagingVersion: 2,
    packageId: prepared.packageId,
    runtime: {
      node: '24.21.0',
      abi: '137',
      platform: 'linux',
      arch: 'x64',
    },
    capabilities: ['api', 'ipc', 'helpers', 'engine'],
    engine: { protocol: 'route-v2', sha256: 'b'.repeat(64) },
    payload: {
      sha256: 'c'.repeat(64),
      size: 1,
      entryCount: 1,
    },
  };

  for (const file of [prepared.node, prepared.engine]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'fixture', { mode: 0o555 });
  }

  const loaded = await loadServerRuntime({
    env: fixture.env,
    home: fixture.home,
    deps: {
      ...runtimeDependencies,
      readText: (file) => fs.readFile(file, 'utf8').catch(() => null),
      exists: async () => true,
      nodeVersion: async () => null,
      checkRelease: async () => false,
      binaryRun: async (binary, args, options) => {
        calls.push(args);
        assert.equal(binary, fixture.binary);
        assert.equal(options.env.PATH, '');
        assert.equal(options.env.NODE_OPTIONS, undefined);
        assert.equal(options.maxBuffer, 65536);

        return { stdout: JSON.stringify(args.includes('--runtime-info') ? info
          : args.includes('--prepare') ? prepared : { ok: true }) };
      },
    },
  });

  assert.equal(calls.length, 2, 'default prepare окна использует общий run port B');
  assert.equal(loaded.runtime?.root, prepared.root);
  await loaded.runtime.preparation.release();
  await loaded.runtime.preparation.release();
  assert.deepEqual(calls[2], [
    '--release-preparation', prepared.preparationToken, '--package-id', prepared.packageId, '--json',
  ]);
  assert.equal(calls.length, 3, 'release идемпотентен');
});

test('SB24-binary-shape: non-ELF не исполняется при load и select', async (t) => {
  const fixture = await binaryFixture(t);
  let probes = 0;

  await fs.chmod(fixture.binary, 0o755);
  await fs.writeFile(fixture.binary, '#!/bin/bash\nexit 0\n');
  await loadServerRuntime({
    home: fixture.home,
    env: fixture.env,
    deps: {
      readText: (file) => fs.readFile(file, 'utf8').catch(() => null),
      exists: async () => true,
      nodeVersion: async () => null,
      checkRelease: async () => false,
      binaryRun: async () => {
        probes += 1;

        throw new Error('non-ELF не исполняется');
      },
    },
  });
  assert.equal(probes, 0, 'non-ELF отвергается до metadata probe');
  await assert.rejects(selectSeaServer({
    root: fixture.binary,
    home: fixture.home,
    env: { ...fixture.env, GRIGDESK_HOME: fixture.data },
    verifyBinary: async () => {
      probes += 1;
    },
  }), /ELF/u);
  assert.equal(probes, 0);
});

/**
 * Маленький настоящий ELF отвечает только на metadata/prepare/release и проверяет expect-id.
 * Это процессная проверка окна; полноценный SEA launcher проверяется отдельно кандидатом S22.
 */
async function compiledBinary(fixture, identity) {
  const prepared = {
    ...fixture.prepared,
    packageId: identity,
    root: path.join(fixture.data, 'runtimes/server/packages', identity),
  };

  prepared.node = path.join(prepared.root, 'runtime/node/bin/node');
  prepared.engine = path.join(prepared.root, 'engine/bin/factory');

  for (const file of [prepared.node, prepared.engine]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'fixture', { mode: 0o555 });
  }

  const info = {
    format: 1,
    hostContract: 1,
    version: '0.1.0',
    packagingVersion: 2,
    packageId: identity,
    runtime: {
      node: '24.21.0',
      abi: '137',
      platform: 'linux',
      arch: 'x64',
    },
    capabilities: ['api', 'ipc', 'helpers', 'engine'],
    engine: { protocol: 'route-v2', sha256: 'b'.repeat(64) },
    payload: {
      sha256: 'c'.repeat(64),
      size: 1,
      entryCount: 1,
    },
  };
  const source = path.join(fixture.root, 'binary.c');
  const next = path.join(fixture.root, 'compiled-binary');

  await fs.writeFile(source, `
    #include <stdio.h>
    #include <string.h>
    int main(int argc, char **argv) {
      for (int i=1; i+1<argc; i++) {
        if (!strcmp(argv[i], "--expect-package-id") && strcmp(argv[i+1], "${identity}")) return 1;
      }
      if (!strcmp(argv[1], "--runtime-info")) puts(${JSON.stringify(JSON.stringify(info))});
      else if (!strcmp(argv[1], "--prepare")) puts(${JSON.stringify(JSON.stringify(prepared))});
      else if (!strcmp(argv[1], "--release-preparation")) puts("{\\"ok\\":true}");
      else return 2;
      return 0;
    }
  `);
  await execute('cc', [source, '-o', next]);
  await fs.rename(next, fixture.binary);

  return prepared;
}

test('SB24-swap: новый ELF на том же пути и release A через B', async (t) => {
  const fixture = await binaryFixture(t);
  const input = {
    env: fixture.env,
    home: fixture.home,
    deps: runtimeDependencies,
  };
  const a = await compiledBinary(fixture, 'a'.repeat(64));
  const first = await loadServerRuntime(input);

  assert.equal(first.runtime?.root, a.root);

  const b = await compiledBinary(fixture, 'b'.repeat(64));
  const second = await loadServerRuntime(input);

  assert.equal(second.runtime?.root, b.root);
  assert.notEqual(first.runtime.root, second.runtime.root);
  await assert.rejects(execute(fixture.binary, first.runtime.serverArgs, { env: fixture.env }), { code: 1 });
  await first.runtime.preparation.release();
  await second.runtime.preparation.release();
});

test('SB24-home: сохраняется D descriptor и проверяется прежняя D v1', async (t) => {
  const fixture = await binaryFixture(t);

  await selectSeaServer({
    root: fixture.binary,
    home: fixture.home,
    env: fixture.env,
    verifyBinary: async () => {},
  });
  assert.equal(JSON.parse(await fs.readFile(fixture.runtimePath, 'utf8')).home,
    fixture.data, 'без override сохраняется D выбранного descriptor');

  const source = path.join(fixture.root, 'source');
  const lock = path.join(fixture.home, '.grigdesk/state/server.lock');

  await fs.mkdir(source);
  await fs.mkdir(path.dirname(lock), { recursive: true });
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, starttime: processStarttime(process.pid) }));
  await fs.writeFile(fixture.runtimePath, JSON.stringify({
    version: 1,
    root: source,
    node: process.execPath,
  }));
  await assert.rejects(selectSeaServer({
    root: fixture.binary,
    home: fixture.home,
    env: { ...fixture.env, GRIGDESK_HOME: fixture.data },
    verifyBinary: async () => {},
  }), /пользуется сервер/u);
});
