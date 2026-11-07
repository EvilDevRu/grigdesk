import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '../..');
const packageId = 'a'.repeat(64);

/**
 * Копия ctl работает только с одноразовыми исходниками и командами-заглушками.
 * ELF действительно исполняется, но никогда не запускает сервер или установщик.
 */
async function fixture(t, { source = true, binary = false, portable = false } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ctl-bundle-'));
  const root = path.join(temporary, 'copy with spaces');
  const home = path.join(temporary, 'home');
  const calls = path.join(temporary, 'calls');
  const stubs = path.join(temporary, 'stubs');
  const data = path.join(home, '.grigdesk');
  const runtime = path.join(data, 'runtimes/server/packages', packageId);
  const prepared = {
    packageId,
    root: runtime,
    node: path.join(runtime, 'runtime/node/bin/node'),
    engine: path.join(runtime, 'engine/bin/factory'),
    installationBin: path.join(root, 'bin'),
    preparationToken: '12345678-1234-4234-8234-123456789abc',
  };

  t.after(() => fs.rm(temporary, { recursive: true, force: true }));

  for (const directory of [home, stubs, path.join(root, 'bin/lib'), path.join(root, 'tools'),
    path.join(root, 'cli'), path.dirname(prepared.node), path.dirname(prepared.engine),
    path.join(runtime, 'server/runtime/helpers')]) {
    await fs.mkdir(directory, { recursive: true });
  }

  await fs.writeFile(calls, '');
  await fs.copyFile(path.join(repository, 'bin/grigdesk-ctl'), path.join(root, 'bin/grigdesk-ctl'));

  const library = portable ? 'bin/lib/runtime-env.sh' : 'deploy/lib/runtime-env.sh';

  await fs.mkdir(path.dirname(path.join(root, library)), { recursive: true });
  await fs.copyFile(path.join(repository, 'deploy/lib/runtime-env.sh'), path.join(root, library));
  await fs.writeFile(path.join(root, 'tools/bundle.mts'), [
    'import fs from "node:fs";',
    `fs.appendFileSync(${JSON.stringify(calls)}, "bundle\\n");`,
  ].join('\n'));
  await fs.writeFile(path.join(root, 'cli/main.ts'), [
    'process.stdout.write("legacy CLI\\n");',
    'process.exit(process.argv.includes("--help") ? 0 : 42);',
  ].join('\n'));

  if (source) {
    for (const marker of ['server/src/app.ts', 'web/package.json', 'desktop/package.json']) {
      await fs.mkdir(path.dirname(path.join(root, marker)), { recursive: true });
      await fs.writeFile(path.join(root, marker), '{}');
    }
  }

  for (const command of ['npm', 'systemctl', 'sudo', 'kill', 'apt']) {
    const script = `#!/bin/bash\nprintf '${command}\\n' >> '${calls}'\nexit 97\n`;

    await fs.writeFile(path.join(stubs, command), script, {
      mode: 0o755,
    });
  }

  for (const helper of ['grigdesk-cli.mjs', 'select-sea-server.mjs']) {
    await fs.writeFile(path.join(runtime, 'server/runtime/helpers', helper), [
      'import fs from "node:fs";',
      `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(1)) + "\\n");`,
      'process.stdout.write(process.argv.includes("--help") ? "СПРАВКА\\n" : "0.1.0\\n");',
      'process.exit(process.argv.includes("--help") || process.argv.includes("--version") ? 0 : 23);',
    ].join('\n'));
  }

  await fs.writeFile(prepared.node, `#!/bin/bash\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  await fs.writeFile(prepared.engine, '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(root, 'bin/b24'), '#!/bin/bash\nexit 19\n', { mode: 0o755 });

  if (binary) {
    const metadata = {
      format: 1,
      hostContract: 1,
      version: '0.1.0',
      packagingVersion: 2,
      packageId,
      runtime: {
        node: '24.21.0',
        abi: '137',
        platform: 'linux',
        arch: 'x64',
      },
      capabilities: ['api', 'engine', 'helpers', 'ipc'],
      engine: { protocol: 'route-v2', sha256: 'b'.repeat(64) },
      payload: {
        sha256: 'c'.repeat(64),
        size: 1,
        entryCount: 1,
      },
    };
    const cSource = path.join(temporary, 'server.c');

    await fs.writeFile(cSource, [
      '#include <stdio.h>',
      '#include <string.h>',
      'int main(int argc, char **argv) {',
      `  FILE *log = fopen(${JSON.stringify(calls)}, "a");`,
      '  for (int i = 1; i < argc; i++) fprintf(log, "%s ", argv[i]);',
      '  fprintf(log, "\\n"); fclose(log);',
      '  if (argc > 1 && !strcmp(argv[1], "--runtime-info"))',
      `    puts(${JSON.stringify(JSON.stringify(metadata))});`,
      '  else if (argc > 1 && !strcmp(argv[1], "--prepare"))',
      `    puts(${JSON.stringify(JSON.stringify(prepared))});`,
      '  else if (argc > 1 && !strcmp(argv[1], "--release-preparation")) puts("{}");',
      '  else return 17;',
      '  return 0;',
      '}',
    ].join('\n'));
    await execute('cc', [cSource, '-o', path.join(root, 'bin/grigdesk-server')]);
  }

  if (portable) {
    await fs.writeFile(path.join(root, 'bin/bundle.json'), JSON.stringify({
      format: 1,
      kind: 'portable',
      version: '0.1.0',
      commit: 'a'.repeat(40),
      dirty: false,
      files: [],
    }));
  }

  const env = {
    HOME: home,
    XDG_DATA_HOME: path.join(temporary, 'xdg'),
    XDG_CONFIG_HOME: path.join(temporary, 'config'),
    GRIGDESK_HOME: data,
    TMPDIR: temporary,
    PATH: `${stubs}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
  };

  return {
    root,
    stubs,
    calls: () => fs.readFile(calls, 'utf8'),
    /**
     * Запускает только синтетическую копию ctl с ограниченным временем.
     * Запрет host Node доказан отдельной заглушкой с кодом 97.
     */
    async run(args, noNode = false) {
      if (noNode) {
        const script = `#!/bin/bash\nprintf 'host-node\\n' >> '${calls}'\nexit 97\n`;

        await fs.writeFile(path.join(stubs, 'node'), script, {
          mode: 0o755,
        });
      }

      try {
        return { code: 0, ...await execute('/bin/bash', [path.join(root, 'bin/grigdesk-ctl'), ...args], {
          env,
          cwd: '/',
          timeout: 10000,
        }) };
      } catch (error) {
        return {
          code: error.code,
          stdout: error.stdout,
          stderr: error.stderr,
        };
      }
    },
  };
}

