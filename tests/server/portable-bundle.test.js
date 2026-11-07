import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '../..');
const payload = [
  'GrigDesk', 'README.md', 'bin/b24', 'bin/deepseek', 'bin/grigdesk-ctl',
  'bin/grigdesk-relay', 'bin/grigdesk-server', 'bin/lib/runtime-env.sh',
].sort();
const executable = new Set(payload.filter((file) => !file.endsWith('.md') && !file.endsWith('.sh')));

/**
 * Отсутствие нового оркестратора даёт предметный assertion внутри каждого теста.
 * Ошибки импортов существующего модуля не маскируются под ожидаемое отсутствие реализации.
 */
async function bundleApi() {
  const target = new URL('../../tools/bundleSteps.mts', import.meta.url);
  const present = await fs.stat(target).then(() => true, (error) => {
    assert.equal(error.code, 'ENOENT');

    return false;
  });

  assert.ok(present, 'К1/6: executeBundle ещё не реализует свежую переносимую сборку');

  const api = await import(target.href);

  assert.equal(typeof api.executeBundle, 'function');

  return api.executeBundle;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Перечень учитывает все реальные файлы, а не только строки будущей описи.
 * Символические ссылки не принимаются за обычные файлы полезной нагрузки.
 */
async function inventory(root, prefix = '') {
  const result = [];

  for (const item of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, item.name);

    assert.ok(!item.isSymbolicLink(), `неожиданная ссылка ${relative}`);

    if (item.isDirectory()) {
      result.push(...await inventory(root, relative));
    } else {
      result.push(relative);
    }
  }

  return result.sort();
}

/**
 * Каждый builder пишет новый отдельный выход; прежний bin и пользовательские данные отравлены.
 * Сборка настоящих пакетов запрещена: внедрённые run/fs позволяют проверить tar и отказы rename.
 */
