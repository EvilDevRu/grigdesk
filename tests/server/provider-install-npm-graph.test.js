import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sha256 } from '../../shared/node/hash.ts';
import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { inspectNpmGraph, assertReviewedNpmHooks } from '../../server/src/lib/providerInstall/npmGraph.ts';
import reviewed from '../../server/src/lib/providerInstall/npmReviewedHooks.json' with { type: 'json' };

/**
 * Подготовленный npm graph живёт только в scratch; неизвестный dependency hook не запускается.
 * Canary проверяет отказ раньше скриптов, а не удачное восстановление уже потерянного файла.
 */
async function fixture(t) {
  const base = path.join(artifactsPath({ env: process.env, home: os.homedir() }),
    'external-cli-lifecycle/graph-tests');

  await fs.mkdir(base, { recursive: true });

  const root = await fs.mkdtemp(path.join(base, 'case-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: '@fixture/cli',
    version: '1.0.0',
  }));

  return root;
}

/**
 * Проверенный профиль описывает искусственные хуки, которые тест никогда не запускает.
 * Новая версия меняет только manifest; реестр профилей восстанавливается после сценария.
 */
async function reviewedFixture(t, version = '1.0.1') {
  const root = await fixture(t);
  const files = {
    'scripts/postinstall.mjs': 'import "./postinstall/helper.mjs";\n',
    'scripts/postinstall/helper.mjs': 'export const reviewed = true;\n',
  };
  const profile = {
    name: '@fixture/reviewed-cli',
    reviewedVersion: '1.0.0',
    integrity: 'sha512-cmV2aWV3ZWQ=',
    lifecycle: { postinstall: 'node scripts/postinstall.mjs' },
    files: Object.fromEntries(Object.entries(files).map(([file, bytes]) => [file, sha256(bytes)])),
  };

  reviewed.push(profile);
  t.after(() => reviewed.splice(reviewed.indexOf(profile), 1));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: profile.name,
    version,
    scripts: profile.lifecycle,
  }));

  for (const [file, bytes] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), bytes);
  }

  return { root, profile };
}

test('graph включает transitive/optional package и отклоняет его неизвестный install hook', async (t) => {
  const root = await fixture(t);
  const dependency = path.join(root, 'node_modules/@fixture/nested');

  await fs.mkdir(dependency, { recursive: true });
  await fs.writeFile(path.join(dependency, 'package.json'), JSON.stringify({
    name: '@fixture/nested',
    version: '2.0.0',
    scripts: { install: 'node mutate-outside.js' },
  }));

  const graph = await inspectNpmGraph(root);

  assert.equal(graph.length, 2);
  await assert.rejects(assertReviewedNpmHooks(graph), { code: 'installer_strategy_unverified' });
});

test('implicit binding.gyp без объявленного install тоже не обходит gate', async (t) => {
  const root = await fixture(t);

  await fs.writeFile(path.join(root, 'binding.gyp'), '{}');
  await assert.rejects(assertReviewedNpmHooks(await inspectNpmGraph(root)),
    { code: 'installer_strategy_unverified' });
});

test('пакет без lifecycle и native build проходит gate, symlink dependency наружу отклоняется', async (t) => {
  const root = await fixture(t);

  await assertReviewedNpmHooks(await inspectNpmGraph(root));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.symlink(path.dirname(root), path.join(root, 'node_modules/escape'));
  await assert.rejects(inspectNpmGraph(root), { code: 'npm_graph_invalid' });
});

test('новая версия с побайтово теми же хуками проходит по профилю того же пакета', async (t) => {
  const { root } = await reviewedFixture(t);

  await assertReviewedNpmHooks(await inspectNpmGraph(root));
});