test('PB-CLI-01: source с ELF и без ELF направляет bundle в свежий сборщик', async (t) => {
  for (const binary of [false, true]) {
    const box = await fixture(t, { binary });
    const result = await box.run(['bundle']);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(await box.calls(), 'bundle\n');
  }
});

test('PB-CLI-02: help в любом месте обходится без Node и всех эффектов', async (t) => {
  for (const args of [['bundle', '--help'], ['bundle', '-h'], ['bundle', 'extra', '--help']]) {
    const box = await fixture(t, { binary: true });
    const result = await box.run(args, true);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(await box.calls(), '', 'help не обращается к runtime и сборщикам');
    assert.match(result.stdout, /bundle/u);
  }
});

test('PB-CLI-03: лишний аргумент и отсутствие source дают ранний отказ без эффектов', async (t) => {
  for (const source of [true, false]) {
    const box = await fixture(t, { source, binary: true });
    const result = await box.run(source ? ['bundle', 'extra'] : ['bundle']);

    assert.equal(result.code, source ? 2 : 1, result.stderr);
    assert.match(result.stderr, source ? /bundle/u : /исходник/u);
    assert.equal(await box.calls(), '');
  }
});

test('PB-CTL-01: payload Node, код helper и освобождение preparation', async (t) => {
  const box = await fixture(t, {
    source: false,
    binary: true,
    portable: true,
  });

  for (const [args, code] of [[['--help'], 0], [['--version'], 0], [['status'], 23],
    [['run', '--fixture'], 17], [['b24', '--fixture'], 19]]) {
    const result = await box.run(args, true);

    assert.equal(result.code, code, result.stderr);
  }

  const calls = await box.calls();

  assert.doesNotMatch(calls, /host-node|npm|systemctl|sudo|apt/u);
  assert.equal(calls.match(/--prepare --json/gu)?.length, 3);
  assert.equal(calls.match(/--release-preparation/gu)?.length, 3);
  assert.match(calls, /grigdesk-cli\.mjs/u);
});

test('PB-CTL-SELECT: use-server работает без source и host Node', async (t) => {
  const box = await fixture(t, {
    source: false,
    binary: true,
    portable: true,
  });
  const target = path.join(box.root, 'bin/grigdesk-server');
  const result = await box.run(['desktop', 'use-server', target], true);

  assert.equal(result.code, 23, result.stderr);

  const calls = await box.calls();

  assert.match(calls, /select-sea-server\.mjs/u);
  assert.ok(calls.includes(target));
  assert.match(calls, /--release-preparation/u);
  assert.doesNotMatch(calls, /host-node|sudo|systemctl|npm/u);
});

