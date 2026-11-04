import { makeReadOnlyTree } from '../../shared/node/files.ts';
import { sha256 } from '../../shared/node/hash.ts';
import { canonicalJson } from '../../shared/lib/canonicalJson.ts';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { helpPublicationCommand, prepareReleaseHelp } from '../../tools/helpPublication.mts';

const execute = promisify(execFile);

/**
 * Tar и файловые команды настоящие; только mv-граница получает детерминированный отказ.
 * Перед переносом channel wrapper проверяет наличие обоих уже опубликованных каталогов.
 */
async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'help-publish-'));
  const site = path.join(root, 'site with quote\'');
  const bin = path.join(root, 'bin');

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(site, 'api/releases/v1'), { recursive: true });
  await mkdir(bin);
  await writeFile(path.join(site, 'api/releases/v1/channel.json'), 'OLD-CHANNEL');
  await writeFile(path.join(bin, 'mv'), [
    '#!/bin/sh',
    'for arg do destination="$arg"; done',
    'if test "$destination" = "$HELP_PUBLISH_SITE/api/releases/v1/channel.json"; then',
    '  test -f "$HELP_PUBLISH_SITE/releases/0.1.0/release.tar.gz" || exit 91',
    '  test -f "$HELP_PUBLISH_SITE/help/0.1.0/index.html" || exit 92',
    'fi',
    'if test -n "${HELP_PUBLISH_FAIL_TARGET:-}";',
    'then test "$destination" != "$HELP_PUBLISH_FAIL_TARGET" || exit 39; fi',
    'exec /bin/mv "$@"',
  ].join('\n'), { mode: 0o755 });

  /**
   * Каждый upload имеет своё staging и неизменяемый набор синтетических файлов.
   * Неполный upload проверяет отказ до commit, а повтор использует новый nonce.
   */
  async function upload(name: string, complete = true) {
    const staging = path.join(site, name);
    const content = path.join(root, name);

    await mkdir(staging, { recursive: true });
    await mkdir(content);
    await writeFile(path.join(content, 'index.html'), '<title>Help</title>');
    await writeFile(path.join(content, 'help.json'), '{"format":1}');
    await writeFile(path.join(content, 'latest.html'), '<script src="./latest.js"></script>');

    if (complete) {
      await writeFile(path.join(content, 'latest.js'), 'void 0;');
    }

    await execute('tar', ['-czf', path.join(staging, 'help-site.tar.gz'), '-C', content, '.']);
    await writeFile(path.join(staging, 'release.tar.gz'), 'ARCHIVE');
    await writeFile(path.join(staging, 'release.tar.gz.sha256'), 'SAME-CHECKSUM');
    await writeFile(path.join(staging, 'release.tar.gz.sha256.sig'), 'SIGNATURE');
    await writeFile(path.join(staging, 'channel.json'), 'NEW-CHANNEL');

    return staging;
  }

  const commit = (staging: string, digest = 'a'.repeat(64), failTarget = '') => execute('/bin/sh', ['-c',
    helpPublicationCommand({
      directory: site,
      staging,
      version: '0.1.0',
      archiveSha256: digest
    })], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HELP_PUBLISH_SITE: site,
      HELP_PUBLISH_FAIL_TARGET: failTarget,
    },
  });

  return {
    site,
    upload,
    commit
  };
}

test('HELP-R1: channel перенесён только после реальных release и help; повтор идемпотентен', async (t) => {
  const box = await fixture(t);

  await assert.rejects(async () => box.commit(await box.upload('incomplete', false)));
  assert.equal(await readFile(path.join(box.site, 'api/releases/v1/channel.json'), 'utf8'), 'OLD-CHANNEL');
  await box.commit(await box.upload('complete'));
  assert.equal(await readFile(path.join(box.site, 'api/releases/v1/channel.json'), 'utf8'), 'NEW-CHANNEL');
  assert.equal(await readFile(path.join(box.site, 'help/0.1.0/index.html'), 'utf8'), '<title>Help</title>');
  await box.commit(await box.upload('retry'));
  await writeFile(path.join(box.site, 'api/releases/v1/channel.json'), 'KEEP-CHANNEL');
  await assert.rejects(async () => box.commit(await box.upload('conflict'), 'b'.repeat(64)));
  assert.equal(await readFile(path.join(box.site, 'api/releases/v1/channel.json'), 'utf8'), 'KEEP-CHANNEL');
});

