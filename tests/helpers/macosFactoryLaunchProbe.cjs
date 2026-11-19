const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');

/**
 * Проверяет закрытие скомпилированного apply до вызова callback и во время него.
 * Drain дожидается durable исхода даже если получение сигнала уже подтверждено.
 */
async function verifyAbortedApply(probe, root, phase) {
  const { FactoryLaunchAdmission, ArbiterConversationStore, ArbiterConversationService } = probe;
  const admission = new FactoryLaunchAdmission();
  const store = new ArbiterConversationStore(path.join(root, `abort-${phase}`));
  const entered = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const release = Promise.withResolvers();
  const identity = {
    task: '75',
    profile: 'demo-profile',
    attempt: `a_${'a'.repeat(32)}`,
    node: 'check',
    stop: 'human',
    stageSequence: 2,
    stageHeadHash: 'f'.repeat(64),
  };
  const capabilities = {
    status: 'supported',
    message: '',
    targets: [{
      node: 'instrument',
      executorKind: 'agent',
      label: 'Подготовка',
      acceptsInstruction: true,
      canRetryUnchanged: false,
      resetNodes: ['instrument', 'check'],
    }],
  };

  const doc = await store.create(identity, capabilities);
  let calls = 0;
  let closing;
  const service = new ArbiterConversationService({
    store,
    factoryAdmission: admission,
    readContext: async () => ({ identity }),
    capabilities: async () => capabilities,
    prepareRun: async () => {
      throw new Error('fixture_unexpected_model');
    },
    apply: async (_doc, _operation, controller) => {
      calls += 1;
      controller.signal.addEventListener('abort', aborted.resolve, { once: true });
      entered.resolve();
      await release.promise;
      controller.signal.throwIfAborted();
    },
  });
  const update = store.update.bind(store);

  if (phase === 'before') {
    store.update = async (...args) => {
      const saved = await update(...args);

      if (!closing && saved.operations[0]?.outcome === 'running') {
        closing = service.close();
      }

      return saved;
    };
  }

  const accepted = await service.submit(identity.task, doc.id, 'apply', {
    requestId: randomUUID(),
    expectedStop: identity,
    decisionRevision: doc.decisionRevision,
    customAction: {
      kind: 'return_to_node',
      targetNode: 'instrument',
      instruction: 'Проверить воспроизводимость.',
    },
  });

  try {
    if (phase === 'during') {
      await entered.promise;
      closing = service.close();
      await aborted.promise;
      assert.throws(() => admission.acquire('fixture-updater'), { code: 'release_activity_unknown' });
      assert.equal((await store.read(identity.task, doc.id)).operations[0].outcome, 'running');
    }
  } finally {
    release.resolve();
    await accepted.completion;
    await closing;
  }

  const saved = await store.read(identity.task, doc.id);

  assert.equal(saved.operations[0].id, accepted.operationId);
  assert.equal(saved.operations[0].outcome, phase === 'before' ? 'failed' : 'unknown');
  assert.equal(calls, phase === 'before' ? 0 : 1);
  assert.deepEqual(admission.snapshot().tasks, []);

  const id = admission.acquire('fixture-updater');

  admission.release(id, 'fixture-updater');
}

/**
 * Проверяет готовый bundled launcher. Ровно один fsync родительского каталога
 * отказывает после атомарной публикации registered, пока wrapper ещё ждёт permit.
 */
async function verifyLaunch() {
  const { payload, binary, input, sentinel } = JSON.parse(process.argv[2]);
  const { loadDarwinLaunchVerification } = require(payload);
  const probe = await loadDarwinLaunchVerification(binary);
  const { spawnDarwinRouteProcess, readDarwinLaunchRecords } = probe;
  const records = path.join(input.controlRoot, 'launch-processes');
  const open = fs.open;
  let interrupted = false;

  for (const phase of ['before', 'during']) {
    await verifyAbortedApply(probe, path.dirname(input.controlRoot), phase);
  }

  fs.open = async (file, ...options) => {
    const handle = await open(file, ...options);

    if (file === records && !interrupted) {
      const sync = handle.sync.bind(handle);

      handle.sync = async () => {
        const [current] = await readDarwinLaunchRecords(input.controlRoot, input.task);

        if (current?.phase === 'registered') {
          interrupted = true;

          throw Object.assign(new Error('fixture_directory_fsync'), { code: 'EIO' });
        }

        return sync();
      };
    }

    return handle;
  };

  try {
    assert.deepEqual(await spawnDarwinRouteProcess(input), { state: 'before-spawn' });
  } finally {
    fs.open = open;
  }

  assert.equal(interrupted, true);
  await assert.rejects(fs.lstat(sentinel), { code: 'ENOENT' });
  assert.deepEqual(await readDarwinLaunchRecords(input.controlRoot, input.task), []);

  const retried = await spawnDarwinRouteProcess(input);
  const [registered] = await readDarwinLaunchRecords(input.controlRoot, input.task);

  assert.equal(retried.state, 'launched');
  assert.equal(retried.exit, null);
  assert.equal(registered?.phase, 'registered');
  assert.equal(registered.process.pid, registered.process.sid);

  const deadline = Date.now() + 5000;
  let pid;

  while (Date.now() < deadline) {
    try {
      pid = await fs.readFile(sentinel, 'utf8');

      if (pid) {
        break;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    await pause(50);
  }

  assert.equal(pid, String(registered.process.pid));
  process.stdout.write(JSON.stringify(registered) + '\n');
}

void verifyLaunch().catch((error) => {
  process.stderr.write(String(error.stack ?? error) + '\n');
  process.exitCode = 1;
});
