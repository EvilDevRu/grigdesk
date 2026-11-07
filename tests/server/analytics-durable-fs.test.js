// Проверяет устойчивые операции с приватной файловой системой аналитики и защиту от подмены.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AnalyticsDurableFsError,
  DURABLE_FS_STAGES,
  createDurableFs,
} from '../../server/src/lib/analytics/durableFs.ts';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const permissions = (stat) => stat.mode & 0o777;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-analytics-fs-'));
  const directory = path.join(root, 'private', 'analytics');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory };
}

test('immutable publish создаёт private state и различает publish/idempotent/conflict', async (t) => {
  const { root, directory } = await fixture(t);
  const durable = createDurableFs();
  const bytes = Buffer.from('{"schemaVersion":1}\n');

  const first = await durable.publishImmutable({
    directory,
    name: 'record.json',
    bytes,
    maxBytes: 1024,
  });
  assert.equal(first.outcome, 'published');
  assert.equal(first.sha256, sha256(bytes));
  assert.equal(permissions(await lstat(path.dirname(directory))), 0o700);
  assert.equal(permissions(await lstat(directory)), 0o700);
  assert.equal(permissions(await lstat(path.join(directory, 'record.json'))), 0o600);

  const second = await durable.publishImmutable({
    directory,
    name: 'record.json',
    bytes,
    maxBytes: 1024,
  });
  assert.equal(second.outcome, 'idempotent');

  await assert.rejects(
    durable.publishImmutable({
      directory,
      name: 'record.json',
      bytes: Buffer.from('{"schemaVersion":2}\n'),
      maxBytes: 1024,
    }),
    (error) => {
      assert.ok(error instanceof AnalyticsDurableFsError);
      assert.equal(error.code, 'immutableConflict');
      assert.doesNotMatch(error.message, new RegExp(root.replaceAll('/', '\\/')));
      return true;
    },
  );
  assert.deepEqual(await readFile(path.join(directory, 'record.json')), bytes);
  assert.deepEqual(await readdir(directory), ['record.json']);
});

