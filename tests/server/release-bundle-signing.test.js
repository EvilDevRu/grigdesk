import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, sign as signBytes, verify as verifyBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { executeBundle } from '../../tools/bundleSteps.mts';
import { decodeChannelEntry } from '../../shared/runtime/releaseChannelContracts.ts';

const execute = promisify(execFile);

/**
 * Минимальная фикстура сборки: пять builders пишут настоящие файлы, tar настоящий.
 * Ключ ed25519 одноразовый: проверяются и подпись, и содержимое channel.json.
 * readSourceState обязателен: без него executeBundle зовет git во временном каталоге.
 */
async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'release-signing-'));
  const root = path.join(temporary, 'source');

  await fs.mkdir(root, { recursive: true });
  t.after(() => {
    return fs.rm(temporary, {
      recursive: true,
      force: true
    });
  });
  await fs.writeFile(path.join(root, 'VERSION'), '0.3.0\n');
  await fs.mkdir(path.join(root, 'deploy/lib'), { recursive: true });
  await fs.writeFile(path.join(root, 'deploy/lib/runtime-env.sh'), '# runtime\n');
  await fs.mkdir(path.join(root, 'bin'), { recursive: true });
  await fs.writeFile(path.join(root, 'bin/grigdesk-ctl'), '# ctl\n');

  const builders = {};
  const targets = {
    server: 'bin/grigdesk-server',
    tracker: 'bin/tracker',
    relay: 'bin/grigdesk-relay',
    deepseek: 'bin/deepseek',
    window: 'GrigDesk',
  };

  for (const name of Object.keys(targets)) {
    builders[name] = async (input) => {
      const output = path.join(input.outDir, 'out.bin');

      await fs.mkdir(input.outDir, { recursive: true });
      await fs.writeFile(output, `built:${name}`);

      return output;
    };
  }

  return {
    root,
    builders
  };
}

const baseOptions = (root, builders, sign) => {
  return ({
  root,
  builders,
  env: { PATH: process.env.PATH },
  readSourceState: async () => {
    return ({
      commit: 'f'.repeat(40),
      dirty: false
    });
  },
  verifyDeepSeek: async () => {},
  verifyDeepSeekCompatibility: async () => {},
  ...(sign ? { sign } : {}),
});
};

test('RBS-1: подписанный выпуск содержит channel.json и sig, выдача проходит декодер',
  async (t) => {
    const { root, builders } = await fixture(t);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');

    await executeBundle(baseOptions(root, builders, async (content) =>
      {
      return signBytes(null, Buffer.from(content, 'utf8'), privateKey).toString('base64');
    }));

    const checksum = await fs.readFile(path.join(root, 'release.tar.gz.sha256'), 'utf8');
    const signature = (await fs.readFile(
      path.join(root, 'release.tar.gz.sha256.sig'), 'utf8')).trim();

    assert.ok(verifyBytes(null, Buffer.from(checksum, 'utf8'), publicKey,
      Buffer.from(signature, 'base64')), 'подпись соответствует файлу сумм');

    const index = JSON.parse(
      await fs.readFile(path.join(root, 'channel.json'), 'utf8'),
    );
    const entry = decodeChannelEntry(index.latest);

    assert.equal(index.format, 1);
    assert.equal(entry.version, '0.3.0');
    assert.equal(entry.commit, 'f'.repeat(40));
    assert.equal(entry.archiveUrl, null);
    assert.equal(entry.archiveSha256, checksum.split('\n')[0]?.split(' ')[0]);
    assert.equal(entry.signature, signature);
    assert.equal(entry.compat.glibc, '2.28');
  });

test('RBS-2: без sign выпуск прежний — три выхода, без канала', async (t) => {
  const { root, builders } = await fixture(t);

  await executeBundle(baseOptions(root, builders, null));

  await assert.rejects(
    fs.readFile(path.join(root, 'channel.json')),
    (error) => {
      return error.code === 'ENOENT';
    },
  );
  await assert.rejects(
    fs.readFile(path.join(root, 'release.tar.gz.sha256.sig')),
    (error) => {
      return error.code === 'ENOENT';
    },
  );
});

test('RBS-3: посторонняя подпись не сходится verify', async (t) => {
  const { root, builders } = await fixture(t);
  const { publicKey } = generateKeyPairSync('ed25519');

  await executeBundle(baseOptions(root, builders,
    async () => {
      return Buffer.alloc(64, 7).toString('base64');
    }));

  const checksum = await fs.readFile(path.join(root, 'release.tar.gz.sha256'), 'utf8');
  const signature = (await fs.readFile(
    path.join(root, 'release.tar.gz.sha256.sig'), 'utf8')).trim();

  assert.equal(verifyBytes(null, Buffer.from(checksum, 'utf8'), publicKey,
    Buffer.from(signature, 'base64')), false);
});