const { installedBuild } = await import('../helpers/installedBuildFixture.mjs');

for (const channel of ['release', 'dev']) {
  test(`VER-PROPAGATION: ${channel} identity передана всем сборщикам`, async (t) => {
    const built = await installedBuild(t, channel);
    const identity = built.index.latest.payload;

    assert.equal(built.captured.length, 5);

    for (const { env, outDir } of built.captured) {
      assert.equal(env.GRIGDESK_RELEASE_VERSION, identity.version);
      assert.equal(env.GRIGDESK_RELEASE_CHANNEL, channel);
      assert.equal(env.GRIGDESK_RELEASE_COMMIT, identity.commit);
      assert.equal(env.GRIGDESK_RELEASE_ID, identity.releaseId);
      assert.ok(outDir.startsWith(built.root));
      assert.notEqual(env.HOME, process.env.HOME);
    }

    assert.deepEqual(built.admission, ['verify', 'compatibility']);

    const portableOutput = (await fs.readdir(built.directory))
      .some((name) => /portable|bundle\.json/.test(name));

    assert.equal(portableOutput, false);
  });
}

const { installedRelease, isolatedEnvironment } = await import('../helpers/installedUpdateFixture.mjs');
const { loadInstalledModule } = await import('../helpers/installedBuildFixture.mjs');

for (const mode of ['local', 'remote', 'server']) {
  test(`PUB-INSTALL: ${mode}, готовые tar, отдельные данные и launchers без старта`, async (t) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'normal-install-'));
    const release = installedRelease();
    const { installRelease } = await loadInstalledModule(t, 'tools/installRelease.mts', release.publicKeyPem);
    const stubs = path.join(temporary, 'stubs');
    const calls = path.join(temporary, 'calls');
    const root = path.join(temporary, 'installation');
    const dataHome = path.join(temporary, 'data');
    const userData = path.join(temporary, 'user');
    const binDirectory = path.join(temporary, 'bin');
    const applicationsDirectory = path.join(temporary, 'applications');
    const unitDirectory = path.join(temporary, 'units');
    const maintenance = path.join(temporary, 'maintenance');

    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    await fs.mkdir(stubs);
    await fs.mkdir(dataHome);
    await fs.mkdir(userData);
    await fs.writeFile(path.join(dataHome, '.env'), 'сохранить');
    await fs.writeFile(maintenance, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await fs.writeFile(path.join(stubs, 'systemctl'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 1\n`, { mode: 0o700 });
    isolatedEnvironment(t, {
      HOME: temporary,
      XDG_DATA_HOME: path.join(temporary, 'share'),
      PATH: `${stubs}:/usr/bin:/bin`,
    });

    const input = {
      root,
      mode,
      dataHome,
      userData,
      binDirectory,
      applicationsDirectory,
      unitDirectory,
      envelope: release.envelope,
      maintenance,
      archive: async (component) => {
        const file = path.join(temporary, `${component}.tar.gz`);
        const artifact = release.envelope.payload.artifacts[component];

        await fs.writeFile(file, release.archives.get(artifact.url));

        return file;
      },
    };
    const receipt = await installRelease(input);
    const pointer = JSON.parse(await fs.readFile(path.join(root, 'current.json'), 'utf8'));

    assert.equal(receipt.mode, mode);
    assert.equal(pointer.desktop === null, mode === 'server');
    assert.equal(pointer.server === null, mode === 'remote');
    assert.equal(await fs.readFile(path.join(dataHome, '.env'), 'utf8'), 'сохранить');
    assert.equal(await fs.stat(path.join(binDirectory, 'grigdesk-ctl')).then(() => true), true);
    assert.equal(await fs.stat(path.join(root, 'bin/bundle.json')).then(() => true, () => false), false);

    const descriptor = path.join(temporary, 'share/grigdesk/desktop/runtime.json');

    assert.equal(await fs.stat(descriptor).then(() => true, () => false), mode === 'local');
    assert.equal(await fs.stat(path.join(unitDirectory, 'grigdesk-server.service'))
      .then(() => true, () => false), mode !== 'remote');
    assert.doesNotMatch(await fs.readFile(calls, 'utf8').catch(() => ''), /start|enable/);
    assert.deepEqual(await installRelease(input), receipt, 'Повтор своей установки идемпотентен');

    await assert.rejects(installRelease({ ...input, dataHome: path.join(temporary, 'foreign-data') }),
      /installation_collision/);
    assert.equal(await fs.readFile(path.join(dataHome, '.env'), 'utf8'), 'сохранить');
  });
}
