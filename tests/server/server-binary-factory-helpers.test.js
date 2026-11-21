import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildHelper, loadHelpers } from '../../server/scripts/sea/helpers.mts';
import { stageFactoryCandidate } from '../../server/scripts/binary/factoryCandidate.mts';
import { testFactoryBinary } from '../helpers/factoryBinary.mjs';

const SOURCE = fileURLToPath(new URL('../../', import.meta.url));
const MANIFEST = path.join(SOURCE, 'server/build/helpers.json');

test('SB08: runtime-info, runner и status MCP зарегистрированы с явным entry', async () => {
  const catalog = await loadHelpers(MANIFEST, SOURCE);

  for (const [id, kind] of [
    ['deepseek-runtime-info', 'script'], ['deepseek-runner', 'main'], ['factory-status-mcp', 'script'],
    ['factory-browser', 'main'],
  ]) {
    assert.equal(catalog.helpers.find((helper) => helper.id === id)?.entryKind, kind, id);
  }

  assert.deepEqual(catalog.helpers.find((helper) => helper.id === 'factory-browser').exports, ['main']);

  assert.ok(catalog.helpers.find((helper) => helper.id === 'deepseek-runner').exports
    .includes('runDeepSeekFactory'));
});

// К7: отдельный helper перемещается вместе с Node/engine и работает без server sources.
test('stage-model-helper-relocated', { timeout: 20_000 }, async (t) => {
  const catalog = await loadHelpers(MANIFEST, SOURCE);
  const entry = catalog.helpers.find((helper) => helper.id === 'factory-runner-models');

  assert.ok(entry, 'metadata helper должен обнаруживаться в поставке');

  const { codexModelFixture } = await import('../helpers/factoryStageModelMetadata.mjs');
  const fx = await codexModelFixture(t);
  const root = path.join(fx.root, 'relocated runtime with spaces');
  const helpers = path.join(root, 'server/runtime/helpers');

  await fs.mkdir(helpers, { recursive: true });
  await fs.mkdir(path.join(root, 'runtime/node/bin'), { recursive: true });
  await fs.symlink(process.execPath, path.join(root, 'runtime/node/bin/node'));
  // npm-пакеты внешние и в настоящем payload лежат рядом с сервером.
  // Как в metadata-фикстуре выше, подключаем зависимости отдельно от server sources.
  await fs.symlink(path.join(SOURCE, 'server/node_modules'), path.join(root, 'server/node_modules'));
  await fs.writeFile(path.join(helpers, 'helpers.json'), await fs.readFile(MANIFEST));
  await stageFactoryCandidate({
    root,
    binary: testFactoryBinary(),
    profileAbi: path.join(SOURCE, 'engine/lib/delivery_contract.py'),
    os: process.platform,
    arch: process.arch,
  });

  const built = await buildHelper({
    root: SOURCE,
    manifest: catalog,
    id: entry.id,
    outDir: helpers,
    workDir: path.join(fx.root, 'helper-build'),
  });

  const native = execFileSync(process.execPath, [built.file, 'codex', '--native', fx.binary], {
    env: fx.env,
    encoding: 'utf8',
    timeout: 10_000,
  });

  assert.deepEqual(JSON.parse(native).models.map((model) => model.id), fx.native.map((model) => model.id));
  await assert.rejects(fs.stat(path.join(root, 'server/src')), { code: 'ENOENT' });
  assert.equal((await fx.methods()).some((method) => /^(thread|turn)\//.test(method)), false);
});
