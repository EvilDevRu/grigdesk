import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Unzip, UnzipInflate, zipSync } from '../../deepseek/node_modules/fflate/esm/index.mjs';
import { packagePayload } from '../../deepseek/scripts/packagePayload.mts';
import { consumePayloadArchive, decodePayloadIndex } from '../../server/src/binary/payload.ts';
import { packagePayload as packageServerPayload } from '../../server/scripts/binary/packagePayload.mts';
import { createServerManifest, decodeServerManifest, packageIdFor,
  serverManifestBytes } from '../../server/src/binary/metadata.ts';
import { makeReadOnlyTree } from '../../shared/node/files.ts';
import { createPayloadCodec } from '../../shared/node/payloadArchive.ts';
import { sha256 } from '../../shared/node/hash.ts';
import { deepSeekPayloadFixture } from '../helpers/deepseekPayload.mts';

test('SB03: общий codec использует ZIP port и ошибку своего consumer', async (t) => {
  const { options } = await deepSeekPayloadFixture(t);
  const payload = await packagePayload(options);
  const bytes = await readFile(options.outputFile);
  const failure = Object.assign(new Error('fixture payload invalid'), { code: 'fixture_payload_invalid' });
  let zipCalls = 0;
  const codec = createPayloadCodec(() => {
    throw failure;
  }, (onFile) => {
    const zip = new Unzip(onFile);

    zipCalls += 1;
    zip.register(UnzipInflate);

    return zip;
  });
  const files = [];

  await codec.consumePayloadArchive([bytes], payload, (entry) => {
    const chunks = [];

    return {
      write: (chunk) => chunks.push(chunk.slice()),
      close: () => files.push([entry.path, Buffer.concat(chunks)]),
      abort: () => {},
    };
  });
  assert.equal(zipCalls, 1);
  assert.deepEqual(files.map(([name]) => name).sort(), payload.entries
    .filter((entry) => entry.type === 'file').map((entry) => entry.path).sort());
  assert.equal(files.find(([name]) => name === 'node')[1].toString(), 'ordinary-node-bytes');
  await assert.rejects(() => codec.consumePayloadArchive([], payload), (error) => error === failure);

  for (const name of ['../outside', `bad${String.fromCharCode(0)}path`, 'bad\\path']) {
    assert.throws(() => codec.decodePayloadIndex([{
      path: name,
      type: 'file',
      mode: 0o444,
      size: 0,
      sha256: 'a'.repeat(64),
    }]), (error) => error === failure);
  }
});

test('SB03: server adapter сохраняет modes и links, неизвестный ZIP отвергается', async (t) => {
  const { options } = await deepSeekPayloadFixture(t);
  const payload = await packagePayload(options);
  const bytes = await readFile(options.outputFile);

  assert.deepEqual(decodePayloadIndex(payload.entries), payload.entries);
  assert.equal(payload.entries.find((entry) => entry.path === 'generation/dependency.js').mode, 0o555);
  assert.deepEqual(payload.entries.find((entry) => entry.path === 'generation/relative-link'), {
    path: 'generation/relative-link',
    type: 'link',
    mode: 0o777,
    target: 'dependency.js',
  });
  await consumePayloadArchive([bytes], payload);

  const unknown = zipSync({ unknown: new Uint8Array() });

  await assert.rejects(() => consumePayloadArchive([unknown], {
    ...payload,
    size: unknown.length,
    sha256: sha256(unknown),
  }), { code: 'server_payload_invalid' });
});

test('SB03: полный index отвергает опасные пути, parents, types, modes и link chains', () => {
  const file = {
    path: 'file',
    type: 'file',
    mode: 0o444,
    size: 0,
    sha256: sha256(''),
  };
  const link = {
    path: 'link',
    type: 'link',
    mode: 0o777,
    target: 'file',
  };

  for (const entries of [
    [{ ...file, path: '../sentinel' }], [{ ...file, path: '/outside/sentinel' }],
    [{ ...file, path: 'bad\0path' }], [{ ...file, path: 'generation/./entry.mjs' }],
    [{ ...file, path: 'bad\\path' }], [file, file], [{ ...file, path: 'missing/file' }],
    [{ ...file, type: 'socket' }], [{ ...file, mode: 0o1000 }], [{ ...file, size: -1 }],
    [{ ...file, sha256: 'bad' }], [file, { ...link, target: '../sentinel' }],
    [file, { ...link, target: '/sentinel' }], [file, { ...link, target: 'missing' }],
    [file, { ...link, target: 'link' }], [file, link, { ...file, path: 'link/file' }],
    [file, { ...link, target: '../sentinel' }, {
      ...link,
      path: 'chain',
      target: 'link',
    }],
    [{
      ...link,
      path: 'cycle-a',
      target: 'cycle-b',
    }, {
      ...link,
      path: 'cycle-b',
      target: 'cycle-a',
    }],
  ]) {
    assert.throws(() => decodePayloadIndex(entries), { code: 'server_payload_invalid' });
  }
});

