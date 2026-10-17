import assert from 'node:assert/strict';
import test from 'node:test';

import * as decoder from '../../web/src/shared/pluginInstallApi.ts';
import { api } from '../../web/src/shared/apiClient.ts';
import { webInstallJob, webInstallInfo } from './helpers/pluginInstallFixtures.js';

test('WA1: каждый status/stage/kind и current с отдельной recoveryError принимаются целиком', () => {
  for (const kind of ['install', 'update', 'rollback']) {
    for (const status of [
      'running', 'ready', 'applying', 'done', 'failed', 'cancelled', 'interrupted', 'recovery_required',
    ]) {
      const job = webInstallJob(status, kind);

      assert.deepEqual(decoder.decodeInstallJob(job), job);
    }
  }

  for (const stage of ['fetching', 'validating', 'dependencies']) {
    const job = webInstallJob('running', 'update', { stage, percent: stage === 'fetching' ? 40 : null });

    assert.deepEqual(decoder.decodeInstallJob(job), job);
  }

  const current = {
    job: null,
    recoveryError: { code: 'recovery_required', message: 'Копии требуют восстановления.' },
  };

  assert.deepEqual(decoder.decodeInstallCurrent(current), current);

  const job = webInstallJob();

  assert.deepEqual(decoder.decodeInstallCurrent({ job, recoveryError: null }), {
    job,
    recoveryError: null,
  });
});

test('WA3: успешный malformed HTTP не смешивает старую карточку с новой capability', async (t) => {
  const old = decoder.decodeInstallJob(webInstallJob());
  const snapshot = structuredClone(old);
  const invalid = webInstallJob('ready', 'update', { reviewToken: null });
  let card = old;

  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ job: invalid }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));

  await assert.rejects(async () => {
    card = decoder.decodeInstallJobResponse(await api.post('/api/plugin-installs/jobs', {}));
  }, decoder.PluginInstallProtocolError);
  assert.deepEqual(card, snapshot);
  assert.equal(card.id, old.id);
  assert.equal(card.reviewToken, snapshot.reviewToken);

  invalid.reviewToken = 'd'.repeat(64);
  invalid.internalPath = '/private/fixture';
  invalid.preview.settings = { secret: true };

  const accepted = decoder.decodeInstallJobResponse(await api.post('/api/plugin-installs/jobs', {}));

  assert.equal(Object.hasOwn(accepted, 'internalPath'), false);
  assert.equal(Object.hasOwn(accepted.preview, 'settings'), false);
});