test('конкурентный publish использует true no-replace, а не check-then-rename', async (t) => {
  const { directory } = await fixture(t);
  const durable = createDurableFs();
  const left = Buffer.from('left');
  const right = Buffer.from('right');
  const results = await Promise.allSettled([
    durable.publishImmutable({ directory, name: 'winner.json', bytes: left }),
    durable.publishImmutable({ directory, name: 'winner.json', bytes: right }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'immutableConflict');
  const stored = await readFile(path.join(directory, 'winner.json'));
  assert.ok(stored.equals(left) || stored.equals(right));
  assert.deepEqual(await readdir(directory), ['winner.json']);
});

test('stable reader ограничивает размер, не следует symlink и замечает mutation', async (t) => {
  const { root, directory } = await fixture(t);
  const durable = createDurableFs();
  await durable.ensurePrivateDirectory({ directory });
  await writeFile(path.join(directory, 'plain'), 'abc', { mode: 0o600 });

  const snapshot = await durable.readStableFile({ directory, name: 'plain', maxBytes: 3 });
  assert.equal(snapshot.bytes.toString('utf8'), 'abc');
  assert.equal(snapshot.sha256, sha256(Buffer.from('abc')));
  for (const key of ['dev', 'ino', 'size', 'mtimeNs']) {
    assert.match(snapshot.fingerprint[key], /^(0|[1-9][0-9]*)$/);
  }

  await writeFile(path.join(root, 'outside'), 'secret');
  await symlink(path.join(root, 'outside'), path.join(directory, 'linked'));
  await assert.rejects(
    durable.readStableFile({ directory, name: 'linked', maxBytes: 32 }),
    (error) => error.code === 'unsafeFile' && !error.message.includes(root),
  );
  await assert.rejects(
    durable.readStableFile({ directory, name: 'plain', maxBytes: 2 }),
    (error) => error.code === 'fileTooLarge',
  );

  let mutate = true;
  const racing = createDurableFs({
    stage: async (stage) => {
      if (stage === DURABLE_FS_STAGES.STABLE_BYTES_READ && mutate) {
        mutate = false;
        await writeFile(path.join(directory, 'plain'), 'changed');
      }
    },
  });
  await assert.rejects(
    racing.readStableFile({ directory, name: 'plain', maxBytes: 32 }),
    (error) => error.code === 'fileChanged',
  );
});

test('crash после link оставляет проверяемый orphan, recovery удаляет только его', async (t) => {
  const { directory } = await fixture(t);
  const bytes = Buffer.from('durable payload');
  const hash = sha256(bytes);
  let crash = true;
  const crashing = createDurableFs({
    stage: async (stage) => {
      if (stage === DURABLE_FS_STAGES.TARGET_LINKED && crash) {
        crash = false;
        const error = new Error('injected crash');
        error.code = 'INJECTED_CRASH';
        throw error;
      }
    },
  });

  await assert.rejects(
    crashing.publishImmutable({ directory, name: 'record.json', bytes }),
    (error) => error.code === 'INJECTED_CRASH',
  );
  const afterCrash = await readdir(directory);
  const orphan = afterCrash.find((name) => name !== 'record.json');
  assert.ok(orphan);
  assert.deepEqual(await readFile(path.join(directory, 'record.json')), bytes);

  const durable = createDurableFs();
  await assert.rejects(
    durable.recoverOrphanTemp({
      directory,
      name: orphan,
      expectedSha256: '0'.repeat(64),
      maxBytes: 1024,
    }),
    (error) => error.code === 'orphanMismatch',
  );
  assert.ok((await readdir(directory)).includes(orphan));

  const recovered = await durable.recoverOrphanTemp({
    directory,
    name: orphan,
    expectedSha256: hash,
    maxBytes: 1024,
  });
  assert.equal(recovered.outcome, 'removed');
  assert.deepEqual(await readdir(directory), ['record.json']);

  const retry = await durable.publishImmutable({ directory, name: 'record.json', bytes });
  assert.equal(retry.outcome, 'idempotent');
});

test('orphan до link восстанавливается только по embedded и ожидаемому hash', async (t) => {
  const { directory } = await fixture(t);
  const bytes = Buffer.from('pre-link payload');
  let crash = true;
  const crashing = createDurableFs({
    stage: async (stage) => {
      if (stage === DURABLE_FS_STAGES.TEMP_FSYNCED && crash) {
        crash = false;
        throw Object.assign(new Error('injected crash'), { code: 'INJECTED_CRASH' });
      }
    },
  });
  await assert.rejects(
    crashing.publishImmutable({ directory, name: 'never-created.json', bytes }),
    (error) => error.code === 'INJECTED_CRASH',
  );
  const [orphan] = await readdir(directory);
  assert.match(orphan, /^\.analytics-tmp-[a-f0-9]{64}-[a-f0-9]+\.tmp$/);

  const durable = createDurableFs();
  await durable.recoverOrphanTemp({
    directory,
    name: orphan,
    expectedSha256: sha256(bytes),
  });
  assert.deepEqual(await readdir(directory), []);
});

test('каждая publish crash boundary оставляет только восстанавливаемое состояние', async (t) => {
  const { directory: base } = await fixture(t);
  const bytes = Buffer.from('boundary payload');
  const digest = sha256(bytes);
  const boundaries = [
    { stage: DURABLE_FS_STAGES.TARGET_DIRECTORY_FSYNCED, orphan: true },
    { stage: DURABLE_FS_STAGES.TEMP_UNLINKED, orphan: false },
    { stage: DURABLE_FS_STAGES.CLEANUP_DIRECTORY_FSYNCED, orphan: false },
  ];

  for (const [index, boundary] of boundaries.entries()) {
    const directory = path.join(base, `case-${index}`);
    let crash = true;
    const crashing = createDurableFs({
      stage: async (stage) => {
        if (stage === boundary.stage && crash) {
          crash = false;
          throw Object.assign(new Error('injected crash'), { code: 'INJECTED_CRASH' });
        }
      },
    });
    await assert.rejects(
      crashing.publishImmutable({ directory, name: 'record.json', bytes }),
      (error) => error.code === 'INJECTED_CRASH',
    );
    assert.deepEqual(await readFile(path.join(directory, 'record.json')), bytes);
    const names = await readdir(directory);
    const orphan = names.find((name) => name !== 'record.json');
    assert.equal(Boolean(orphan), boundary.orphan);
    if (orphan) {
      await createDurableFs().recoverOrphanTemp({
        directory,
        name: orphan,
        expectedSha256: digest,
      });
    }
    const retried = await createDurableFs().publishImmutable({
      directory,
      name: 'record.json',
      bytes,
    });
    assert.equal(retried.outcome, 'idempotent');
    assert.deepEqual(await readdir(directory), ['record.json']);
  }
});

test('exact unlink требует прежние fingerprint/hash и единственную hardlink identity', async (t) => {
  const { directory } = await fixture(t);
  const durable = createDurableFs();
  const bytes = Buffer.from('remove me');
  await durable.publishImmutable({ directory, name: 'target.log', bytes });
  const observed = await durable.readStableFile({ directory, name: 'target.log' });

  await writeFile(path.join(directory, 'target.log'), 'replacement');
  await assert.rejects(
    durable.unlinkExactFile({
      directory,
      name: 'target.log',
      expectedFingerprint: observed.fingerprint,
      expectedSha256: observed.sha256,
    }),
    (error) => error.code === 'exactTargetChanged',
  );
  assert.equal(await readFile(path.join(directory, 'target.log'), 'utf8'), 'replacement');

  const replacement = await durable.readStableFile({ directory, name: 'target.log' });
  await link(path.join(directory, 'target.log'), path.join(directory, 'second-link'));
  await assert.rejects(
    durable.unlinkExactFile({
      directory,
      name: 'target.log',
      expectedFingerprint: replacement.fingerprint,
      expectedSha256: replacement.sha256,
    }),
    (error) => error.code === 'exactTargetChanged',
  );
  assert.equal(await readFile(path.join(directory, 'target.log'), 'utf8'), 'replacement');

  await rm(path.join(directory, 'second-link'));
  const single = await durable.readStableFile({ directory, name: 'target.log' });
  const removed = await durable.unlinkExactFile({
    directory,
    name: 'target.log',
    expectedFingerprint: single.fingerprint,
    expectedSha256: single.sha256,
  });
  assert.equal(removed.outcome, 'removed');
  await assert.rejects(lstat(path.join(directory, 'target.log')), { code: 'ENOENT' });
});

test('stable read и retention unlink не меняют mode внешнего run directory', async (t) => {
  const { root } = await fixture(t);
  const directory = path.join(root, 'provider-run');
  await mkdir(directory, { mode: 0o755 });
  await writeFile(path.join(directory, 'events.jsonl'), '{"event":"done"}\n', { mode: 0o644 });
  const durable = createDurableFs();
  const observed = await durable.readStableFile({
    directory,
    name: 'events.jsonl',
    maxBytes: 1024,
  });
  assert.equal(permissions(await lstat(directory)), 0o755);
  assert.equal(permissions(await lstat(path.join(directory, 'events.jsonl'))), 0o644);

  await durable.unlinkExactFile({
    directory,
    name: 'events.jsonl',
    expectedFingerprint: observed.fingerprint,
    expectedSha256: observed.sha256,
    maxBytes: 1024,
  });
  assert.equal(permissions(await lstat(directory)), 0o755);
  await assert.rejects(lstat(path.join(directory, 'events.jsonl')), { code: 'ENOENT' });
});

test('syscall injection возвращает именованную ошибку без утечки filesystem path', async (t) => {
  const { root, directory } = await fixture(t);
  const durable = createDurableFs({
    syscalls: {
      dirfdOperation: async () => {
        const error = new Error(`I/O failed at ${root}/private/analytics`);
        error.code = 'EIO';
        throw error;
      },
    },
  });
  await assert.rejects(
    durable.publishImmutable({ directory, name: 'record.json', bytes: Buffer.from('x') }),
    (error) => {
      assert.equal(error.code, 'durableIoFailure');
      assert.doesNotMatch(error.message, new RegExp(root.replaceAll('/', '\\/')));
      assert.deepEqual(error.details, { syscallCode: 'EIO' });
      return true;
    },
  );
});

test('private directory исправляет leaf mode, но отвергает symlink leaf', async (t) => {
  const { root, directory } = await fixture(t);
  const durable = createDurableFs();
  await durable.ensurePrivateDirectory({ directory });
  await chmod(directory, 0o755);
  await durable.ensurePrivateDirectory({ directory });
  assert.equal(permissions(await lstat(directory)), 0o700);

  const real = path.join(root, 'real');
  const linked = path.join(root, 'linked-dir');
  await durable.ensurePrivateDirectory({ directory: real });
  await symlink(real, linked);
  await assert.rejects(
    durable.ensurePrivateDirectory({ directory: linked }),
    (error) => error.code === 'unsafeDirectory' && !error.message.includes(root),
  );

  const linkedParent = path.join(root, 'linked-parent');
  await symlink(real, linkedParent);
  await assert.rejects(
    durable.ensurePrivateDirectory({ directory: path.join(linkedParent, 'must-not-exist') }),
    (error) => error.code === 'unsafeDirectory' && !error.message.includes(root),
  );
  await assert.rejects(lstat(path.join(real, 'must-not-exist')), { code: 'ENOENT' });
});
