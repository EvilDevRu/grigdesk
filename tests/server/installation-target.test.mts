import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPublicKey } from 'node:crypto';
import type { TestContext } from 'node:test';

import { installedRelease } from '../helpers/installedUpdateFixture.mjs';
import { loadInstalledModule } from '../helpers/installedBuildFixture.mjs';
import { signedMacIndex } from '../helpers/releaseV2Fixture.mjs';
import { publishInstallFile, readInstallPublication } from '../../shared/node/installedLayout.ts';

test('INSTALL-MAC-PLATFORM: несовместимый хост не запрашивает архивы', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const fixture = signedMacIndex();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-other-platform-'));
  const root = path.join(directory, 'program');
  const { installRelease } = await loadInstalledModule(t, 'tests/fixtures/release-v2/installRelease.mts',
    fixture.publicKeyPem);
  let archives = 0;

  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(installRelease({
    mode: 'remote',
    root,
    dataHome: path.join(directory, 'data'),
    userData: path.join(directory, 'profile'),
    binDirectory: path.join(directory, 'bin'),
    applicationsDirectory: path.join(directory, 'Applications'),
    envelope: fixture.envelope,
    maintenance: path.join(directory, 'unavailable-helper'),
    archive: async () => {
      archives += 1;

      return '';
    },
  }), /release_platform_incompatible/u);
  assert.equal(archives, 0);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('INSTALL-DURABLE-PUBLICATION: совпавший повтор и конкурент не заменяют inode', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-install-publication-'));
  const file = path.join(directory, 'intent.json');

  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await publishInstallFile(file, '{"format":1}\n', 0o600);

  const original = await fs.stat(file);

  await publishInstallFile(file, '{"format":1}\n', 0o600);
  await assert.rejects(publishInstallFile(file, '{"format":2}\n', 0o600),
    /installation_incomplete_conflict/u);
  assert.deepEqual(await readInstallPublication(file), { format: 1 });
  assert.equal((await fs.stat(file)).ino, original.ino);
  assert.deepEqual(await fs.readdir(directory), ['intent.json']);
});

/**
 * Настоящие signed tar и installRelease используют только отдельный временный root.
 * Подменяется pinned test key, а подпись, распаковка и запись программы остаются настоящими.
 */
async function makeInstallInput(t: TestContext, mode: 'remote' | 'server', candidate = false) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'first-install-'));
  const release = installedRelease();
  const contractsFile = 'shared/runtime/releaseChannelContracts.ts';
  const contracts = candidate ? await fs.readFile(path.resolve(import.meta.dirname, '../..', contractsFile),
    'utf8') : '';
  const stubs = candidate ? {
    [contractsFile]: contracts.replace(/export const RELEASE_SIGNING_PUBLIC_KEY = [^;]+;/u,
      `export const RELEASE_SIGNING_PUBLIC_KEY = ${JSON.stringify(release.publicKeyPem)};`)
      .replace("ReleaseDistributionSource = 'channel';", "ReleaseDistributionSource = 'candidate-file';"),
  } : {};
  const { installRelease } = await loadInstalledModule(t, 'tests/fixtures/release-v2/installRelease.mts',
    release.publicKeyPem, stubs);
  const maintenance = path.join(temporary, 'maintenance');
  const archives = new Map<string, string>();

  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.writeFile(maintenance, '#!/bin/sh\nexit 0\n', { mode: 0o700 });

  for (const component of ['desktop', 'server'] as const) {
    const file = path.join(temporary, `${component}.tar.gz`);
    const bytes = release.archives.get(release.envelope.payload.artifacts[component].url);

    assert.ok(bytes);
    await fs.writeFile(file, bytes, { mode: 0o600 });
    archives.set(component, file);
  }

  return {
    installRelease,
    keys: { privateKey: release.privateKey, publicKey: createPublicKey(release.privateKey) },
    input: {
      root: path.join(temporary, 'program'),
      mode,
      dataHome: path.join(temporary, 'data'),
      userData: path.join(temporary, 'user'),
      binDirectory: path.join(temporary, 'bin'),
      applicationsDirectory: path.join(temporary, 'applications'),
      envelope: release.envelope,
      maintenance,
      async archive(component: 'desktop' | 'server') {
        const file = archives.get(component);

        assert.ok(file);

        return file;
      },
    },
  };
}