test('WA2: malformed поля, связи и archive paths отвергаются как ошибка протокола', () => {
  const changes = {
    commits: [],
    files: [],
    sensitive: [],
    truncated: false,
  };
  const invalid = [null, [], 42, 'job'];
  const mutations = [
    (job) => {
      job.id = 'arbitrary-id';
    },
    (job) => {
      job.kind = 'erase';
    },
    (job) => {
      job.status = 'success';
    },
    (job) => {
      job.stage = 'npm';
    },
    (job) => {
      job.revision = 0;
    },
    (job) => {
      job.revision = Number.MAX_SAFE_INTEGER + 1;
    },
    (job) => {
      job.source.kind = 'Git';
    },
    (job) => {
      job.source.url = '';
    },
    (job) => {
      job.source.url = 'https://user:secret@example.invalid/plugin.git';
    },
    (job) => {
      job.target.sha = 'short';
    },
    (job) => {
      job.target.tag = 'main';
    },
    (job) => {
      job.target.version = '1.2.0-beta';
    },
    (job) => {
      job.reviewToken = 'f'.repeat(63);
    },
    (job) => {
      job.createdAt = '2026-02-30T00:00:00.000Z';
    },
    (job) => {
      job.updatedAt = 'yesterday';
    },
    (job) => {
      job.preview.id = 'another';
    },
    (job) => {
      job.preview.id = '__proto__';
      job.pluginId = '__proto__';
    },
    (job) => {
      job.preview.version = '2.0.0';
    },
    (job) => {
      job.preview.source = { kind: 'git', url: 'file:///other.git' };
    },
    (job) => {
      job.preview.target = { ...job.target, sha: 'c'.repeat(40) };
    },
    (job) => {
      job.preview = null;
    },
    (job) => {
      job.target = null;
    },
    (job) => {
      job.reviewToken = null;
    },
    (job) => {
      job.stage = 'fetching';
    },
    (job) => {
      job.percent = 120;
    },
    (job) => {
      job.finishedAt = job.createdAt;
    },
    (job) => {
      job.error = { code: 'busy', message: '' };
    },
    (job) => {
      job.preview.warnings = [7];
    },
    (job) => {
      job.preview.changes = {
        ...changes,
        files: [{ status: true, path: 'web/a.js' }],
      };
    },
    (job) => {
      job.backupRef = '/tmp/backup';
    },
    (job) => {
      job.backupRef = 'replaced/demo-backup';
    },
    (job) => {
      job.backupRef = '../demo';
    },
    (job) => {
      job.backupRef = 'demo-20260230T000000000Z-' + job.id;
    },
    (job) => {
      job.backupRef = 'other-20260101T000000000Z-' + job.id;
    },
  ];

  for (const mutate of mutations) {
    const job = webInstallJob();

    mutate(job);
    invalid.push(job);
  }

  invalid.push(webInstallJob('running', 'install', { stage: null }));
  invalid.push(webInstallJob('running', 'install', { stage: 'dependencies', percent: 40 }));
  invalid.push(webInstallJob('done', 'rollback', { finishedAt: null }));

  for (const [index, value] of invalid.entries()) {
    assert.throws(
      () => decoder.decodeInstallJob(value), decoder.PluginInstallProtocolError, `invalid ${index}`,
    );
  }

  const job = webInstallJob('done');

  job.backupRef = 'demo-20260101T000000000Z-' + job.id;
  assert.equal(decoder.decodeInstallJob(job).backupRef, job.backupRef);
});

test('WA4: InstallInfo проверяет весь previous и флаги; optional install совместим со старым API', () => {
  const info = webInstallInfo();

  info.latest = {
    version: '1.2.0',
    tag: 'v1.2.0',
    sha: 'a'.repeat(64),
  };
  info.checkedAt = '2026-01-02T12:00:00.000Z';
  info.previous.source = { kind: 'mirror', url: 'mirror:fixture' };
  info.previous.npmDirs = ['.', 'server/node_modules'];
  assert.deepEqual(decoder.decodeInstallInfo(info), info);
  assert.equal(decoder.decodeOptionalInstall(undefined), undefined);
  assert.equal(decoder.decodeOptionalInstall(null), null);
  assert.deepEqual(decoder.decodeOptionalInstall(info), info);

  for (const [key, bad] of [
    ['previous', { version: '1.0.0' }],
    ['rollbackAvailable', 'true'],
    ['rollbackError', { code: 'previous_changed' }],
    ['revision', 1.5],
    ['payloadDigest', 'x'.repeat(64)],
    ['installedAt', '2026-13-01T00:00:00.000Z'],
    ['previous', null],
  ]) {
    assert.throws(
      () => decoder.decodeInstallInfo({ ...info, [key]: bad }), decoder.PluginInstallProtocolError,
    );
  }

  const blocked = webInstallInfo({
    rollbackAvailable: false,
    rollbackError: { code: 'previous_changed', message: 'Прежняя копия повреждена.' },
  });

  assert.deepEqual(decoder.decodeInstallInfo(blocked), blocked);
});

test('WA-values: браузер принимает неизвестный корректный код ошибки', () => {
  const job = webInstallJob('failed', 'install', {
    error: { code: 'fixture_unknown_code', message: 'Безопасная ошибка.' },
  });

  assert.deepEqual(decoder.decodeInstallJob(job), job);
});
