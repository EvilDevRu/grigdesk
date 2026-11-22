import assert from 'node:assert/strict';
import { createHash, createPublicKey, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TestContext } from 'node:test';

import { signedIndex } from '../helpers/releaseV2Fixture.mjs';
import { canonicalJson } from '../../shared/lib/canonicalJson.ts';
import { releaseSignedBytes } from '../../shared/node/releaseTrust.ts';
import { loadInstalledModule } from '../helpers/installedBuildFixture.mjs';
import { HELP_LOCALES, helpResourceFile } from '../../shared/help/helpContracts.ts';

const execute = promisify(execFile);

/**
 * Архив help строится настоящим tar и удаляется вместе с текущей фикстурой.
 * Его содержимое используется командой публикации без подмены файловых эффектов.
 */
async function tarBytes(t: TestContext, directory: string): Promise<Buffer> {
  const output = path.join(path.dirname(directory), `help-site-${process.pid}.tar.gz`);

  await execute('tar', ['-czf', output, '-C', directory, '.']);
  t.after(() => fs.rm(output, { force: true }));

  return fs.readFile(output);
}

/**
 * Стенд повторяет корень сайта и staging выпуска; исполняется настоящая команда
 * публикации через bash. Никакого SSH: проверяются только filesystem-эффекты.
 */
async function publicationBox(t: TestContext, channel = 'release') {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-command-'));
  const root = path.join(temporary, 'site');
  const staging = path.join(temporary, 'staging');
  const version = '0.3.0';
  const helpFiles = HELP_LOCALES.map(helpResourceFile);
  const { installedPublicationCommand } = await loadInstalledModule(t,
    'tools/installedPublication.mts');

  await fs.mkdir(path.join(root, 'api/releases/v1'), { recursive: true, mode: 0o755 });
  await fs.mkdir(path.join(root, 'help'), { recursive: true, mode: 0o755 });
  await fs.writeFile(path.join(root, 'api/releases/v1', `${channel}.json`), 'старый индекс\n');

  /**
   * Каждая попытка получает заново подготовленный staging с теми же байтами выпуска.
   * Это проверяет повтор транзакции, не повторяя результат предыдущего исполнения.
   */
  const buildStaging = async () => {
    const helpDir = path.join(staging, 'help');

    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(helpDir, { recursive: true, mode: 0o755 });

    for (const name of ['index.html', 'latest.html', 'latest.js', ...helpFiles]) {
      await fs.writeFile(path.join(helpDir, name), `помощь ${name}\n`);
    }

    await fs.writeFile(path.join(staging, 'help-site.tar.gz'), await tarBytes(t, helpDir));
    await fs.writeFile(path.join(staging, `${channel}.json`), 'новый индекс\n');
    await fs.writeFile(path.join(staging, 'desktop.tar.gz'), 'desktop-архив\n');
    await fs.writeFile(path.join(staging, 'server.tar.gz'), 'server-архив\n');
    await fs.writeFile(path.join(staging, 'control.tar.gz'), 'control-архив\n');
    await fs.writeFile(path.join(staging, 'grigdesk-install'), '#!/bin/sh\nexit 0\n');
    await fs.writeFile(path.join(staging, 'grigdesk-maintenance.gz'), 'helper-архив\n');
    await fs.writeFile(path.join(staging, 'grigdesk-install.sha256'), 'proof\n');
    await fs.writeFile(path.join(staging, 'grigdesk-install.sig'), 'signature\n');
  };

  t.after(() => fs.rm(temporary, { recursive: true, force: true }));

  return {
    root,
    staging,
    version,
    channel,
    helpFiles,
    buildStaging,
    command: (expectedActiveIndex?: string | null) => installedPublicationCommand({
      root,
      staging,
      version,
      channel,
      expectedActiveIndex,
      expectedSHA: { 'control.tar.gz': createHash('sha256').update('control-архив\n').digest('hex') },
    }),
  };
}

test('PUBCMD-REPEAT: успешная публикация и повтор идемпотентны', async (t) => {
  const box = await publicationBox(t);

  await box.buildStaging();
  await execute('bash', ['-c', box.command()]);

  const index = path.join(box.root, 'api/releases/v1', `${box.channel}.json`);

  assert.equal(await fs.readFile(index, 'utf8'), 'новый индекс\n');
  await assert.rejects(fs.stat(box.staging), { code: 'ENOENT' });

  await box.buildStaging();
  await execute('bash', ['-c', box.command()]);
  assert.equal(await fs.readFile(index, 'utf8'), 'новый индекс\n');
  assert.ok(await fs.stat(path.join(box.root, 'releases', box.version)).then(() => true));
});

