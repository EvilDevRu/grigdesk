import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { inspectNpmGraph, assertReviewedNpmHooks } from '../../server/src/lib/providerInstall/npmGraph.ts';

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
