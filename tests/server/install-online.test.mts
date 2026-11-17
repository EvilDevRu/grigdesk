import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { sign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';

import { canonicalJson } from '../../shared/lib/canonicalJson.ts';
import { sha256, sha256File } from '../../shared/node/hash.ts';
import { installedRelease } from '../helpers/installedUpdateFixture.mjs';
import { loadInstalledModule } from '../helpers/installedBuildFixture.mjs';

/**
 * Локальный HTTP-источник раздаёт подписанные архивы и считает запросы.
 * Флаг truncateNext обрывает следующий ответ для проверки восстановления.
 */
async function servingRelease(t: TestContext, release: ReturnType<typeof installedRelease>) {
  const requests: string[] = [];
  let truncateOnce = false;
  const server = http.createServer((request, response) => {
    const component = request.url === '/desktop.tar.gz' ? 'desktop'
      : request.url === '/server.tar.gz' ? 'server' : null;

    requests.push(request.url ?? '');

    if (!component) {
      response.statusCode = 404;
      response.end();

      return;
    }

    const bytes = [...release.archives.values()][component === 'desktop' ? 0 : 1]!;

    if (truncateOnce) {
      truncateOnce = false;
      response.end(bytes.subarray(0, bytes.length - 1));

      return;
    }

    response.end(bytes);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  return {
    requests: () => requests,
    truncateNext: () => {
      truncateOnce = true;
    },
    port: (server.address() as AddressInfo).port,
  };
}

/**
 * Индекс переподписывается с URL локального источника тем же ключом фикстуры.
 * Подпись, описи и архивы остаются настоящими продуктами releaseV2Fixture.
 */
function localEnvelope(release: ReturnType<typeof installedRelease>, port: number) {
  const payload = JSON.parse(JSON.stringify(release.envelope.payload));

  payload.artifacts.desktop.url = `https://127.0.0.1:${port}/desktop.tar.gz`;
  payload.artifacts.server.url = `https://127.0.0.1:${port}/server.tar.gz`;

  const signedBytes = Buffer.from(`GrigDesk release v2\n${canonicalJson(payload)}\n`, 'utf8');
  const envelope = { payload, signature: sign(null, signedBytes, release.privateKey)
    .toString('base64') };

  return { envelope, manifestDigest: sha256(signedBytes) };
}

/**
 * Полный стенд установки: индекс-файл, кэш и пути профиля во временной папке,
 * собранный maintenance с подменённым pinned ключом и настоящей установкой.
 */
async function onlineBox(t: TestContext) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'install-online-'));
  const release = installedRelease();
  const source = await servingRelease(t, release);
  const { envelope } = localEnvelope(release, source.port);
  const indexFile = path.join(temporary, 'release.json');
  const cacheDir = path.join(temporary, 'cache');
  const { fixtureModuleUrl } = await loadInstalledModule(t, 'tools/maintenance.mts',
    release.publicKeyPem);
  const home = path.join(temporary, 'home');

  await fs.mkdir(home, { mode: 0o700 });

  // Настоящий child исключает запись descriptor в пользовательский HOME.
  // HTTPS-контракт не ослабляется: только транспорт fixture идёт на loopback HTTP.
  const runMaintenance = async (argv: string[]) => {
    const source = `
      import { runMaintenance } from ${JSON.stringify(fixtureModuleUrl)};
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = (url, options) => {
        const target = new URL(url);
        if (target.hostname === '127.0.0.1') target.protocol = 'http:';
        return nativeFetch(target, options);
      };
      try {
        process.exitCode = await runMaintenance(JSON.parse(process.argv[1]));
      } catch (error) {
        process.stderr.write(error.message);
        process.exitCode = 2;
      }
    `;

    try {
      await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source,
        JSON.stringify(argv)], {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, 'config'),
          XDG_DATA_HOME: path.join(home, 'share'),
          GRIGDESK_HOME: path.join(home, 'data'),
          XDG_RUNTIME_DIR: path.join(home, 'runtime'),
          DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(home, 'absent-bus')}`,
        },
      });

      return 0;
    } catch (error) {
      if ((error as { code?: number }).code === 10) {
        return 10;
      }

      throw new Error((error as { stderr?: string }).stderr || String(error));
    }
  };

  await fs.writeFile(indexFile, canonicalJson({
    format: 2,
    channel: envelope.payload.channel,
    publishedAt: envelope.payload.publishedAt,
    latest: envelope,
  }) + '\n');

  t.after(() => fs.rm(temporary, { recursive: true, force: true }));

  return {
    temporary,
    release,
    source,
    envelope,
    indexFile,
    cacheDir,
    runMaintenance,
    paths: {
      root: path.join(temporary, 'program'),
      dataHome: path.join(temporary, 'data'),
      userData: path.join(temporary, 'user'),
      binDirectory: path.join(temporary, 'bin'),
      applicationsDirectory: path.join(temporary, 'apps'),
      unitDirectory: path.join(temporary, 'units'),
    },
  };
}

function argvFor(box: Awaited<ReturnType<typeof onlineBox>>,
  mode: string, cacheDir = box.cacheDir): string[] {
  return ['install-online', '--release', box.indexFile, '--mode', mode,
    '--root', box.paths.root, '--data-home', box.paths.dataHome,
    '--user-data', box.paths.userData, '--bin-dir', box.paths.binDirectory,
    '--applications-dir', box.paths.applicationsDirectory,
    '--unit-dir', box.paths.unitDirectory, '--cache-dir', cacheDir];
}

test('ONLINE-CAPABILITY: install-online устанавливает remote через настоящий путь', async (t) => {
  const box = await onlineBox(t);

  assert.equal(await box.runMaintenance(argvFor(box, 'remote')), 0);

  const receipt = JSON.parse(await fs.readFile(path.join(box.paths.root, 'installation.json'),
    'utf8'));
  const pointer = JSON.parse(await fs.readFile(path.join(box.paths.root, 'current.json'),
    'utf8'));

  assert.equal(receipt.mode, 'remote');
  assert.ok(pointer.desktop);
  assert.equal(pointer.server, null);
  assert.ok(box.source.requests().every((url) => !url.includes('server.tar.gz')));
});

test('ONLINE-MODES: local и server качают только свои компоненты', async (t) => {
  for (const mode of ['local', 'server'] as const) {
    const box = await onlineBox(t);

    assert.equal(await box.runMaintenance(argvFor(box, mode)), 0);

    const pointer = JSON.parse(await fs.readFile(path.join(box.paths.root, 'current.json'),
      'utf8'));

    if (mode === 'local') {
      assert.ok(pointer.desktop && pointer.server);
    } else {
      assert.equal(pointer.desktop, null);
      assert.ok(pointer.server);
    }
  }
});

test('ONLINE-SIGNATURE-INVALID: плохая подпись индекса останавливает установку до загрузки', async (t) => {
  const box = await onlineBox(t);
  const broken = path.join(box.temporary, 'broken.json');
  const index = JSON.parse(await fs.readFile(box.indexFile, 'utf8'));

  index.latest.signature = Buffer.from('0'.repeat(64)).toString('base64');
  await fs.writeFile(broken, JSON.stringify(index));

  await assert.rejects(box.runMaintenance(argvFor(box, 'remote').map((value, position) =>
    position === 2 ? broken : value)), /signature|invalid/u);
  await assert.rejects(fs.stat(path.join(box.cacheDir, 'desktop.tar.gz')), { code: 'ENOENT' });
});

test('ONLINE-CACHE-REUSE: повтор использует проверенные архивы без сети', async (t) => {
  const box = await onlineBox(t);

  assert.equal(await box.runMaintenance(argvFor(box, 'remote')), 0);

  const downloaded = box.source.requests().length;

  assert.equal(await box.runMaintenance(argvFor(box, 'remote')), 10);
  assert.equal(box.source.requests().length, downloaded);
});

test('ONLINE-CACHE-CORRUPT: испорченный архив уходит в quarantine и перекачивается', async (t) => {
  const box = await onlineBox(t);
  const secondRoot = { ...box.paths, root: path.join(box.temporary, 'program-2') };

  assert.equal(await box.runMaintenance(argvFor(box, 'remote')), 0);

  const cached = path.join(box.cacheDir, 'desktop.tar.gz');
  const bytes = await fs.readFile(cached);

  bytes.writeUInt8(bytes.readUInt8(0) ^ 0xff, 0);
  await fs.writeFile(cached, bytes);

  // Новый чистый root вызывает archive() заново: порча кэша обнаруживается
  // при получении, а не коротким путём повторного completed-установа.
  assert.equal(await box.runMaintenance(argvFor(box, 'remote').map((value, position) =>
    position === 6 ? secondRoot.root : [12, 14, 16].includes(position) ? value + '-2' : value)), 0);

  const quarantine = path.join(box.cacheDir, 'quarantine');

  assert.equal((await fs.readdir(quarantine)).length, 1);
  assert.equal(await sha256File(cached), box.envelope.payload.artifacts.desktop.sha256);

  const pointer = JSON.parse(await fs.readFile(path.join(secondRoot.root, 'current.json'),
    'utf8'));

  assert.ok(pointer.desktop);
});

test('ONLINE-PART-TRUNCATED: оборванная загрузка не оставляет готовый архив', async (t) => {
  const box = await onlineBox(t);

  box.source.truncateNext();

  await assert.rejects(box.runMaintenance(argvFor(box, 'remote')),
    /release_download_integrity_invalid/u);
  assert.equal((await fs.readdir(box.cacheDir)).filter((name) => name.endsWith('.part')).length,
    0);
  await assert.rejects(fs.stat(path.join(box.paths.root, 'current.json')), { code: 'ENOENT' });

  assert.equal(await box.runMaintenance(argvFor(box, 'remote')), 0);
});

test('ONLINE-SOURCE-DIR: альтернативный каталог не обращается к сети', async (t) => {
  const box = await onlineBox(t);
  const directory = path.join(box.temporary, 'source');

  await fs.mkdir(directory, { mode: 0o700 });

  for (const component of ['desktop', 'server'] as const) {
    const bytes = [...box.release.archives.values()][component === 'desktop' ? 0 : 1]!;

    await fs.writeFile(path.join(directory, `${component}.tar.gz`), bytes);
  }

  assert.equal(await box.runMaintenance([...argvFor(box, 'local'),
    '--source-dir', directory]), 0);
  assert.deepEqual(box.source.requests(), []);
});

test('ONLINE-SOURCE-SYMLINK: symlink в source-dir отвергается', async (t) => {
  const box = await onlineBox(t);
  const directory = path.join(box.temporary, 'source');
  const bytes = [...box.release.archives.values()][0]!;

  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(path.join(directory, 'real-desktop.tar.gz'), bytes);
  await fs.symlink(path.join(directory, 'real-desktop.tar.gz'),
    path.join(directory, 'desktop.tar.gz'));
  await fs.writeFile(path.join(directory, 'server.tar.gz'),
    [...box.release.archives.values()][1]!);

  await assert.rejects(box.runMaintenance([...argvFor(box, 'local'),
    '--source-dir', directory]), /install_online_source_invalid/u);
});

test('ONLINE-ARGUMENTS: дубли и относительные пути отвергаются до индекса', async (t) => {
  const box = await onlineBox(t);
  const argv = argvFor(box, 'remote');

  await assert.rejects(box.runMaintenance([...argv, '--root', box.paths.root]),
    /installation_arguments_invalid/u);
  await assert.rejects(box.runMaintenance(argv.map((value, position) =>
    position === 6 ? 'relative/path' : value)), /installation_arguments_invalid/u);
});

test('ONLINE-EXISTING-ROOT: завершённая установка проходит штатный путь с кодом 10', async (t) => {
  const box = await onlineBox(t);

  assert.equal(await box.runMaintenance(argvFor(box, 'remote')), 0);

  const receiptBefore = await fs.readFile(path.join(box.paths.root, 'installation.json'),
    'utf8');

  assert.equal(await box.runMaintenance(argvFor(box, 'remote')), 10);
  assert.equal(await fs.readFile(path.join(box.paths.root, 'installation.json'), 'utf8'),
    receiptBefore);
});

test('ONLINE-SPACES: server unit сохраняет пути с пробелами', async (t) => {
  const box = await onlineBox(t);

  box.paths.root = path.join(box.temporary, 'program with spaces');
  box.paths.dataHome = path.join(box.temporary, 'data with spaces');
  assert.equal(await box.runMaintenance(argvFor(box, 'server')), 0);

  const unit = await fs.readFile(path.join(box.paths.unitDirectory, 'grigdesk-server.service'), 'utf8');

  assert.ok(unit.includes(`ExecStart="${box.paths.root}/bin/grigdesk-server"`));
  assert.ok(unit.includes(`EnvironmentFile=-"${box.paths.dataHome}/.env"`));
});