test('SB03: повреждённый, оборванный, повторный и слишком большой архив дают отказ', async (t) => {
  const { options } = await deepSeekPayloadFixture(t);
  const payload = await packagePayload(options);
  const bytes = await readFile(options.outputFile);
  const damaged = Buffer.from(bytes);

  damaged[Math.floor(damaged.length / 2)] ^= 1;

  for (const content of [damaged, bytes.subarray(0, bytes.length - 10), Buffer.concat([bytes, bytes])]) {
    await assert.rejects(() => consumePayloadArchive([content], payload), { code: 'server_payload_invalid' });
  }

  const name = payload.entries.find((entry) => entry.type === 'file' && entry.size > 0).path;

  await assert.rejects(() => consumePayloadArchive([bytes], {
    ...payload,
    entries: payload.entries.map((entry) => entry.path === name ? { ...entry, size: 0 } : entry),
  }), { code: 'server_payload_invalid' });

  const duplicate = Buffer.from(zipSync({ file1: new Uint8Array(), file2: new Uint8Array() }));

  for (let offset = duplicate.indexOf('file2'); offset !== -1; offset = duplicate.indexOf('file2')) {
    duplicate.write('file1', offset);
  }

  await assert.rejects(() => consumePayloadArchive([duplicate], {
    entries: [{
      path: 'file1',
      type: 'file',
      mode: 0o444,
      size: 0,
      sha256: sha256(''),
    }],
    size: duplicate.length,
    sha256: sha256(duplicate),
  }), { code: 'server_payload_invalid' });
});

/**
 * Маленький stage содержит все разновидности payload, но не запускает сборщик.
 * Отдельные абсолютные каталоги обязаны давать одинаковые байты и identity.
 */
async function serverPackageFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'server-zip-'));
  const directory = path.join(root, 'stage');
  const outputFile = path.join(root, 'payload.zip');

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'engine'), { recursive: true });
  await writeFile(path.join(directory, 'VERSION'), '0.1.0\n');
  await writeFile(path.join(directory, 'engine/factory'), 'fixture-engine');
  await symlink('factory', path.join(directory, 'engine/link'));
  await makeReadOnlyTree(directory);

  return { directory, outputFile };
}

test('SB20: sorted ZIP/index/id одинаковы между каталогами; bytes/modes/launcher меняют id', async (t) => {
  const first = await serverPackageFixture(t);
  const second = await serverPackageFixture(t);
  const a = await packageServerPayload(first);
  const b = await packageServerPayload(second);

  assert.ok(a.entries.length > 0, 'индекс содержит stage');
  assert.deepEqual(a, b);
  assert.deepEqual(await readFile(first.outputFile), await readFile(second.outputFile));
  assert.equal(JSON.stringify(a).includes(first.directory), false);
  assert.equal(packageIdFor({ payload: a, launcher: 'first' }),
    packageIdFor({ launcher: 'first', payload: b }));
  assert.notEqual(packageIdFor({ payload: a, launcher: 'first' }),
    packageIdFor({ payload: a, launcher: 'second' }));

  await chmod(path.join(second.directory, 'engine/factory'), 0o555);

  const changed = await packageServerPayload(second);

  assert.notEqual(packageIdFor({ payload: a }), packageIdFor({ payload: changed }));
  await chmod(path.join(second.directory, 'engine/factory'), 0o644);
  await writeFile(path.join(second.directory, 'engine/factory'), 'changed-engine');
  await chmod(path.join(second.directory, 'engine/factory'), 0o444);

  const bytesChanged = await packageServerPayload(second);

  assert.notEqual(packageIdFor({ payload: a }), packageIdFor({ payload: bytesChanged }));
  await consumePayloadArchive([await readFile(first.outputFile)], a);
});

test('SB20: mutation/обрыв не публикуют ZIP и сохраняют прежний output', async (t) => {
  const input = await serverPackageFixture(t);

  await writeFile(input.outputFile, 'previous');
  await assert.rejects(packageServerPayload({
    ...input,
    afterInventory: async () => {
      await chmod(path.join(input.directory, 'VERSION'), 0o644);
      await writeFile(path.join(input.directory, 'VERSION'), 'changed\n');
      await chmod(path.join(input.directory, 'VERSION'), 0o444);
    },
  }), /изменил|изменён|изменился/);
  assert.equal(await readFile(input.outputFile, 'utf8'), 'previous');
  await assert.rejects(packageServerPayload({
    ...input,
    afterInventory: async () => {
      throw new Error('fixture ENOSPC');
    },
  }), /ENOSPC/);
  assert.equal(await readFile(input.outputFile, 'utf8'), 'previous');
});

test('SB20: manifest связывает launcher, npm lock, license, native, helper и engine schema', () => {
  const payload = {
    entries: [],
    sha256: 'a'.repeat(64),
    size: 22,
  };
  const input = {
    launcherSha256: 'b'.repeat(64),
    engineSha256: 'c'.repeat(64),
    buildInputs: {
      lock: 'd'.repeat(64),
      license: 'e'.repeat(64),
      native: 'f'.repeat(64),
      helper: '1'.repeat(64),
      schema: '2'.repeat(64),
    },
  };
  const original = createServerManifest(payload, input);

  assert.equal(original.version, '0.1.0');
  assert.equal(original.packageId, packageIdFor(original));
  assert.deepEqual(decodeServerManifest(serverManifestBytes(original), original.packageId), original);
  assert.throws(() => decodeServerManifest(serverManifestBytes(original) + ' ', original.packageId));
  assert.throws(() => decodeServerManifest(serverManifestBytes(original), '0'.repeat(64)));

  for (const name of Object.keys(input.buildInputs)) {
    const changed = createServerManifest(payload, {
      ...input,
      buildInputs: { ...input.buildInputs, [name]: '0'.repeat(64) },
    });

    assert.notEqual(original.packageId, changed.packageId, name);
  }

  assert.notEqual(original.packageId, createServerManifest(payload, {
    ...input, launcherSha256: '0'.repeat(64),
  }).packageId);
});