test('PUBCMD-ABORT-KEEPS-INDEX: сбой до переключения сохраняет прежний индекс', async (t) => {
  const box = await publicationBox(t);
  const published = path.join(box.root, 'help', box.version);

  await box.buildStaging();
  await fs.mkdir(published, { recursive: true, mode: 0o755 });

  for (const name of ['index.html', 'latest.html', 'latest.js', ...box.helpFiles]) {
    await fs.writeFile(path.join(published, name), `прежняя помощь ${name}\n`);
  }

  await fs.writeFile(path.join(published, box.helpFiles[0]!), 'другое содержимое\n');

  await assert.rejects(execute('bash', ['-c', box.command()]));
  assert.equal(await fs.readFile(path.join(box.root, 'api/releases/v1', `${box.channel}.json`),
    'utf8'), 'старый индекс\n');
  assert.ok(await fs.stat(path.join(box.root, 'releases', box.version)).then(() => true));
});

test('PUBCMD-HELPER-CHANGED: другой helper при той же версии отвергается', async (t) => {
  const box = await publicationBox(t);

  await box.buildStaging();
  await execute('bash', ['-c', box.command()]);

  await box.buildStaging();
  await fs.writeFile(path.join(box.staging, 'grigdesk-install'), '#!/bin/sh\nexit 3\n');
  await fs.writeFile(path.join(box.staging, 'grigdesk-install.sha256'), 'proof2\n');
  await fs.writeFile(path.join(box.staging, 'grigdesk-install.sig'), 'signature2\n');

  await assert.rejects(execute('bash', ['-c', box.command()]));
  assert.equal(await fs.readFile(path.join(box.root, 'api/releases/v1', `${box.channel}.json`),
    'utf8'), 'новый индекс\n');
});

/**
 * Retention действует отдельно по каналу и только для лёгких выпусков.
 * Текущий выпуск сохраняется независимо от времени, исторический ELF исключён.
 */
test('PUBCMD-RETENTION: текущая, предыдущая и история сохраняются', async (t) => {
  const box = await publicationBox(t);

  for (const [version, channel, lightweight, age] of [
    ['0.1.0', 'release', false, 40],
    ['0.2.0', 'release', true, 30],
    ['0.2.1', 'release', true, 20],
    ['0.2.2', 'release', true, 10],
    ['0.3.0-dev.1', 'dev', true, 50],
  ] as const) {
    const release = path.join(box.root, 'releases', version);
    const help = path.join(box.root, 'help', version);

    await fs.mkdir(release, { recursive: true });
    await fs.mkdir(help, { recursive: true });
    await fs.writeFile(path.join(release, `${channel}.json`), 'индекс');

    if (lightweight) {
      await fs.writeFile(path.join(release, 'grigdesk-maintenance.gz'), 'helper');
    }

    const published = new Date(Date.now() - age * 86400_000);

    await fs.utimes(path.join(release, `${channel}.json`), published, published);
  }

  await box.buildStaging();

  const output = await execute('bash', ['-c', box.command()]);

  assert.deepEqual((await fs.readdir(path.join(box.root, 'releases'))).sort(),
    ['0.1.0', '0.2.2', '0.3.0', '0.3.0-dev.1']);
  assert.match(output.stdout, /Удалено:/u);
  await assert.rejects(fs.stat(path.join(box.root, 'help/0.2.0')), { code: 'ENOENT' });
});

/**
 * Дисковая проба выполняется до создания staging для загрузки.
 * Старый мусор удаляется, свежий staging и исторические выпуски остаются.
 */
test('PUBCMD-PREFLIGHT: низкий df блокирует загрузку, старый staging удалён', async (t) => {
  const box = await publicationBox(t);
  const stale = path.join(box.root, '.grigdesk-publish-old');
  const fresh = path.join(box.root, '.grigdesk-publish-fresh');
  const bins = path.join(box.root, 'bin');

  await fs.mkdir(stale);
  await fs.mkdir(fresh);
  await fs.mkdir(bins);

  const old = new Date(Date.now() - 9 * 86400_000);

  await fs.utimes(stale, old, old);
  await fs.writeFile(path.join(bins, 'df'),
    '#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available ' +
      'Capacity Mounted on\\n/dev/f 100 99 1 99%% /\\n"\n',
    { mode: 0o755 });

  const { installedPublicationPreflight } = await loadInstalledModule(t,
    'tools/installedPublication.mts');
  const command = installedPublicationPreflight(box.root, box.staging, 2048);

  await assert.rejects(execute('bash', ['-c', command], {
    env: { PATH: bins + ':/usr/bin:/bin' },
  }), /Недостаточно места/u);
  await assert.rejects(fs.stat(box.staging), { code: 'ENOENT' });
  await assert.rejects(fs.stat(stale), { code: 'ENOENT' });
  assert.ok((await fs.stat(fresh)).isDirectory());
});