async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-bundle-'));
  const root = path.join(temporary, 'source with spaces');
  const home = path.join(temporary, 'owner');
  const calls = [];
  const built = [];
  const probeEnvironments = [];
  const fail = { stage: null };
  let generation = 0;
  const sentinels = [
    'bin/grigdesk-server', 'bin/deepseek', 'bin/grigdesk-server.grigdesk-server.json',
    'bin/deepseek.grigdesk-deepseek.json', 'bin/.env', 'bin/token',
    'bin/chats/history.json', 'bin/profiles/private.json', 'bin/plugins/private.js',
  ];

  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(home);
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'VERSION'), '0.1.0\n');

  for (const relative of [...sentinels, 'bin/grigdesk-ctl', 'deploy/lib/runtime-env.sh']) {
    const file = path.join(root, relative);

    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `PRIVATE:${relative}`);
  }

  for (const relative of ['bin/grigdesk-ctl', 'deploy/lib/runtime-env.sh']) {
    await fs.copyFile(path.join(repository, relative), path.join(root, relative));
  }

  const descriptor = path.join(home, 'xdg/grigdesk/desktop/runtime.json');

  await fs.mkdir(path.dirname(descriptor), { recursive: true });
  await fs.writeFile(descriptor, 'selected installation stays');

  const child = spawn(process.execPath, ['-e', [
    'const http = require("node:http");',
    'const server = http.createServer((req, res) => res.end("synthetic-live-server"));',
    'server.listen(0, "127.0.0.1", () => process.send(server.address().port));',
  ].join('\n')], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  });

  const [port] = await once(child, 'message');
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_DATA_HOME: path.join(home, 'xdg'),
    GRIGDESK_HOME: path.join(home, 'data'),
    GRIGDESK_ENV_FILE: path.join(home, '.env'),
    SECRET_TOKEN: 'PRIVATE_TOKEN',
    FACTORY_PROFILES_DIR: path.join(home, 'profiles'),
    NODE_OPTIONS: '--inspect=0',
    NODE_PATH: path.join(home, 'modules'),
    LD_PRELOAD: '/private/preload.so',
    VITE_API_URL: 'https://private.invalid',
  };
  const names = {
    server: 'grigdesk-server',
    b24: 'b24',
    relay: 'grigdesk-relay',
    deepseek: 'deepseek',
    window: 'GrigDesk.AppImage',
  };
  const builders = {};

  for (const [stage, name] of Object.entries(names)) {
    builders[stage] = async (input) => {
      calls.push(stage);
      built.push({ stage, ...input });

      if (fail.stage === stage) {
        throw new Error(`Синтетический отказ ${stage}`);
      }

      assert.ok(path.isAbsolute(input.outDir));
      assert.ok(!input.outDir.startsWith(path.join(root, 'bin') + '/'));
      await fs.mkdir(input.outDir, { recursive: true });

      const file = path.join(input.outDir, name);

      await fs.writeFile(file, `${stage}:generation=${generation}`, { mode: 0o755 });

      return file;
    };
  }

  const options = {
    root,
    env,
    builders,
    readSourceState: async () => ({ commit: '1'.repeat(40), dirty: true }),
    verifyDeepSeek: async (binary, probeEnv) => {
      probeEnvironments.push(probeEnv);
      calls.push('verify-deepseek');
      assert.match(await fs.readFile(binary, 'utf8'), /^deepseek:generation=/u);

      if (fail.stage === 'verify-deepseek') {
        throw new Error('Синтетический отказ full verify');
      }
    },
    verifyDeepSeekCompatibility: async () => {
      calls.push('compatibility');

      if (fail.stage === 'compatibility') {
        throw new Error('Синтетический отказ host/GLM compatibility');
      }
    },
    audit: async () => {
      calls.push('audit');

      if (fail.stage === 'audit') {
        throw new Error('Синтетический отказ аудита');
      }
    },
    run: async (command, args, input) => {
      calls.push(command);
      assert.equal(command, 'tar', 'пакеты, службы и установщики здесь не разрешены');

      if (fail.stage === 'tar') {
        throw new Error('Синтетический отказ tar');
      }

      return execute(command, args, input);
    },
    fs: {
      ...fs,
      async rename(from, to) {
        if (fail.stage === 'rename' && to === path.join(root, 'release.tar.gz')) {
          fail.stage = null;

          throw Object.assign(new Error('Синтетический отказ публикации'), { code: 'EIO' });
        }

        return fs.rename(from, to);
      },
    },
  };
  const sentinelBytes = await Promise.all(sentinels.map((file) => fs.readFile(path.join(root, file))));

  return {
    root,
    home,
    env,
    options,
    calls,
    built,
    probeEnvironments,
    fail,
    next() {
      generation += 1;
    },
    /**
     * Сверяет исходные личные файлы и живой API синтетического сервера.
     * Сигналы и install/start/stop исключены журналом внедрённых портов.
     */
    async unchanged() {
      assert.equal(await fs.readFile(descriptor, 'utf8'), 'selected installation stays');
      assert.deepEqual(await Promise.all(sentinels.map((file) => fs.readFile(path.join(root, file)))),
        sentinelBytes);
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      assert.equal(await (await fetch(`http://127.0.0.1:${port}/api/auth/state`)).text(),
        'synthetic-live-server');
      assert.ok(!calls.some((name) => /install|start|stop|kill|sudo|systemctl/u.test(name)));
    },
  };
}

test('PB-PACK-01: повторная сборка свежая и не меняет установленное и живой сервер', async (t) => {
  const box = await fixture(t);
  const build = await bundleApi();

  await build(box.options);
  await fs.writeFile(path.join(box.root, 'release/stale-from-previous-bundle'), 'старый лишний файл');
  box.next();
  await build(box.options);
  await assert.rejects(fs.stat(path.join(box.root, 'release/stale-from-previous-bundle')), {
    code: 'ENOENT',
  });

  for (const stage of ['server', 'b24', 'relay', 'deepseek', 'window']) {
    assert.equal(box.calls.filter((call) => call === stage).length, 2);
  }

  assert.equal(await fs.readFile(path.join(box.root, 'release/bin/grigdesk-server'), 'utf8'),
    'server:generation=1');
  await box.unchanged();
});

test('PB-PACK-02: точный allowlist не включает receipts, env, чаты, профили и токены', async (t) => {
  const box = await fixture(t);
  const build = await bundleApi();

  await build(box.options);
  assert.deepEqual(await inventory(path.join(box.root, 'release')), [...payload, 'bin/bundle.json'].sort());
  assert.deepEqual((await fs.readdir(path.join(box.root, 'release'))).sort(),
    ['GrigDesk', 'README.md', 'bin']);
  await box.unchanged();
});

