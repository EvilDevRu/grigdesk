import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { PluginInstallService } from '../../server/src/lib/pluginInstall/service.ts';
import { PluginInstallStateStore } from '../../server/src/lib/pluginInstall/stateStore.ts';
import { createApplyFs } from '../../server/src/lib/pluginInstall/applyPackage.ts';
import { computePayloadDigest } from '../../server/src/lib/pluginInstall/payloadDigest.ts';
import { createApplyFixture } from './helpers/pluginApplyFixture.js';
import { runApplyChild } from './helpers/pluginApplyProcess.js';
import { versionSnapshot } from './helpers/pluginApplyFixture.js';

const policyUrl = new URL('../../server/src/lib/trackers/driverPackage.ts', import.meta.url);

/**
 * Существующая crash-фикстура получает driver payload и независимый журнал.
 * Identity и digest пересчитываются после замены файлов, resolver и IPC остаются настоящими.
 */
async function driverApplyFixture(t) {
  const fixture = await createApplyFixture(t, { kind: 'update', workInside: true });
  const oldRoot = fixture.roots.pluginsDir;
  const driversDir = path.join(fixture.root, 'drivers');

  await rename(oldRoot, driversDir);

  for (const key of ['current', 'previous', 'candidate', 'jobDir', 'transaction']) {
    fixture[key] = fixture[key].replace(oldRoot, driversDir);
  }

  fixture.roots.pluginsDir = driversDir;
  fixture.roots.workDir = fixture.roots.workDir.replace(oldRoot, driversDir);
  fixture.statePath = path.join(fixture.root, 'state/driver-installs.json');
  fixture.store = new PluginInstallStateStore({
    statePath: fixture.statePath,
    hasWorkEvidence: async () => true,
  });
  fixture.fs = createApplyFs(fixture.roots);

  for (const [directory, version] of [[fixture.current, '1.0.0'], [fixture.candidate, '1.1.0']]) {
    await rm(path.join(directory, 'plugin.json'));
    await rm(path.join(directory, 'server.js'));
    await writeFile(path.join(directory, 'driver.json'), JSON.stringify({
      id: 'demo',
      name: 'Драйвер',
      version,
      contract: 1,
      settings: {},
    }));
    await writeFile(path.join(directory, 'driver.ts'),
      'throw new Error("recovery must run before import");');
  }

  const base = fixture.intent.baseRecord;
  const target = fixture.intent.targetRecord;

  base.payloadDigest = await computePayloadDigest(fixture.current, []);
  target.payloadDigest = await computePayloadDigest(fixture.candidate, []);
  target.previous = versionSnapshot(base);
  fixture.intent.current = await fixture.fs.lstatIdentity(fixture.current, []);
  fixture.intent.candidate = await fixture.fs.lstatIdentity(fixture.candidate, []);
  fixture.state.plugins.demo = base;
  await writeFile(fixture.statePath, JSON.stringify(fixture.state));

  return fixture;
}

test('DRIVER-RECOVERY-01: crash после rename восстанавливает current/previous до import', async (t) => {
  let service;

  t.after(async () => {
    await service?.close();
  });

  const probe = await driverApplyFixture(t);
  const trace = await runApplyChild(probe);
  const renames = trace.trace.map((label, index) => ({ label, index }))
    .filter((entry) => entry.label === 'after:rename');
  const fixture = await driverApplyFixture(t);
  const pluginJournal = path.join(fixture.root, 'state/plugin-installs.json');

  await writeFile(pluginJournal, 'не менять');
  await runApplyChild(fixture, { barrierAt: renames[1].index });

  const packagePolicy = existsSync(policyUrl)
    ? (await import(policyUrl.href)).driverPackagePolicy
    : undefined;

  service = new PluginInstallService({
    pluginsDir: fixture.roots.pluginsDir,
    statePath: fixture.statePath,
    grigDeskVersion: '1.0.0',
    reservedIds: ['own'],
    packagePolicy,
  });

  assert.deepEqual((await service.recover()).blockedIds, []);
  assert.equal((await service.currentJob()).status, 'done');
  assert.equal((await service.store.read()).plugins.demo.version, '1.1.0');
  assert.equal(await readFile(path.join(fixture.current, 'marker.txt'), 'utf8'), 'new');
  assert.equal(await readFile(path.join(fixture.previous, 'marker.txt'), 'utf8'), 'old');
  assert.equal(await readFile(pluginJournal, 'utf8'), 'не менять');
  assert.deepEqual((await service.recover()).blockedIds, []);
  assert.equal((await service.store.read()).apply, null);
});
