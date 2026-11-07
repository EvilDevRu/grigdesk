import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { assertReleasePublishContract } from '../../server/src/lib/grigDeskRelease.ts';
import { glmCompatibilityIdentity } from '../../server/src/lib/glm/contract.ts';
import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';
import { writeDeepSeekBinaryStub } from '../helpers/deepseekBinaryStub.mts';
import { sha256File } from '../../shared/node/hash.ts';
import { fixtureRepository, git, queueJob } from '../helpers/grigdeskUpdateRepository.mts';
import { readPersistentState } from '../../server/src/lib/grigDeskRelease.ts';
import { legacyRuntimeContract } from '../fixtures/deepseek-harness/legacyPublishContract.mjs';
import { resolveDeepSeekRuntimeAsync } from '../../server/src/lib/deepseek/runtimeProcess.ts';
import { deepSeekDistributionMode, usesDeepSeekBinary } from '../../server/src/lib/deepseek/distribution.ts';

const run = promisify(execFile);
const worker = fileURLToPath(new URL('../../server/src/workers/grigdesk-update-worker.js', import.meta.url));

/**
 * Установленный host и целевые требования принадлежат разным disposable каталогам.
 * Runtime stub разрешён для updater и не подменяет будущий тест независимой замены ELF.
 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'binary-update-'));
  const target = path.join(root, 'target');
  const info = runtimeInfoFixture();

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  info.glm.admission[0].compatibility = glmCompatibilityIdentity(info.glm.inputs, 'api');
  await fs.mkdir(path.join(target, 'server'), { recursive: true });
  await fs.writeFile(path.join(target, 'server/deepseek-runtime-contract.json'), JSON.stringify({
    format: 1,
    publishContract: 2,
    mode: 'binary',
  }));
  await fs.copyFile(new URL('../../server/deepseek-host-contract.json', import.meta.url),
    path.join(target, 'server/deepseek-host-contract.json'));

  const { binary } = await writeDeepSeekBinaryStub(t, `
const info = ${JSON.stringify(info)};
if (process.argv.includes('--runtime-info')) console.log(JSON.stringify(info));
else if (process.argv.includes('--verify')) console.log(JSON.stringify({
  ...info, verified:true, glmPlugin:true,
}));
else process.exitCode = 9;
`);

  return {
    root,
    target,
    binary,
    info,
  };
}

test('contract 2 принимает установленный binary без generation в target и не меняет его bytes', async (t) => {
  const { target, binary } = await fixture(t);
  const before = await sha256File(binary);

  await assertReleasePublishContract(target, '2', { binary });
  assert.equal(await sha256File(binary), before);
  await assert.rejects(fs.access(path.join(target, 'server/runtime/deepseek')));
});

test('замороженный worker contract 1 безопасно отвергает binary contract 2', async (t) => {
  const { target } = await fixture(t);

  await assert.rejects(legacyRuntimeContract(target), /unsupported_runtime_publish_contract/);
});

test('worker обновляет только сервер/web, явно передавая установленный ELF target smoke', async (t) => {
  const { root: temp, binary } = await fixture(t);
  const { root, first, second } = await fixtureRepository(temp, { binaryContract: true });
  const { id, statePath } = await queueJob(root, first, second);
  const env = { ...process.env, GRIGDESK_DEEPSEEK_BIN: binary };
  const before = await sha256File(binary);

  delete env.NODE_TEST_CONTEXT;
  await fs.mkdir(path.join(root, 'cache'), { recursive: true });
  await fs.mkdir(path.join(root, 'homes'), { recursive: true });
  await fs.writeFile(path.join(root, 'cache/sentinel'), 'cache');
  await fs.writeFile(path.join(root, 'homes/journal'), 'old-history');

  await run(process.execPath, [worker, '--root', root, '--state', statePath, '--job', id,
    '--mode', 'script', '--work-root', path.join(temp, 'staging')], { env, timeout: 120000 });

  const job = (await readPersistentState(statePath)).job;

  assert.equal(await git(root, 'rev-parse', 'HEAD'), second);
  assert.equal(job.status, 'restarting');
  assert.equal(job.expectedRuntimeBuildId ?? null, null);
  assert.equal(await sha256File(binary), before);
  assert.equal(await fs.readFile(path.join(root, 'cache/sentinel'), 'utf8'), 'cache');
  assert.equal(await fs.readFile(path.join(root, 'homes/journal'), 'utf8'), 'old-history');
  assert.equal(await fs.readFile(path.join(root, 'web/dist/index.html'), 'utf8'), 'two\n');
  await assert.rejects(fs.access(path.join(root, 'server/runtime/deepseek')));
});

test('default всегда binary: прежние mode/artifact flags не выбирают embedded или stock', async (t) => {
  const { binary } = await fixture(t);

  assert.equal(usesDeepSeekBinary({}), true);
  assert.equal(deepSeekDistributionMode(fileURLToPath(new URL(
    '../../server/deepseek-runtime-contract.json', import.meta.url,
  ))), 'binary');

  for (const mode of [undefined, 'embedded', 'installed', 'external']) {
    const runtime = await resolveDeepSeekRuntimeAsync({
      deepseekBin: binary,
      deepseekRuntimeMode: mode,
      deepseekArtifactDir: '/legacy-generation-must-not-be-selected',
    });

    assert.equal(runtime.kind, 'binary');
    assert.equal(runtime.command, binary);
    assert.equal(runtime.generationDir, null);
  }
});

test('missing, stock и несовместимый binary оставляют checkout и web прежними', async (t) => {
  for (const failure of ['missing', 'stock', 'bridge', 'glm']) {
    const { root: temp, binary, info } = await fixture(t);
    const { root, first, second } = await fixtureRepository(temp, { binaryContract: true });
    const { id, statePath } = await queueJob(root, first, second);
    const env = { ...process.env, GRIGDESK_DEEPSEEK_BIN: binary };

    delete env.NODE_TEST_CONTEXT;

    if (failure === 'missing') {
      await fs.unlink(binary);
    } else if (failure === 'stock') {
      await fs.writeFile(binary, `#!${process.execPath}\nconsole.log('0.1.5-rc.2');\n`);
    } else {
      if (failure === 'bridge') {
        info.capabilities.settingsAcp = false;
      } else {
        info.glm.admission = [];
      }

      await fs.writeFile(binary,
        `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(info))});`);
    }

    await assert.rejects(run(process.execPath, [worker, '--root', root, '--state', statePath,
      '--job', id, '--mode', 'script', '--work-root', path.join(temp, 'staging')], { env }));

    const job = (await readPersistentState(statePath)).job;

    assert.equal(job.error.code, 'deepseek_binary_not_ready', failure);
    assert.match(job.error.message, /npm --prefix deepseek run install:binary/);
    assert.equal(await git(root, 'rev-parse', 'HEAD'), first);
    assert.equal(await fs.readFile(path.join(root, 'web/dist/index.html'), 'utf8'), 'old\n');
  }
});

test('prepare для deps только читает metadata и сообщает отдельную установку при отсутствии', async (t) => {
  const { binary, info, root } = await fixture(t);
  const script = fileURLToPath(new URL('../../server/scripts/prepareDeepSeekRuntime.mts', import.meta.url));
  const before = await sha256File(binary);
  const result = await run(process.execPath, [script], {
    env: { ...process.env, GRIGDESK_DEEPSEEK_BIN: binary },
  });

  assert.equal(JSON.parse(result.stdout).packageId, info.packageId);
  assert.equal(await sha256File(binary), before);
  await assert.rejects(run(process.execPath, [script], {
    env: { ...process.env, GRIGDESK_DEEPSEEK_BIN: path.join(root, 'missing') },
  }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /npm --prefix deepseek run install:binary/);

    return true;
  });
});