test('PUBCMD-CONTROL: пропажа и подмена control сохраняют канал до полного read-back', async (t) => {
  const box = await publicationBox(t);
  const index = path.join(box.root, 'api/releases/v1', `${box.channel}.json`);
  const control = path.join(box.staging, 'control.tar.gz');

  await box.buildStaging();
  await fs.rm(control);
  await assert.rejects(execute('bash', ['-c', box.command()]));
  assert.equal(await fs.readFile(index, 'utf8'), 'старый индекс\n');

  await box.buildStaging();
  await fs.writeFile(control, 'control-архив!\n');
  await assert.rejects(execute('bash', ['-c', box.command()]));
  assert.equal(await fs.readFile(index, 'utf8'), 'старый индекс\n');

  await box.buildStaging();
  await execute('bash', ['-c', box.command()]);
  assert.equal(await fs.readFile(index, 'utf8'), 'новый индекс\n');
  assert.equal(await fs.readFile(path.join(box.root, 'releases', box.version, 'control.tar.gz'), 'utf8'),
    'control-архив\n');
});

test('PUBCMD-ACTIVE-CAS: более свежий индекс после preflight оставляет сайт без изменений', async (t) => {
  const box = await publicationBox(t);
  const current = path.join(box.root, 'api/releases/v1/release.json');
  const latestHelp = path.join(box.root, 'help/latest-release.html');
  const a = signedIndex({ version: '0.2.0' });
  const keys = { privateKey: a.privateKey, publicKey: createPublicKey(a.privateKey) };
  const b = signedIndex({ version: '0.2.1', keys });
  const next = signedIndex({ version: box.version, keys });
  const aBytes = JSON.stringify(a.index);
  const bBytes = JSON.stringify(b.index);
  const nextBytes = JSON.stringify(next.index);

  await fs.writeFile(current, aBytes);
  await fs.writeFile(latestHelp, 'справка B');
  await box.buildStaging();
  await fs.writeFile(path.join(box.staging, 'release.json'), nextBytes);

  const stale = box.command(createHash('sha256').update(aBytes).digest('hex'));

  await fs.writeFile(current, bBytes);
  await assert.rejects(execute('bash', ['-c', stale]), (error: { code: number; stderr: string }) => {
    assert.equal(error.code, 3);
    assert.match(error.stderr, /release_active_index_changed/u);

    return true;
  });

  assert.equal(await fs.readFile(current, 'utf8'), bBytes);
  assert.equal(await fs.readFile(latestHelp, 'utf8'), 'справка B');

  const currentCommand = box.command(createHash('sha256').update(bBytes).digest('hex'));

  await execute('bash', ['-c', currentCommand]);
  assert.equal(await fs.readFile(current, 'utf8'), nextBytes);
});

test('PUBCMD-READ-ACTIVE: подписанный индекс сверяется до допуска новой версии', async (t) => {
  const { activeStableIndex } = await loadInstalledModule(t, 'tools/installedPublication.mts');
  const older = signedIndex({ version: '1.2.3' });
  const keys = { privateKey: older.privateKey, publicKey: createPublicKey(older.privateKey) };
  const current = signedIndex({ version: '1.2.4', keys });
  const exact = current.index.latest;
  const bytes = Buffer.from(JSON.stringify(current.index));

  assert.equal(activeStableIndex(null, exact, current.publicKeyPem), null);
  assert.equal(activeStableIndex(bytes, exact, current.publicKeyPem),
    createHash('sha256').update(bytes).digest('hex'));
  assert.throws(() => activeStableIndex(bytes, older.index.latest, current.publicKeyPem),
    /release_site_downgrade_forbidden/u);

  const payload = { ...exact.payload, notes: { ru: 'Другой выпуск', en: 'Different release' } };
  const different = { payload, signature: '' };

  different.signature = sign(null, releaseSignedBytes(different), keys.privateKey).toString('base64');

  const conflicting = Buffer.from(canonicalJson({ ...current.index, latest: different }));

  assert.throws(() => activeStableIndex(conflicting, exact, current.publicKeyPem),
    /release_site_version_conflict/u);
});