test('PB-PACK-03: среда builder и verify изолирована от настроек и загрузчиков владельца', async (t) => {
  const box = await fixture(t);
  const build = await bundleApi();

  await build(box.options);
  assert.equal(box.built.length, 5);

  assert.equal(box.probeEnvironments.length, 1);

  for (const input of [...box.built, ...box.probeEnvironments.map((env) => ({ env, stage: 'verify' }))]) {
    assert.notEqual(input.env.HOME, box.env.HOME);
    assert.notEqual(input.env.GRIGDESK_HOME, box.env.GRIGDESK_HOME);
    assert.ok(path.isAbsolute(input.env.HOME));

    for (const key of ['SECRET_TOKEN', 'FACTORY_PROFILES_DIR', 'GRIGDESK_ENV_FILE',
      'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'VITE_API_URL']) {
      assert.equal(input.env[key], undefined, `${input.stage}: ${key}`);
    }
  }
});

test('PB-PACK-04: tar сохраняет байты и права, README объясняет запуск, перенос и удаление', async (t) => {
  const box = await fixture(t);
  const build = await bundleApi();
  const unpack = path.join(box.root, 'unpack with spaces');

  await build(box.options);
  await fs.mkdir(unpack);
  await execute('tar', ['-xzf', path.join(box.root, 'release.tar.gz'), '-C', unpack]);
  assert.deepEqual(await inventory(path.join(unpack, 'release')), [...payload, 'bin/bundle.json'].sort());

  for (const relative of [...payload, 'bin/bundle.json']) {
    const original = path.join(box.root, 'release', relative);
    const extracted = path.join(unpack, 'release', relative);

    assert.deepEqual(await fs.readFile(extracted), await fs.readFile(original), relative);
    assert.equal((await fs.stat(extracted)).mode & 0o777, executable.has(relative) ? 0o755 : 0o644);
  }

  const readme = await fs.readFile(path.join(unpack, 'release/README.md'), 'utf8');

  for (const pattern of [/Linux/iu, /x64|x86_64/iu, /glibc\s*2\.28/iu, /libfuse2/iu,
    /CLI/u, /Node/iu, /Bash/iu, /Python/iu, /подготов/iu, /меню/iu, /удал/iu,
    /данн/iu, /SHA|checksum/iu, /grigdesk-portable\.desktop/u, /перенос/iu,
    /Exec/u, /ход/iu, /телефон/iu, /закры/iu, /останов/iu, /дожд|заверш/iu,
    /userData|профил.*окн/iu, /identity|личност/iu]) {
    assert.match(readme, pattern);
  }

  assert.doesNotMatch(readme, new RegExp(box.home));
});

test('PB-PACK-05: версия из VERSION, commit, dirty и SHA каждого payload подтверждены', async (t) => {
  const box = await fixture(t);
  const build = await bundleApi();

  await build(box.options);

  const release = path.join(box.root, 'release');
  const manifest = JSON.parse(await fs.readFile(path.join(release, 'bin/bundle.json'), 'utf8'));

  assert.equal(manifest.format, 1);
  assert.equal(manifest.kind, 'portable');
  assert.equal(manifest.version, (await fs.readFile(path.join(box.root, 'VERSION'), 'utf8')).trim());
  assert.equal(manifest.commit, '1'.repeat(40));
  assert.equal(manifest.dirty, true);
  assert.deepEqual(manifest.files.map((entry) => entry.path).sort(), payload);

  for (const entry of manifest.files) {
    const bytes = await fs.readFile(path.join(release, entry.path));
    const stat = await fs.stat(path.join(release, entry.path));
    const mode = typeof entry.mode === 'string' ? Number.parseInt(entry.mode, 8) : entry.mode;

    assert.equal(entry.sha256, sha256(bytes), entry.path);
    assert.equal(entry.size, bytes.length, entry.path);
    assert.equal(mode, stat.mode & 0o777, entry.path);
  }

  const checksums = await fs.readFile(path.join(box.root, 'release.tar.gz.sha256'), 'utf8');

  for (const relative of ['release.tar.gz', 'release/bin/bundle.json']) {
    const expected = sha256(await fs.readFile(path.join(box.root, relative)));

    assert.ok(checksums.split('\n').includes(`${expected}  ${relative}`), relative);
  }
});

test('PB-PACK-06: DeepSeek пересобирается, full verify и host/GLM compatibility обязательны', async (t) => {
  const box = await fixture(t);
  const build = await bundleApi();

  await build(box.options);
  assert.equal(await fs.readFile(path.join(box.root, 'release/bin/deepseek'), 'utf8'),
    'deepseek:generation=0');
  assert.equal(box.calls.filter((stage) => stage === 'verify-deepseek').length, 1);
  assert.equal(box.calls.filter((stage) => stage === 'compatibility').length, 1);
  assert.ok(box.calls.indexOf('deepseek') < box.calls.indexOf('verify-deepseek'));
});

test('PB-PACK-FAIL: любой build, verify, audit, tar и rename сохраняют прежний комплект', async (t) => {
  for (const stage of ['server', 'b24', 'relay', 'deepseek', 'window', 'verify-deepseek',
    'compatibility', 'audit', 'tar', 'rename']) {
    await t.test(stage, async (t) => {
      const box = await fixture(t);
      const build = await bundleApi();

      await build(box.options);

      const outputs = [
        ...[...payload, 'bin/bundle.json'].map((file) => `release/${file}`),
        'release.tar.gz',
        'release.tar.gz.sha256',
      ];
      const before = await Promise.all(outputs.map((file) => fs.readFile(path.join(box.root, file))));

      box.next();
      box.fail.stage = stage;
      await assert.rejects(build(box.options));
      assert.deepEqual(await Promise.all(outputs.map((file) => fs.readFile(path.join(box.root, file)))),
        before);
      assert.deepEqual(await inventory(path.join(box.root, 'release')),
        [...payload, 'bin/bundle.json'].sort());
      await box.unchanged();
    });
  }
});

const { installedBuild } = await import('../helpers/installedBuildFixture.mjs');
const { extractReleaseArtifact } = await import('../../shared/node/releaseArchive.ts');

test('PB-PACK-INSTALLED-01–06: allowlist, bytes, mode и admission installer', async (t) => {
  const built = await installedBuild(t, 'release');
  const payload = built.index.latest.payload;

  for (const component of ['desktop', 'server']) {
    const artifact = payload.artifacts[component];
    const directory = path.join(built.temporary, `unpack-${component}`);

    await extractReleaseArtifact(path.join(built.directory, `${component}.tar.gz`), directory, artifact);
    assert.deepEqual(artifact.files.map((entry) => entry.path).sort(), component === 'desktop'
      ? ['GrigDesk'] : ['bin/b24', 'bin/deepseek', 'bin/grigdesk-relay', 'bin/grigdesk-server']);

    for (const entry of artifact.files) {
      const file = path.join(directory, entry.path);
      const bytes = await fs.readFile(file);

      assert.equal(sha256(bytes), entry.sha256);
      assert.equal(bytes.length, entry.size);
      assert.equal((await fs.stat(file)).mode & 0o777, 0o555);
    }

    assert.deepEqual(artifact.buildIdentity, {
      channel: payload.channel,
      version: payload.version,
      commit: payload.commit,
      releaseId: payload.releaseId,
    });
  }

  for (const input of built.captured) {
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'SECRET_TOKEN', 'VITE_API_URL']) {
      assert.equal(input.env[key], undefined);
    }
  }

  assert.deepEqual(built.admission, ['verify', 'compatibility']);
  assert.equal(await fs.readFile(path.join(built.root, 'VERSION'), 'utf8'), '0.3.0\n');
});

for (const failBuilder of ['server', 'b24', 'relay', 'deepseek', 'window']) {
  test(`PB-PACK-INSTALLED-FAIL: ${failBuilder} не выдаёт готовый выпуск`, async (t) => {
    await assert.rejects(installedBuild(t, 'release', { failBuilder }),
      new RegExp(`fixture_builder_failed:${failBuilder}`));
  });
}
