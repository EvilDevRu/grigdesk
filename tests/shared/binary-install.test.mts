import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  acquireInstallLock,
  approveInstallReceipt,
  assertInstallFileUnchanged,
  copyInstallFile,
  readInstallReceipt,
  snapshotInstalledFile,
} from '../../shared/node/binaryInstall.ts';
import { sha256File } from '../../shared/node/hash.ts';

const invalid = () => new Error('fixture receipt rejected');

/**
 * Файлы и lock принадлежат только текущей фикстуре в tmp.
 * Общий код проверяется без metadata, executable probes и требований потребителей.
 */
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'binary-install-core-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  return {
    root,
    source: path.join(root, 'source'),
    target: path.join(root, 'target'),
  };
}

test('INSTALL-CORE-copy: закрытая копия принимает политику потребителя и проверяет inode/SHA', async (t) => {
  const box = await fixture(t);
  const bytes = 'ordinary candidate bytes';
  let inspected = 0;

  await fs.writeFile(box.source, bytes);
  await copyInstallFile(box.source, box.target, {
    validateSource: async () => {
      inspected += 1;
    },
  });
  assert.equal(await fs.readFile(box.target, 'utf8').catch(() => null), bytes, 'копия должна существовать');
  assert.equal(inspected, 1);
  assert.equal((await fs.stat(box.target)).mode & 0o777, 0o555);

  const stamp = await fs.lstat(box.target, { bigint: true });
  const digest = await sha256File(box.target);
  const options = { invalid: () => new Error('snapshot changed') };

  await assertInstallFileUnchanged(box.target, stamp, digest, options);
  await fs.rename(box.target, `${box.target}.old`);
  await fs.copyFile(`${box.target}.old`, box.target);
  await assert.rejects(assertInstallFileUnchanged(box.target, stamp, digest, options), /snapshot changed/u);
  await fs.chmod(box.target, 0o755);
  await fs.writeFile(box.target, 'different bytes');
  await fs.chmod(box.target, 0o555);
  await assert.rejects(assertInstallFileUnchanged(box.target,
    await fs.lstat(box.target, { bigint: true }), digest, options), /snapshot changed/u);
  await fs.symlink(box.source, path.join(box.root, 'link'));
  await assert.rejects(copyInstallFile(path.join(box.root, 'link'), path.join(box.root, 'copy')));
});

test('INSTALL-CORE-receipt: mode policy, target и approved snapshot', async (t) => {
  const box = await fixture(t);
  const policy = {
    target: box.target,
    suffix: '.receipt.json',
    modeAllowed: (mode: number) => mode === 0o600,
    exactKeys: true,
    invalid,
  };
  const receipt = await readInstallReceipt(policy);

  assert.deepEqual(receipt, {
    format: 1,
    target: box.target,
    approved: [],
  });
  await fs.writeFile(box.source, 'candidate bytes');

  const digest = await sha256File(box.source);

  await approveInstallReceipt({ receipt, digest: null }, digest, box.root, {
    suffix: policy.suffix,
    mode: 0o600,
    changed: invalid,
  });
  assert.equal((await fs.stat(`${box.target}${policy.suffix}`)).mode & 0o777, 0o600);
  await copyInstallFile(box.source, box.target);

  const approved = await readInstallReceipt(policy);
  const previous = await snapshotInstalledFile(approved, box.root, {
    copy: copyInstallFile,
    unknownTarget: invalid,
  });

  assert.equal(previous.digest, digest);
  assert.ok(previous.snapshot);
  assert.equal(await sha256File(previous.snapshot), digest);
  await approveInstallReceipt(previous, 'b'.repeat(64), box.root, {
    suffix: policy.suffix,
    mode: 0o600,
    changed: invalid,
  });
  assert.deepEqual((await readInstallReceipt(policy)).approved, [digest, 'b'.repeat(64)]);
  await fs.chmod(`${box.target}${policy.suffix}`, 0o500);
  await assert.rejects(readInstallReceipt(policy), /receipt rejected/u);
  assert.equal((await readInstallReceipt({ ...policy, modeAllowed: (mode) => (mode & 0o077) === 0 }))
    .target, box.target);
  await fs.chmod(`${box.target}${policy.suffix}`, 0o600);
  await fs.writeFile(`${box.target}${policy.suffix}`, JSON.stringify({ ...approved, target: '/foreign' }));
  await assert.rejects(readInstallReceipt(policy), /receipt rejected/u);
  await fs.rm(`${box.target}${policy.suffix}`);
  await fs.symlink(box.source, `${box.target}${policy.suffix}`);
  await assert.rejects(readInstallReceipt(policy));
});

test('INSTALL-CORE-lock: один target сериализуется и release снимает только собственный lock', async (t) => {
  const box = await fixture(t);
  const first = await acquireInstallLock(box.target, { waitMs: 10, pollMs: 1 });

  assert.equal(first?.owner?.pid, process.pid, 'lock должен записать kernel owner');
  await assert.rejects(acquireInstallLock(box.target, { waitMs: 10, pollMs: 1 }), {
    code: 'directory_lock_busy',
  });
  await first.release();
  await first.release();
  assert.equal(await fs.stat(`${box.target}.install-lock`).catch(() => null), null);
});