test('HELP-R2: занятый lock сохраняет канал и чужой lock', async (t) => {
  const box = await fixture(t);
  const lock = path.join(box.site, '.grigdesk-release-publish.lock');

  await mkdir(lock);
  await assert.rejects(async () => box.commit(await box.upload('concurrent')));
  assert.equal(await readFile(path.join(box.site, 'api/releases/v1/channel.json'), 'utf8'), 'OLD-CHANNEL');
  await rm(lock, { recursive: true });
  await box.commit(await box.upload('after-unlock'));
});

for (const phase of ['after-help', 'after-release']) {
  test(`HELP-R5 ${phase}: старый channel при частичном commit, новый upload завершает его`, async (t) => {
    const box = await fixture(t);
    const failTarget = phase === 'after-help' ? path.join(box.site, 'releases/0.1.0')
      : path.join(box.site, 'help/latest.js');

    await assert.rejects(async () => box.commit(await box.upload('partial'), 'a'.repeat(64), failTarget));
    assert.equal(await readFile(path.join(box.site, 'api/releases/v1/channel.json'), 'utf8'), 'OLD-CHANNEL');
    assert.equal(await readFile(path.join(box.site, 'help/0.1.0/index.html'), 'utf8'), '<title>Help</title>');
    await assert.rejects(() => stat(path.join(box.site, '.grigdesk-release-publish.lock')));

    if (phase === 'after-release') {
      assert.equal(await readFile(path.join(box.site, 'releases/0.1.0/release.tar.gz'), 'utf8'), 'ARCHIVE');
    }

    await box.commit(await box.upload('continued'));
    assert.equal(await readFile(path.join(box.site, 'api/releases/v1/channel.json'), 'utf8'), 'NEW-CHANNEL');
    assert.equal(await readFile(path.join(box.site, 'help/0.1.0/index.html'), 'utf8'), '<title>Help</title>');
  });
}

/**
 * Настоящий tar несёт synthetic Node executable с тем же metadata/prepare протоколом.
 * SHA проверяется до его исполнения, все файловые эффекты находятся во временной папке.
 */
async function binaryRelease(
  t: import('node:test').TestContext, wrongBinarySha = false, siteMismatch = false,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'help-release-'));
  const packaged = path.join(root, 'source/release/bin');
  const packageId = 'a'.repeat(64);
  const resource = path.join(root, 'resources', packageId);
  const trace = path.join(root, 'native-calls.jsonl');
  const content = {
    format: 1,
    version: '0.1.0',
    commit: 'c'.repeat(40),
    locale: 'ru',
    articles: [{
      id: 'overview',
      file: 'README.md',
      title: 'Начало',
      section: 'Основы',

      keywords: [],
      routes: [],
      markdown: '# Справка выпущенного архива'
    }]
  };
  const bundle = {
    ...content, revision: sha256(canonicalJson(content))
  };
  const info = {
    format: 1,
    hostContract: 1,
    version: '0.1.0',
    packagingVersion: 2,
    packageId,
    runtime: {
      node: '24.21.0',
      abi: '137',
      platform: 'linux',
      arch: 'x64'
    },
    capabilities: ['api', 'ipc', 'helpers', 'engine'],
    engine: {
      protocol: 'route-v2', sha256: 'b'.repeat(64)
    },
    payload: {
      sha256: 'd'.repeat(64),
      size: 1,
      entryCount: 1
    }
  };
  const prepared = {
    packageId,
    root: resource,
    node: path.join(resource, 'runtime/node/bin/node'),

    engine: path.join(resource, 'engine/bin/factory'),
    installationBin: packaged,
    preparationToken: '00000000-0000-4000-8000-000000000001'
  };

  t.after(() => rm(root, {
    recursive: true, force: true
  }));
  await mkdir(packaged, {
    recursive: true
  });
  await mkdir(path.join(resource, 'server/help/site'), {
    recursive: true
  });
  await writeFile(path.join(resource, 'server/help/help.json'), JSON.stringify(bundle));
  await writeFile(path.join(resource, 'server/help/site/help.json'),
    siteMismatch ? 'different' : JSON.stringify(bundle));

  for (const [file, value] of Object.entries({
    'index.html': '<title>Help</title>',

    'latest.html': '<script src="./latest.js"></script>',
    'latest.js': 'void 0;'
  })) {
    await writeFile(path.join(resource, 'server/help/site', file), value);
  }

  await mkdir(path.join(resource, 'server/help/site/assets'), { recursive: true });
  await mkdir(path.join(resource, 'server/help/site/licenses'), { recursive: true });
  await writeFile(path.join(resource, 'server/help/site/assets/reader.js'), 'void 0;');
  await writeFile(path.join(resource, 'server/help/site/licenses/NOTICE.txt'), 'Fixture license');
  await makeReadOnlyTree(resource);

  const script = `#!${process.execPath}\n`
    + `const fs = require('node:fs');\n`
    + `fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`
    + `const value = process.argv.includes('--runtime-info') ? ${JSON.stringify(info)}\n`
    + ` : process.argv.includes('--prepare') ? ${JSON.stringify(prepared)} : {ok:true};\n`
    + `process.stdout.write(JSON.stringify(value) + '\\n');\n`;

  await writeFile(path.join(packaged, 'grigdesk-server'), script);
  await chmod(path.join(packaged, 'grigdesk-server'), 0o755);

  const inventory = {
    format: 1,
    kind: 'portable',
    version: '0.1.0',
    commit: content.commit,
    dirty: false,
    files: [{
      path: 'bin/grigdesk-server',
      mode: 0o755,
      size: Buffer.byteLength(script),
      sha256: wrongBinarySha ? 'e'.repeat(64) : sha256(script)
    }]
  };
  const inventoryText = JSON.stringify(inventory);

  await writeFile(path.join(packaged, 'bundle.json'), inventoryText);

  const archive = path.join(root, 'release.tar.gz');

  await execute('tar', ['-czf', archive, '-C', path.join(root, 'source'), 'release']);

  const bytes = await readFile(archive);

  return {
    root,
    resource,
    trace,
    bundle,
    expected: {
      version: '0.1.0',
      commit: content.commit,

      archiveSha256: sha256(bytes),
      bundleSha256: sha256(inventoryText)
    }
  };
}

