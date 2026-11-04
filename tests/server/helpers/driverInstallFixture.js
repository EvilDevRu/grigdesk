import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PluginInstallService } from '../../../server/src/lib/packageInstall/service.ts';
import { createPluginRepo, git } from './pluginRepo.js';

const policyUrl = new URL('../../../server/src/lib/trackers/driverPackage.ts', import.meta.url);

/**
 * Репозиторий содержит только driver.json, без совместимого plugin.json.
 * Поэтому исходный installer отвергает настоящий пакет по ожидаемой причине manifest_missing.
 */
export async function driverRepo(t, { id = 'fixture-driver', manifest = {} } = {}) {
  const repo = await createPluginRepo(t);

  /**
   * Тег указывает на зафиксированную версию настоящего тестового driver package.
   * Git работает только внутри временного репозитория фикстуры.
   */
  const release = async (version, files = {}) => {
    await writeFile(path.join(repo.work, 'driver.json'), JSON.stringify({
      id,
      name: 'Тестовый трекер',
      version,
      contract: 1,
      settings: {},
      ...manifest,
    }));
    await writeFile(path.join(repo.work, 'driver.ts'), 'throw new Error("package imported during install");');

    for (const [file, body] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(repo.work, file)), { recursive: true });
      await writeFile(path.join(repo.work, file), body);
    }

    await git(repo.work, 'add', '-A');
    await git(repo.work, 'commit', '-qm', `driver ${version}`);
    await git(repo.work, 'tag', `v${version}`);
    await git(repo.work, 'push', '-q', 'origin', 'main', '--tags');

    return git(repo.work, 'rev-parse', 'HEAD');
  };

  return {
    ...repo,
    id,
    release
  };
}

/**
 * Production package policy подключается к существующему installer без копии его алгоритмов.
 * До реализации новая option отсутствует: сервис выполняет прежнюю проверку plugin package.
 */
export async function driverInstallFixture(t, { root: supplied, bind = true } = {}) {
  const root = supplied ?? await mkdtemp(path.join(os.tmpdir(), 'grigdesk-driver-install-'));
  const driversDir = path.join(root, 'drivers');
  const statePath = path.join(root, 'state/driver-installs.json');
  const pluginStatePath = path.join(root, 'state/plugin-installs.json');
  const packagePolicy = existsSync(policyUrl)
    ? (await import(policyUrl.href)).driverPackagePolicy
    : undefined;
  const service = new PluginInstallService({
    pluginsDir: driversDir,
    statePath,
    grigDeskVersion: '1.0.0',
    reservedIds: ['own'],
    packagePolicy,
  });
  const leases = [];

  await mkdir(driversDir, { recursive: true });
  await mkdir(path.dirname(pluginStatePath), { recursive: true });

  if (!existsSync(pluginStatePath)) {
    await writeFile(pluginStatePath, '{"fixture":"plugin journal unchanged"}');
  }

  if (bind) {
    service.bindRuntime({
      isLoaded: () => false,
      prepareReplace: async () => ({ finish: async (outcome) => leases.push(outcome) }),
      refresh: async () => {},
    });
  }

  await service.recover();
  t.after(async () => {
    await service.close();

    if (!supplied) {
      await rm(root, { recursive: true, force: true });
    }
  });

  return {
    root,
    driversDir,
    statePath,
    pluginStatePath,
    service,
    leases
  };
}

/**
 * Проверяем именно результат подготовки полного сервиса, а не наличие будущего export.
 * Этот assertion даёт исходный RED с manifest_missing для валидного driver.json.
 */
export async function prepareDriver(service, url, version = '1.0.0') {
  await service.startInstall({ url, version });
  await service.whenIdle();

  const ready = await service.currentJob();

  assert.equal(ready.status, 'ready', JSON.stringify(ready.error));

  return ready;
}

/**
 * Снимок читается из журнала того же service instance, который выполнял эффект.
 * Старое внутреннее поле plugins сохраняется по плану, отдельно от plugin journal.
 */
export async function driverRecord(fixture, id = 'fixture-driver') {
  return JSON.parse(await readFile(fixture.statePath, 'utf8')).plugins[id];
}
