import { decodeInstallState } from '../../server/src/lib/packageInstall/stateValidation.ts';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { emptyInstallState, PluginInstallStateStore } from '../../server/src/lib/packageInstall/stateStore.ts';
import { applyingState, installedRecord, installJob } from './helpers/pluginInstallState.js';
import { writeDurableFile } from '../../server/src/lib/durableFile.ts';

/**
 * State и work находятся в отдельных подпапках временного root.
 * Evidence проверяется на настоящем файловом дереве, файлы сохраняются при отказе.
 */
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-install-state-'));
  const statePath = path.join(root, 'state/install.json');
  const evidence = path.join(root, 'work/jobs/interrupted/package/server.js');
  const options = {
    statePath,
    hasWorkEvidence: async () => !!await lstat(evidence).catch(() => null),
    ...overrides,
  };

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.dirname(statePath), { recursive: true });

  return {
    root,
    statePath,
    evidence,
    options,
    store: new PluginInstallStateStore(options),
  };
}

test('S1: ENOENT пуст только без work evidence, остатки не удаляются', async (t) => {
  const { store, evidence } = await fixture(t);

  assert.deepEqual(await store.read(), emptyInstallState());
  await mkdir(path.dirname(evidence), { recursive: true });
  await writeFile(evidence, 'preserve');
  await assert.rejects(store.read(), { code: 'state_invalid' });
  assert.equal(await readFile(evidence, 'utf8'), 'preserve');
});

test('S2: durable mutate/read сохраняют вложенный record/intent и независимые копии, mode0600', async (t) => {
  const { store, statePath } = await fixture(t);
  const initial = applyingState();
  const published = await store.mutate(() => initial);
  const read = await store.read();

  assert.deepEqual(read, initial);
  assert.equal((await lstat(statePath)).mode & 0o777, 0o600);
  published.plugins.demo.version = '9.9.9';
  read.apply.targetRecord.npmDirs.push('malicious');
  initial.plugins.demo.source.kind = 'changed';
  assert.equal((await store.read()).plugins.demo.version, '1.0.0');
  assert.deepEqual((await store.read()).apply.targetRecord.npmDirs, []);
  assert.equal((await store.read()).plugins.demo.source.kind, 'git');
});

test('S3: schema/JSON/record/read errors/размер не заменяют исходный state', async (t) => {
  const wrongRecord = emptyInstallState();

  wrongRecord.plugins.demo = { ...installedRecord(), payloadDigest: 'not-a-digest' };

  for (const text of ['{broken', JSON.stringify({ ...emptyInstallState(), schemaVersion: 2 }),
    JSON.stringify(wrongRecord), ' '.repeat(10 * 1024 * 1024 + 1)]) {
    const { store, statePath } = await fixture(t);

    await writeFile(statePath, text);
    await assert.rejects(store.read(), { code: 'state_invalid' });
    assert.equal(await readFile(statePath, 'utf8'), text, 'исходный файл сохранён');
  }

  for (const code of ['EACCES', 'EIO']) {
    const { store, statePath } = await fixture(t, {
      readText: async () => {
        throw Object.assign(new Error('synthetic read failure'), { code });
      },
    });

    await writeFile(statePath, JSON.stringify(emptyInstallState()));
    await assert.rejects(store.read(), { code: 'state_invalid' });
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).schemaVersion, 1);
  }
});

test('S4: десять concurrent storage mutate сохраняют все изменения', async (t) => {
  const { store, root } = await fixture(t);
  const barrierFile = path.join(root, 'io-barrier');

  await writeFile(barrierFile, 'fixture');
  await Promise.all(Array.from({ length: 10 }, () => store.mutate(async (state) => {
    await readFile(barrierFile);
    state.nextRevision += 1;
  })));
  assert.equal((await store.read()).nextRevision, 11);
});

test('S5: UUID/SHA/связь intent/job/identity и prototype keys отвергнуты без эффектов', async (t) => {
  const mutations = [
    (state) => {
      state.job.id = '../not-a-uuid';
    },
    (state) => {
      state.apply.jobId = 'not-a-uuid';
    },
    (state) => {
      state.job.target.sha = 'short';
    },
    (state) => {
      state.apply.candidate = '/external/path';
    },
    (state) => {
      state.apply.candidate.path = '/external/path';
    },
    (state) => {
      state.apply.pluginId = 'other';
    },
    (state) => {
      state.job.status = 'maybe-done';
    },
    (state) => {
      state.plugins['Bad Id'] = installedRecord();
    },
    (state) => {
      Object.defineProperty(state.plugins, '__proto__', { value: installedRecord(), enumerable: true });
    },
    (state) => {
      state.job.preview.constructor = {};
    },
  ];

  for (const mutate of mutations) {
    const { store, statePath, evidence } = await fixture(t);
    const state = applyingState();

    mutate(state);
    await mkdir(path.dirname(evidence), { recursive: true });
    await writeFile(evidence, 'preserve');
    await writeFile(statePath, JSON.stringify(state));
    await assert.rejects(store.read(), { code: 'state_invalid' });
    assert.equal(await readFile(evidence, 'utf8'), 'preserve');
    assert.equal(await readFile(statePath, 'utf8'), JSON.stringify(state));
  }
});