test('точный профиль проходит и сохраняет приоритет перед другими версиями', async (t) => {
  const { root, profile } = await reviewedFixture(t, '1.0.0');
  const other = { ...profile, reviewedVersion: '0.9.0' };

  reviewed.push(other);
  t.after(() => reviewed.splice(reviewed.indexOf(other), 1));
  await assertReviewedNpmHooks(await inspectNpmGraph(root));
  profile.files = { ...profile.files, 'scripts/postinstall.mjs': '0'.repeat(64) };
  await assert.rejects(assertReviewedNpmHooks(await inspectNpmGraph(root)),
    { code: 'installer_strategy_unverified' });
});

test('fallback перебирает профили одного имени до совпадения всех байтов', async (t) => {
  const { root, profile } = await reviewedFixture(t);
  const other = {
    ...profile,
    reviewedVersion: '0.9.0',
    files: { ...profile.files, 'scripts/postinstall.mjs': '0'.repeat(64) },
  };

  reviewed.unshift(other);
  t.after(() => reviewed.splice(reviewed.indexOf(other), 1));
  await assertReviewedNpmHooks(await inspectNpmGraph(root));
});

test('изменение одного байта вложенного hook-файла запрещает новую версию', async (t) => {
  const { root } = await reviewedFixture(t);

  await fs.writeFile(path.join(root, 'scripts/postinstall/helper.mjs'), 'export const reviewed = True;\n');
  await assert.rejects(assertReviewedNpmHooks(await inspectNpmGraph(root)),
    { code: 'installer_strategy_unverified' });
});

test('изменение lifecycle-команды запрещает новую версию при прежних файлах', async (t) => {
  const { root, profile } = await reviewedFixture(t);

  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: profile.name,
    version: '1.0.1',
    scripts: { postinstall: 'node scripts/postinstall.mjs --changed' },
  }));
  await assert.rejects(assertReviewedNpmHooks(await inspectNpmGraph(root)),
    { code: 'installer_strategy_unverified' });
});

test('дополнительная lifecycle-команда с новым файлом запрещает новую версию', async (t) => {
  const { root, profile } = await reviewedFixture(t);

  await fs.writeFile(path.join(root, 'preinstall.cjs'), '// новый hook\n');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: profile.name,
    version: '1.0.1',
    scripts: { ...profile.lifecycle, preinstall: 'node preinstall.cjs' },
  }));
  await assert.rejects(assertReviewedNpmHooks(await inspectNpmGraph(root)),
    { code: 'installer_strategy_unverified' });
});

test('добавленный hook-файл при прежних командах и хэшах запрещает новую версию', async (t) => {
  const { root } = await reviewedFixture(t);

  await fs.writeFile(path.join(root, 'scripts/postinstall/extra.mjs'), '// новый модуль\n');
  await assert.rejects(assertReviewedNpmHooks(await inspectNpmGraph(root)),
    { code: 'installer_strategy_unverified' });
});

test('новый binding.gyp не принимается по профилю без native build', async (t) => {
  const { root } = await reviewedFixture(t);

  await fs.writeFile(path.join(root, 'binding.gyp'), '{}');
  await assert.rejects(assertReviewedNpmHooks(await inspectNpmGraph(root)),
    { code: 'installer_strategy_unverified' });
});

test('отсутствующий hook-файл или ссылка вместо него не проходят fallback', async (t) => {
  for (const kind of ['missing', 'symlink']) {
    await t.test(kind, async (scenario) => {
      const { root } = await reviewedFixture(scenario);
      const file = path.join(root, 'scripts/postinstall/helper.mjs');

      await fs.unlink(file);

      if (kind === 'symlink') {
        await fs.symlink('../postinstall.mjs', file);
      }

      await assert.rejects(assertReviewedNpmHooks(await inspectNpmGraph(root)),
        { code: 'installer_strategy_unverified' });
    });
  }
});

test('совпадение байтов и команд другого пакета не даёт разрешения', async (t) => {
  const { root, profile } = await reviewedFixture(t);

  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: '@fixture/other-cli',
    version: '1.0.1',
    scripts: profile.lifecycle,
  }));
  await assert.rejects(assertReviewedNpmHooks(await inspectNpmGraph(root)),
    { code: 'installer_strategy_unverified' });
});
