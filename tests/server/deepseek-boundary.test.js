import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ensureTestAdmittedDeepSeekBinary } from '../helpers/deepseekBinary.mts';
import { createGlmBinaryFixtureRoot } from '../helpers/glmBinary.mts';
import { removePrivateTree } from '../../shared/node/files.ts';
import { startDeepSeekLoopback, writeDeepSeekLoopbackOverlay } from '../helpers/deepseekLoopback.mts';
import { startGlmLoopback } from '../helpers/glmLoopback.mts';
import { writeGlmEgressGuard } from '../helpers/glmProductionFixture.mts';

const repository = path.resolve(import.meta.dirname, '../..');
const execute = promisify(execFile);

/**
 * Только копия consumer получает ordinary server/shared/engine ресурсы и один ELF.
 * Новый child импортирует consumer из этой копии; source package и legacy runtime отсутствуют.
 */
test('изолированный server и Factory работают через один ELF без Harness source или runtime tree', {
  timeout: 900000,
}, async (t) => {
  const candidate = await ensureTestAdmittedDeepSeekBinary();
  const root = await createGlmBinaryFixtureRoot('deepseek-boundary-');
  const deepseek = await startDeepSeekLoopback();
  const glm = await startGlmLoopback({
    expectedKey: 'synthetic-zai-service-key',
    respond: async () => ({ kind: 'stream', deltas: [{ role: 'assistant', content: 'boundary-glm-ok' }] }),
  });

  t.after(async () => {
    await deepseek.stop();
    await glm.stop();
    await removePrivateTree(root);
  });

  for (const relative of ['server/src', 'server/scripts', 'shared', 'engine']) {
    await fs.cp(path.join(repository, relative), path.join(root, relative), {
      recursive: true,
      filter: (file) => !['node_modules', '.git', '.state'].includes(path.basename(file)),
    });
  }

  await fs.copyFile(path.join(repository, 'server/package.json'), path.join(root, 'server/package.json'));
  await fs.copyFile(path.join(repository, 'server/deepseek-host-contract.json'),
    path.join(root, 'server/deepseek-host-contract.json'));
  await fs.copyFile(path.join(repository, 'server/deepseek-runtime-contract.json'),
    path.join(root, 'server/deepseek-runtime-contract.json'));
  await fs.mkdir(path.join(root, 'server/build'));
  await fs.copyFile(path.join(repository, 'server/build/helpers.json'),
    path.join(root, 'server/build/helpers.json'));
  await fs.symlink(path.join(repository, 'server/node_modules'), path.join(root, 'server/node_modules'));
  await fs.mkdir(path.join(root, 'bin'));
  await fs.mkdir(path.join(root, 'project'));
  await fs.mkdir(path.join(root, 'data/home'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(root, 'fixtures'));
  await fs.copyFile(candidate.binary, path.join(root, 'bin/deepseek'));
  await fs.chmod(path.join(root, 'bin/deepseek'), 0o555);

  const document = path.join(root, 'fixtures/settings.yaml');

  await fs.writeFile(document, '{}\n', { mode: 0o600 });

  const patch = await writeDeepSeekLoopbackOverlay({
    root: path.join(root, 'fixtures'),
    artifact: path.join(root, 'data/cache/packages', candidate.info.packageId, 'generation'),
    endpoint: deepseek.endpoint,
    document,
  });
  const input = path.join(root, 'fixtures/input.json');

  await fs.writeFile(input, JSON.stringify({
    packageId: candidate.info.packageId,
    deepseekPatch: patch,
    glmEndpoint: glm.endpoint,
    egressGuard: await writeGlmEgressGuard(path.join(root, 'fixtures')),
  }));

  for (const absent of ['deepseek', 'tools', 'third_party', 'server/runtime/deepseek']) {
    await assert.rejects(fs.access(path.join(root, absent)), { code: 'ENOENT' });
  }

  const result = await execute(process.execPath, [
    path.join(repository, 'tests/fixtures/deepseek-harness/isolatedConsumer.mjs'), root, input,
  ], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: path.join(root, 'data/home'),
      GRIGDESK_HOME: path.join(root, 'data'),
    },
    timeout: 180000,
    maxBuffer: 65536,
  });
  const proof = JSON.parse(result.stdout);

  assert.equal(result.stderr, '');
  assert.equal(proof.packageId, candidate.info.packageId);
  assert.equal(proof.deepseek, 'loopback-ok');
  assert.equal(proof.glm, 'boundary-glm-ok');
  assert.equal(proof.sameDeepseekSession, true);
  assert.equal(proof.sameGlmSession, true);
  assert.equal(proof.factoryMetadata, true);
  assert.equal(deepseek.payloads.length, 2);
  assert.match(JSON.stringify(deepseek.payloads[1].messages), /boundary-deepseek-first/u);
  assert.equal(glm.requests.length, 2);
  assert.match(JSON.stringify(glm.requests[1].payload.messages), /boundary-glm-first/u);
});
