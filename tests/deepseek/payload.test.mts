import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { unzipSync, zipSync } from '../../deepseek/node_modules/fflate/esm/index.mjs';

import { packagePayload } from '../../deepseek/scripts/packagePayload.mts';
import { consumePayloadArchive, decodePayloadIndex } from '../../deepseek/src/runtime/payloadIndex.ts';
import { packageIdFor } from '../../deepseek/src/runtime/metadata.ts';
import { sha256 } from '../../shared/node/hash.ts';
import { deepSeekPayloadFixture as fixture } from '../helpers/deepseekPayload.mts';

test('ZIP и индекс сохраняют bytes, executable modes и относительные links без source paths', async (t) => {
  const { root, options } = await fixture(t);
  const payload = await packagePayload(options);
  const bytes = await fs.readFile(options.outputFile);
  const files = unzipSync(bytes);

  assert.equal(payload.sha256, sha256(bytes));
  assert.equal(payload.size, bytes.length);
  assert.equal(Buffer.from(files.node!).toString(), 'ordinary-node-bytes');
  assert.equal(Buffer.from(files['NODE-LICENSE']!).toString(), 'node-license-bytes');
  assert.equal(Buffer.from(files['generation/dependency.js']!).toString(), 'payload-bytes');
  assert.deepEqual(payload.entries.find((entry) => entry.path === 'generation/relative-link'), {
    path: 'generation/relative-link',
    type: 'link',
    mode: 0o777,
    target: 'dependency.js',
  });
  assert.equal(payload.entries.find((entry) => entry.path === 'generation/dependency.js')?.mode, 0o555);
  assert.ok(payload.entries.some((entry) => entry.path === 'generation/licenses/index.json'));
  assert.ok(!JSON.stringify(payload).includes(root));
  assert.ok(!Object.keys(files).some((name) => name.endsWith('.env')));
  assert.ok(!Buffer.concat(Object.values(files)).includes(Buffer.from('SYNTHETIC_SECRET_MUST_STAY_OUTSIDE')));
});

test('проверенное потоковое чтение возвращает ровно файлы индекса и исходные байты', async (t) => {
  const { options } = await fixture(t);
  const payload = await packagePayload(options);
  const bytes = await fs.readFile(options.outputFile);
  const actual: Record<string, Buffer> = {};

  assert.deepEqual(decodePayloadIndex(payload.entries), payload.entries);
  await consumePayloadArchive([bytes], payload, (entry) => {
    const chunks: Uint8Array[] = [];

    return {
      write: (chunk) => chunks.push(chunk.slice()),
      close: () => {
        actual[entry.path] = Buffer.concat(chunks);
      },
      abort: () => {},
    };
  });
  assert.deepEqual(Object.keys(actual).sort(), payload.entries
    .filter((entry) => entry.type === 'file').map((entry) => entry.path).sort());
  assert.equal(actual['generation/dependency.js']!.toString(), 'payload-bytes');
});

test('неизвестный тип записи и неизвестный файл ZIP отвергаются', async (t) => {
  const { options } = await fixture(t);
  const payload = await packagePayload(options);

  assert.throws(() => decodePayloadIndex([{
    path: 'socket',
    type: 'socket',
    mode: 0o644,
  }]), {
    code: 'deepseek_payload_invalid',
  });

  const files = unzipSync(await fs.readFile(options.outputFile));
  const bytes = zipSync({ ...files, 'unknown.txt': Buffer.from('unknown') });

  await assert.rejects(() => consumePayloadArchive([bytes], {
    ...payload,
    sha256: sha256(bytes),
    size: bytes.length,
  }), { code: 'deepseek_payload_invalid' });
});

test('лицензионный inventory обязателен даже в целой заново подписанной generation', async (t) => {
  const { options } = await fixture(t);
  const file = path.join(options.generationDirectory, 'runtime.json');
  const metadata = JSON.parse(await fs.readFile(file, 'utf8'));

  await fs.unlink(path.join(options.generationDirectory, 'licenses/index.json'));
  delete metadata.payload['licenses/index.json'];
  metadata.buildId = sha256(JSON.stringify({
    inputIdentity: metadata.inputIdentity,
    payload: metadata.payload,
  }));
  metadata.runtimeVersion = `${metadata.source.version}.grigdesk.b${metadata.buildId.slice(0, 16)}`;
  await fs.chmod(file, 0o644);
  await fs.writeFile(file, JSON.stringify(metadata));
  await fs.chmod(file, 0o444);

  await assert.rejects(() => packagePayload(options), { code: 'deepseek_payload_invalid' });
});

test('временный source path и порядок обхода не меняют индекс, ZIP или packageId', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t, true);

  t.mock.timers.enable({ apis: ['Date'], now: new Date('2030-01-01T00:00:00Z') });

  const a = await packagePayload(first.options);

  t.mock.timers.tick(86_400_000);

  const b = await packagePayload(second.options);

  assert.deepEqual(a, b);
  assert.equal(packageIdFor({ payload: a }), packageIdFor({ payload: b }));

  const manifest = {
    payload: a,
    workerNode: { sha256: 'node-A' },
    launcher: 'launcher-A',
    glm: { admission: ['admission-A'] },
    buildId: 'generation-A',
    binaryVersion: '1.0.0',
  };

  for (const change of [
    { payload: { ...a, sha256: 'other-archive' } },
    { workerNode: { sha256: 'node-B' } },
    { launcher: 'launcher-B' },
    { glm: { admission: ['admission-B'] } },
    { buildId: 'generation-B' },
    { binaryVersion: '1.0.1' },
  ]) {
    assert.notEqual(packageIdFor(manifest), packageIdFor({ ...manifest, ...change }));
  }
});