test('S6: writer error после rename не скрывает уже опубликованный intent и outcome', async (t) => {
  const { store } = await fixture(t, {
    write: async (file, text) => {
      await writeDurableFile(file, text);

      throw Object.assign(new Error('synthetic fsync uncertainty'), { code: 'EIO' });
    },
  });
  const intent = applyingState();

  await assert.rejects(store.mutate(() => intent), { code: 'EIO' });
  assert.deepEqual(await store.read(), intent, 'диск сохраняет фактически опубликованный intent');

  const outcome = structuredClone(intent);

  outcome.plugins.demo = outcome.apply.targetRecord;
  outcome.apply = null;
  outcome.job.status = 'done';
  outcome.job.finishedAt = outcome.job.updatedAt;
  outcome.completedJobs[outcome.job.id] = outcome.job;
  await assert.rejects(store.mutate(() => outcome), { code: 'EIO' });
  assert.deepEqual(await store.read(), outcome, 'done найден после исключения writer');
});

test('S7: последние32 summaries не вытесняют live job/intent/receipt; worker и rollback links строгие',
  async (t) => {
    const { store } = await fixture(t);
    const state = applyingState('rollback');
    const receiptJob = installJob('done', 'rollback');

    state.lastRollback.demo = {
      requestId: randomUUID(),
      inputHash: 'e'.repeat(64),
      baseRevision: 1,
      job: receiptJob,
    };

    for (let index = 0; index < 40; index += 1) {
      const job = installJob('done');

      job.finishedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      job.updatedAt = job.finishedAt;
      job.preview.changes = {
        commits: [],
        files: [],
        sensitive: [],
        truncated: false,
      };
      state.completedJobs[job.id] = job;
    }

    const published = await store.mutate(() => state);

    assert.equal(Object.keys(published.completedJobs).length, 32);
    assert.deepEqual(published.job, state.job);
    assert.deepEqual(published.apply, state.apply);
    assert.deepEqual(published.lastRollback.demo, state.lastRollback.demo);
    assert.ok(Object.values(published.completedJobs).every((job) => job.preview.changes === null));

    const workerId = randomUUID();
    const validWorker = {
      commandId: workerId,
      supervisorPid: 301,
      supervisorStartTime: '1234',
      pid: 302,
      pgid: 302,
      startTime: '1235',
    };
    const mutations = [
      (value) => {
        value.workers.bad = validWorker;
      },
      (value) => {
        value.workers[workerId] = { ...validWorker, pgid: 1 };
      },
      (value) => {
        value.workers[workerId] = { ...validWorker, startTime: 'unknown' };
      },
      (value) => {
        value.apply.rollbackReceiptInput = null;
      },
      (value) => {
        value.apply.rollbackReceiptInput.baseRevision = 9;
      },
      (value) => {
        value.lastRollback.demo.requestId = '../invalid';
      },
      (value) => {
        value.apply.destination = 'replaced';
        value.apply.archiveKey = `other-20260101T000000000Z-${value.apply.transactionId}`;
      },
      (value) => {
        value.apply.destination = 'replaced';
        value.apply.archiveKey = `demo-20260101T000000000Z-${randomUUID()}`;
      },
      (value) => {
        value.apply.destination = 'replaced';
        value.apply.archiveKey = `../demo-20260101T000000000Z-${value.apply.transactionId}`;
      },
    ];

    for (const mutate of mutations) {
      const invalid = structuredClone(published);
      const isolated = await fixture(t);

      mutate(invalid);
      await writeFile(isolated.statePath, JSON.stringify(invalid));
      await assert.rejects(isolated.store.read(), { code: 'state_invalid' });
      assert.equal(await readFile(isolated.statePath, 'utf8'), JSON.stringify(invalid));
    }
  });

test('S7b: nextRevision должна опережать все сохранённые revisions', async (t) => {
  const { store, statePath } = await fixture(t);
  const state = applyingState();

  state.nextRevision = 1;
  await writeFile(statePath, JSON.stringify(state));
  await assert.rejects(store.read(), { code: 'state_invalid' });
  assert.equal(await readFile(statePath, 'utf8'), JSON.stringify(state));
});

test('S8: durable rollback receipt поддерживает тот же RFC UUID диапазон и регистр, что HTTP', async (t) => {
  const { store } = await fixture(t);
  const job = installJob('done', 'rollback');
  const state = emptyInstallState();
  const requestId = 'AAAA0000-0000-7000-8000-000000000008';

  state.job = job;
  state.nextRevision = 2;
  state.lastRollback.demo = {
    requestId,
    inputHash: 'e'.repeat(64),
    baseRevision: 1,
    job: structuredClone(job),
  };

  await assert.doesNotReject(store.mutate(() => state));
  assert.equal((await store.read()).lastRollback.demo.requestId, requestId);
});

test('S-values: диск отвергает лишние поля job/preview и неизвестный код ошибки', () => {
  for (const preview of [false, true]) {
    const state = emptyInstallState();

    state.nextRevision = 2;
    state.job = installJob('ready');
    (preview ? state.job.preview : state.job).extra = true;
    assert.throws(() => decodeInstallState(state), { code: 'state_invalid' });
  }

  const state = emptyInstallState();

  state.nextRevision = 2;
  state.job = installJob('failed');
  state.job.error = { code: 'fixture_unknown_code', message: 'Безопасная ошибка.' };
  assert.throws(() => decodeInstallState(state), { code: 'state_invalid' });
});

test('S-values-progress: диск принимает прежние сочетания running stage/percent', () => {
  for (const [stage, percent] of [[null, 0], ['dependencies', 40]]) {
    const state = emptyInstallState();

    state.nextRevision = 2;
    state.job = {
      ...installJob('running'),
      stage,
      percent,
    };
    assert.deepEqual(decodeInstallState(state), state);
  }
});
