import assert from 'node:assert/strict';
import test from 'node:test';

import { launcherPayloadReads } from './drivers/hashCounters.mts';

const root = '/D/runtimes/server/packages/' + 'a'.repeat(64);
const binary = '/I/bin/grigdesk-server';

test('SB27-COUNTER: libuv threads и resumed open учитываются, ordinary worker исключён', () => {
  const trace = [
    `100 execve("${binary}", ["${binary}"], 0x1) = 0`,
    '100 clone(child_stack=0x1, flags=CLONE_VM|CLONE_FS|CLONE_THREAD|CLONE_SIGHAND) = 101',
    `101 openat(AT_FDCWD, "${root}/server/payload.cjs", O_RDONLY|O_CLOEXEC <unfinished ...>`,
    '100 clone(child_stack=NULL, flags=CLONE_VM|CLONE_VFORK|SIGCHLD) = 200',
    `200 execve("${root}/runtime/node/bin/node", ["node"], 0x1) = 0`,
    '101 <... openat resumed>) = 7',
    `200 openat(AT_FDCWD, "${root}/server/payload.cjs", O_RDONLY|O_CLOEXEC) = 9`,
    `101 openat(AT_FDCWD, "${root}/.ready.json", O_RDONLY|O_CLOEXEC) = 10`,
    `101 openat(AT_FDCWD, "${root}/missing", O_RDONLY) = -1 ENOENT (No such file)`,
    '101 clone3({flags=CLONE_VM|CLONE_THREAD|CLONE_SIGHAND}, 88) = 102',
    `102 openat(AT_FDCWD, "${root}/writing", O_WRONLY|O_CREAT, 0600) = 11`,
  ].join('\n');
  const result = launcherPayloadReads(trace, binary, root);

  assert.deepEqual(result.opened, [`${root}/server/payload.cjs`],
    'Асинхронный hash-file open в потоке launcher должен учитываться');
  assert.deepEqual(result.launcherPids, ['100']);
  assert.deepEqual(result.threadIds, ['100', '101', '102']);
});

test('SB27-COUNTER: warm marker и worker reads не превращаются в payload hashes', () => {
  const trace = [
    `100 execve("${binary}", [], 0x1) = 0`,
    '100 clone(child_stack=0x1, flags=CLONE_VM|CLONE_THREAD|CLONE_SIGHAND) = 101',
    `101 openat(AT_FDCWD, "${root}/.ready.json", O_RDONLY|O_CLOEXEC) = 8`,
    '100 vfork() = 200',
    `200 execve("${root}/runtime/node/bin/node", [], 0x1) = 0`,
    '200 clone(child_stack=0x1, flags=CLONE_VM|CLONE_THREAD|CLONE_SIGHAND) = 201',
    `201 openat(AT_FDCWD, "${root}/server/payload.cjs", O_RDONLY|O_CLOEXEC) = 9`,
  ].join('\n');

  assert.deepEqual(launcherPayloadReads(trace, binary, root).opened, []);
});

test('SB27-COUNTER: cold hashes внутри staging тоже учитываются', () => {
  const staging = root.replace(/\/([a-f0-9]+)$/u, '/.$1.staging-fixture');
  const trace = [
    `100 execve("${binary}", [], 0x1) = 0`,
    '100 clone3({flags=CLONE_VM|CLONE_THREAD|CLONE_SIGHAND}, 88) <unfinished ...>',
    `101 openat(AT_FDCWD, "${staging}/server/payload.cjs", O_RDONLY|O_CLOEXEC) = 7`,
    '100 <... clone3 resumed>) = 101',
  ].join('\n');

  assert.deepEqual(launcherPayloadReads(trace, binary, root).opened, [`${staging}/server/payload.cjs`]);
});

test('SB27-COUNTER: потерянный thread ancestry не выдаётся за нулевой счётчик', () => {
  const trace = [
    `100 execve("${binary}", [], 0x1) = 0`,
    `101 openat(AT_FDCWD, "${root}/server/payload.cjs", O_RDONLY|O_CLOEXEC) = 7`,
  ].join('\n');

  assert.throws(() => launcherPayloadReads(trace, binary, root), /не установил executable/u);
});