test('INSTALL-FOREIGN: папка без receipt не удаляется', async (t) => {
  const box = await makeInstallInput(t, 'remote');

  await fs.mkdir(box.input.root, { mode: 0o700 });

  const sentinel = path.join(box.input.root, 'my-project.txt');

  await fs.writeFile(sentinel, 'не файл установщика\n');

  await assert.rejects(box.installRelease(box.input), /installation_target_not_empty/);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'не файл установщика\n');
  await assert.rejects(fs.stat(path.join(box.input.root, 'current.json')), { code: 'ENOENT' });
});

test('INSTALL-LATE-CURRENT: сбой интеграции не публикует current', async (t) => {
  const box = await makeInstallInput(t, 'remote');
  const input = {
    ...box.input,
    async archive(component: 'desktop' | 'server') {
      await fs.writeFile(box.input.applicationsDirectory, 'блокировка\n');

      return box.input.archive(component);
    },
  };

  await assert.rejects(box.installRelease(input));
  await assert.rejects(fs.stat(path.join(box.input.root, 'current.json')), { code: 'ENOENT' });
  assert.ok(await fs.stat(path.join(box.input.root, 'installation.json')).then(() => true));
});

test('INSTALL-PARALLEL: два установщика одного root сериализованы', async (t) => {
  const box = await makeInstallInput(t, 'remote');
  let openBarrier: (() => void) | null = null;
  const barrier = new Promise<void>((resolve) => {
    openBarrier = resolve;
  });
  let entered: (() => void) | undefined;
  const atArchive = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const slowInput = {
    ...box.input,
    async archive(component: 'desktop' | 'server') {
      if (component === 'desktop') {
        entered!();
        await barrier;
      }

      return box.input.archive(component);
    },
  };
  const first = box.installRelease(slowInput);

  await atArchive;

  const second = box.installRelease(box.input);
  let secondDone = false;

  second.then(() => {
    secondDone = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(secondDone, false, 'второй установщик не ждал sibling lock');

  openBarrier!();

  const [firstReceipt, secondReceipt] = await Promise.all([first, second]);
  const pointer = JSON.parse(await fs.readFile(path.join(box.input.root, 'current.json'),
    'utf8'));

  assert.equal(secondReceipt.installationId, firstReceipt.installationId);
  assert.equal(pointer.installationId, firstReceipt.installationId);
});

test('INSTALL-COMPLETED-REPEAT: повтор завершённой установки сохраняет данные', async (t) => {
  const box = await makeInstallInput(t, 'remote');
  const first = await box.installRelease(box.input);
  const sentinel = path.join(box.input.dataHome, 'user-file.txt');

  await fs.mkdir(box.input.dataHome, { recursive: true, mode: 0o700 });
  await fs.writeFile(sentinel, 'данные пользователя\n', { mode: 0o600 });

  const second = await box.installRelease(box.input);

  assert.equal(second.installationId, first.installationId);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'данные пользователя\n');
});

test('INSTALL-LEGACY-HELPER: существующая установка готовит обновление, helper не заменяется', async (t) => {
  const box = await makeInstallInput(t, 'remote');

  await box.installRelease(box.input);

  const legacyHelper = path.join(box.input.root, 'update/maintenance');
  const legacyBytes = await fs.readFile(legacyHelper);
  const upgraded = installedRelease({ version: '9.9.9', keys: box.keys });
  const archives = new Map<string, string>();

  for (const component of ['desktop', 'server'] as const) {
    const file = path.join(box.input.root, 'incoming', `${component}.tar.gz`);

    archives.set(component, file);
  }

  await fs.mkdir(path.join(box.input.root, 'incoming'), { mode: 0o700 });

  for (const [component, file] of archives) {
    const url = upgraded.envelope.payload.artifacts[component as 'desktop' | 'server'].url;

    await fs.writeFile(file, upgraded.archives.get(url)!);
  }

  const { installRelease } = await loadInstalledModule(t, 'tests/fixtures/release-v2/installRelease.mts',
    upgraded.publicKeyPem);

  const receipt = await installRelease({
    ...box.input,
    envelope: upgraded.envelope,
    async archive(component: 'desktop' | 'server') {
      return archives.get(component)!;
    },
  });

  const updateRoot = path.join(box.input.root, 'update');
  const jobs = (await fs.readdir(updateRoot)).filter((name) =>
    /^[a-f0-9-]{36}$/u.test(name));

  assert.equal(receipt.installationId,
    JSON.parse(await fs.readFile(path.join(box.input.root, 'installation.json'),
      'utf8')).installationId);
  assert.ok(jobs.length >= 1);
  assert.equal(await fs.readFile(legacyHelper, 'utf8'), legacyBytes.toString('utf8'));
});

test('INSTALL-OFFLINE-RETRY: тот же B повторяет задачу и оставляет A текущим', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const box = await makeInstallInput(t, 'remote', true);
  const first = await box.installRelease(box.input);
  const root = box.input.root;
  const current = path.join(root, 'current.json');
  const before = await fs.readFile(current);
  const candidate = installedRelease({ version: '9.9.9', keys: box.keys });
  const { installRelease: channelInstaller } = await loadInstalledModule(t,
    'tests/fixtures/release-v2/installRelease.mts',
    candidate.publicKeyPem);
  const input = { ...box.input, envelope: candidate.envelope };

  assert.equal(first.format, 2);
  assert.equal(first.source, 'candidate-file');
  await assert.rejects(channelInstaller(input), /installation_release_trust_mismatch/u);
  await assert.rejects(fs.readFile(path.join(root, 'update/job.json')), { code: 'ENOENT' });
  await assert.rejects(box.installRelease({
    ...input,
    archive: async () => {
      throw new Error('fixture_archive_interrupted');
    },
  }), /fixture_archive_interrupted/u);

  const jobFile = path.join(root, 'update/job.json');
  const failed = JSON.parse(await fs.readFile(jobFile, 'utf8'));
  const ownedArchive = path.join(root, 'update', failed.id, 'desktop.tar.gz');
  const source = path.join(path.dirname(root), 'candidate-desktop.tar.gz');

  await fs.writeFile(ownedArchive, 'частичный архив', { mode: 0o600 });
  await fs.writeFile(source, candidate.archives.get(candidate.envelope.payload.artifacts.desktop.url)!,
    { mode: 0o600 });
  await box.installRelease({ ...input, archive: async () => source });

  const ready = JSON.parse(await fs.readFile(jobFile, 'utf8'));

  assert.equal(ready.id, failed.id);
  assert.equal(ready.stage, 'ready');
  assert.deepEqual(await fs.readFile(current), before);
});

test('INSTALL-ROOT-REJECTED: корневой путь отвергается до эффектов', async (t) => {
  const box = await makeInstallInput(t, 'remote');

  await assert.rejects(box.installRelease({ ...box.input, root: '/' }),
    /installation_input_invalid/u);
  await assert.rejects(box.installRelease({ ...box.input, dataHome: box.input.root }),
    /installation_input_invalid/u);
});

/**
 * Ссылка в существующем предке отклоняется до записи lock и root.
 * Папка назначения ссылки остаётся пустой, включая при отказе установки.
 */
test('INSTALL-SYMLINK-PARENT: чужое физическое место не получает запись', async (t) => {
  const box = await makeInstallInput(t, 'remote');
  const parent = path.dirname(box.input.root);
  const outside = path.join(parent, 'outside');
  const link = path.join(parent, 'alias');

  await fs.mkdir(outside);
  await fs.symlink(outside, link);
  await assert.rejects(box.installRelease({ ...box.input, root: path.join(link, 'program') }),
    /installation_path_invalid/u);
  assert.deepEqual(await fs.readdir(outside), []);
});