test('HELP-R3: archive/bundle/binary mismatch не исполняют native', async (t) => {
  const box = await binaryRelease(t);

  await assert.rejects(() => prepareReleaseHelp(box.root, {
    ...box.expected, archiveSha256: '0'.repeat(64)
  }), /help_archive_changed/u);
  await assert.rejects(() => prepareReleaseHelp(box.root, {
    ...box.expected, bundleSha256: '0'.repeat(64)
  }), /help_bundle_mismatch/u);
  await assert.rejects(() => readFile(box.trace));

  const bad = await binaryRelease(t, true);

  await assert.rejects(() => prepareReleaseHelp(bad.root, bad.expected), /help_binary_mismatch/u);
  await assert.rejects(() => readFile(bad.trace));
});
test('HELP-R4: сайт взят из архива, native preparation освобождается при успехе и ошибке', async (t) => {
  const box = await binaryRelease(t);
  const prepared = await prepareReleaseHelp(box.root, box.expected);
  const emitted = await execute('tar', ['-xOf', prepared.archive, './help.json']);

  assert.deepEqual(JSON.parse(emitted.stdout), box.bundle);

  const unpack = path.join(box.root, 'public-unpack');

  await mkdir(unpack);
  await execute('tar', ['-xzf', prepared.archive, '-C', unpack]);

  for (const directory of [unpack, path.join(unpack, 'assets'), path.join(unpack, 'licenses')]) {
    assert.equal((await stat(directory)).mode & 0o777, 0o755);
  }

  for (const file of ['help.json', 'assets/reader.js', 'licenses/NOTICE.txt']) {
    assert.equal((await stat(path.join(unpack, file))).mode & 0o777, 0o644);
  }

  assert.equal((await stat(path.join(box.resource, 'server/help/site'))).mode & 0o777, 0o700);
  await prepared.dispose();
  assert.match(await readFile(box.trace, 'utf8'), /--release-preparation/u);
  await assert.rejects(() => readFile(prepared.archive));

  const broken = await binaryRelease(t, false, true);

  await assert.rejects(() => prepareReleaseHelp(broken.root, broken.expected), /help_site_mismatch/u);

  const calls = (await readFile(broken.trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(calls.filter((args) => args.includes('--release-preparation')).length, 1);
});
