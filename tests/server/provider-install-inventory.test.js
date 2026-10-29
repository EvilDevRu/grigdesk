import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { discoverExternalCli } from '../../server/src/lib/providerInstall/inventory.ts';
import { installFixture } from './helpers/providerInstallFixture.js';

const definition = {
  packageId: '@fixture/agent',
  binName: 'agent',
  configKey: 'agentBin',
  envKey: 'FIXTURE_AGENT_BIN',
};

/**
 * Все кандидаты живут в отдельной теме артефактов, а не в пользовательском HOME.
 * Тест не вызывает найденные CLI: происхождение выводится из файловых доказательств.
 */
async function fixture(t) {
  const base = path.join(artifactsPath({ env: process.env, home: os.homedir() }),
    'external-cli-lifecycle', 'inventory-tests');

  await fs.mkdir(base, { recursive: true });

  const root = await fs.mkdtemp(path.join(base, 'case-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  return root;
}

/**
 * Пакет имеет штатное global npm расположение и declared bin, включая битый entry.
 * ELF-заголовок позволяет проверить, что формат бинарника не подменяет происхождение.
 */
async function npmCopy(prefix, options = {}) {
  const root = path.join(prefix, 'lib/node_modules/@fixture/agent');
  const entry = path.join(root, 'bin/agent');
  const alias = path.join(prefix, 'bin/agent');

  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.mkdir(path.dirname(alias), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: options.name || definition.packageId,
    version: options.version || '1.2.3',
    bin: { agent: 'bin/agent' },
  }));

  if (!options.broken) {
    await fs.writeFile(entry, options.elf ? Buffer.from([0x7f, 0x45, 0x4c, 0x46])
      : '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    await fs.symlink(entry, alias);
  }

  return {
    root,
    entry,
    alias,
  };
}

const discover = (home, env, configuredBin = 'agent', extra = {}) => discoverExternalCli({
  providerId: 'fixture',
  definition: { ...definition, ...extra },
  home,
  env,
  configuredBin,
});

test('broken alias не скрывает identity явно выбранного рабочего package entry', async (t) => {
  const home = await fixture(t);
  const copy = await npmCopy(path.join(home, 'prefix'));

  await fs.unlink(copy.alias);

  const before = await discover(home, { PATH: path.dirname(copy.alias) }, copy.entry);

  assert.equal(before.installations[0].realpath, copy.entry);
  await fs.rename(copy.entry, copy.entry + '.old');
  await fs.writeFile(copy.entry, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const after = await discover(home, { PATH: path.dirname(copy.alias) }, copy.entry);

  assert.equal(after.installations[0].resourceKey, before.installations[0].resourceKey);
  assert.notEqual(after.selectedId, before.selectedId);
});

test('inventory объединяет aliases одного npm-пакета и находит отдельную nvm-копию', async (t) => {
  const home = await fixture(t);
  const first = await npmCopy(path.join(home, 'prefix'));
  const second = await npmCopy(path.join(home, '.nvm/versions/node/v24.1.0'));
  const local = path.join(home, '.local/bin/agent');

  await fs.mkdir(path.dirname(local), { recursive: true });
  await fs.symlink(first.entry, local);

  const inventory = await discover(home, { PATH: path.dirname(first.alias) }, local);

  assert.equal(inventory.installations.length, 2);

  const selected = inventory.installations.find((item) => item.installationId === inventory.selectedId);

  assert.equal(selected.root, first.root);
  assert.deepEqual(new Set(selected.aliases), new Set([local, first.alias]));
  assert.equal(inventory.selectedId, inventory.terminalId);
  assert.equal(inventory.conflict, false);
  assert.ok(inventory.installations.some((item) => item.root === second.root));
});

test('inventory обнаруживает broken пакет без entry и не считает ELF отдельным native', async (t) => {
  const home = await fixture(t);
  const broken = await npmCopy(path.join(home, 'broken'), { broken: true });
  const elf = await npmCopy(path.join(home, 'elf'), { elf: true });
  const inventory = await discover(home, {
    PATH: [path.dirname(broken.alias), path.dirname(elf.alias)].join(':'),
  });

  assert.equal(inventory.installations.length, 2);

  const packageWithoutEntry = inventory.installations.find((item) => item.root === broken.root);

  assert.equal(packageWithoutEntry.state, 'broken');
  assert.equal(packageWithoutEntry.version, '1.2.3');
  assert.equal(inventory.installations.find((item) => item.root === elf.root).source, 'npm');
  assert.equal(inventory.terminalId,
    inventory.installations.find((item) => item.root === elf.root).installationId);
});

test('inventory не принимает чужой package name и пользовательский wrapper за свой пакет', async (t) => {
  const home = await fixture(t);
  const foreign = await npmCopy(path.join(home, 'foreign'), { name: '@other/agent' });
  const wrapped = path.join(home, 'custom/agent');

  await fs.mkdir(path.dirname(wrapped), { recursive: true });
  await fs.writeFile(wrapped, '#!/bin/sh\ntouch should-not-run\n', { mode: 0o755 });

  const inventory = await discover(home, { PATH: path.dirname(foreign.alias) }, wrapped);

  assert.equal(inventory.installations.length, 2);
  assert.ok(inventory.installations.every((item) => item.source === 'unknown'));
  assert.equal(inventory.conflict, true);
  await assert.rejects(fs.stat(path.join(home, 'should-not-run')));
});

test('inventory различает отсутствующую bin-ссылку и declared bin за пределами пакета', async (t) => {
  const home = await fixture(t);
  const missingAlias = await npmCopy(path.join(home, 'missing-alias'));
  const escaped = await npmCopy(path.join(home, 'escaped'));
  const outside = path.join(home, 'unrelated');

  await fs.unlink(missingAlias.alias);
  await fs.writeFile(outside, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  await fs.unlink(escaped.entry);
  await fs.symlink(outside, escaped.entry);

  const inventory = await discover(home, {
    PATH: [path.dirname(missingAlias.alias), path.dirname(escaped.alias)].join(':'),
  });
  const broken = inventory.installations.find((item) => item.root === missingAlias.root);

  assert.ok(broken, 'метаданные пакета переживают удаление только bin-ссылки');
  assert.equal(broken.state, 'broken');
  assert.equal(inventory.installations.find((item) => item.path === escaped.alias).source, 'unknown');
});

test('inventory различает native и npm, а замена файла меняет CAS id без смены resource key', async (t) => {
  const home = await fixture(t);
  const copy = await npmCopy(path.join(home, 'prefix'));
  const native = path.join(home, 'native/agent');

  await fs.mkdir(path.dirname(native), { recursive: true });
  await fs.writeFile(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 });

  const args = { native: [{ entry: native, root: path.dirname(native) }] };
  const env = { PATH: path.dirname(copy.alias) };
  const first = await discover(home, env, native, args);
  const npmBefore = first.installations.find((item) => item.source === 'npm');

  assert.equal(first.installations.length, 2);
  assert.equal(first.conflict, true);
  assert.ok(first.installations.some((item) => item.source === 'native'));
  await fs.rename(copy.entry, copy.entry + '.old');
  await fs.writeFile(copy.entry, '#!/bin/sh\nexit 98\n', { mode: 0o755 });

  const second = await discover(home, env, native, args);
  const npmAfter = second.installations.find((item) => item.source === 'npm');

  assert.notEqual(npmBefore.installationId, npmAfter.installationId);
  assert.equal(npmBefore.resourceKey, npmAfter.resourceKey);
});

test('inventory только для opt-in; discovery не запускает installer', async (t) => {
  const home = await fixture(t);
  const copy = await npmCopy(path.join(home, 'prefix'));
  const { app, calls } = await installFixture(t, {
    env: { HOME: home, PATH: path.dirname(copy.alias) },
    provider: {
      externalCli: () => definition,
      bin: () => copy.alias,
      usagePresentation: { freshness: true, spentLabel: true },
    },
  });
  const response = await app.inject('/api/providers');
  const provider = response.json().providers[0];

  assert.equal(response.statusCode, 200);
  assert.ok(provider.installation.inventory);
  assert.equal(provider.installation.inventory.installations[0].root, copy.root);
  assert.deepEqual(provider.usagePresentation, { freshness: true, spentLabel: true });
  assert.equal(calls.commands.length, 0);
});

test('origin отличает доказанный внутренний prefix от пользовательской копии', async (t) => {
  const home = await fixture(t);
  const copy = await npmCopy(path.join(home, 'prefix'));
  const input = {
    providerId: 'fixture',
    definition,
    configuredBin: copy.alias,
    env: { PATH: path.dirname(copy.alias) },
    home,
  };
  const user = await discoverExternalCli(input);
  const legacy = await discoverExternalCli({ ...input, legacyRoots: [path.join(home, 'prefix')] });

  assert.equal(user.installations[0].origin, 'user');
  assert.equal(legacy.installations[0].origin, 'grigdesk');
});
