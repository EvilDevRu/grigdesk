import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeChatRunSnapshot } from '../../shared/chat/chatRun.ts';
import { chatStatus } from '../../web/src/views/chat/chatStatus.ts';

const selection = {
  providerId: 'next-provider',
  modelId: 'next-model',
  modelLabel: 'Следующая модель',
};
const snapshot = {
  chatKey: 'chat-status',
  runId: 'run-a',
  providerId: 'running-provider',
  requestedModelId: 'requested-model',
  cwd: '/project/source',
  extraDirs: ['/project/shared'],
};
const session = {
  id: snapshot.chatKey,
  workdirState: { committed: { cwd: '/committed/path', extraDirs: [] } },
  messages: [],
};
const runtime = {
  runId: snapshot.runId,
  active: true,
  snapshot,
};

test('работающий run сильнее mutable-селекта, committed cwd и очереди следующего сообщения', () => {
  const view = chatStatus({ ...session, messages: [{ role: 'user', queued: true }] }, runtime, selection);

  assert.equal(view.phase, 'running');
  assert.equal(view.providerId, snapshot.providerId);
  assert.equal(view.modelId, snapshot.requestedModelId);
  assert.equal(view.modelKind, 'запрошена');
  assert.equal(view.cwd, snapshot.cwd);
  assert.deepEqual(view.extraDirs, snapshot.extraDirs);
});

test('подтверждение сессии отличается от модели ответа, fallback фактом не становится', () => {
  for (const modelSource of ['session', 'response']) {
    const confirmed = {
      ...snapshot,
      actualModelId: 'confirmed-model',
      modelSource,
    };
    const view = chatStatus(session, { ...runtime, snapshot: confirmed }, selection);

    assert.equal(view.modelId, 'confirmed-model');
    assert.equal(view.modelKind, 'сообщена');
    assert.match(view.modelDetail, modelSource === 'session' ? /модель сессии/ : /Модель ответа/);
  }

  const normalized = normalizeChatRunSnapshot({ ...snapshot, actualModelId: 'fallback' });

  assert.equal(normalized.actualModelId, undefined);
  assert.equal(normalizeChatRunSnapshot({ ...snapshot, runId: '' }), null);
});

test('простой, отправка и очередь называют параметры следующей отправки', () => {
  const fixtures = [
    ['idle', session],
    ['sending', { ...session, messages: [{ role: 'user', delivery: 'sending' }] }],
    ['queued', { ...session, messages: [{ role: 'user', queued: true }] }],
  ];

  for (const [phase, fixture] of fixtures) {
    const view = chatStatus(fixture, null, selection);

    assert.equal(view.phase, phase);
    assert.equal(view.modelKind, 'выбрана');
    assert.equal(view.modelId, selection.modelId);
    assert.equal(view.cwd, '/committed/path');
    assert.equal(view.thinking, false);
  }
});

test('compact, фон и старый сервер не получают обычный таймер и выбранные параметры run', () => {
  const compact = chatStatus(session, { ...runtime, compact: true }, selection);

  assert.equal(compact.phase, 'compact');
  assert.equal(compact.thinking, false);
  assert.equal(compact.modelId, snapshot.requestedModelId);

  for (const source of ['background', 'managed']) {
    const view = chatStatus(session, {
      ...runtime,
      snapshot: null,
      source,
    }, selection);

    assert.equal(view.providerId, '');
    assert.equal(view.cwd, '');
    assert.equal(view.modelId, '');
    assert.equal(view.thinking, false);
    assert.match(view.detail, /не подтверждены/);
  }
});

test('переход папки оставляет committed, чужой снимок не подтверждает запуск', () => {
  const proposed = {
    ...session,
    workdirChanging: true,
    workdirProposal: {},
    workdirPreview: { target: { cwd: '/proposed/path' } },
  };
  const view = chatStatus(proposed, null, selection);

  assert.equal(view.phase, 'workdir');
  assert.equal(view.cwd, '/committed/path');
  assert.equal(chatStatus(session, { ...runtime, snapshot: { ...snapshot, runId: 'old' } }, selection)
    .modelId, '');
  assert.equal(chatStatus({ ...session, workdirState: {} }, null, selection).cwd, '');
  assert.equal(chatStatus({
    ...session,
    workdirState: {},
    workdirPreview: proposed.workdirPreview,
  },
    null, selection).cwdDetail, 'Папка для следующего запуска');
});

test('фоновый запуск со снимком показывает модель и папку процесса', () => {
  const view = chatStatus(session, { ...runtime, source: 'background' }, selection);

  assert.equal(view.phase, 'running');
  assert.equal(view.modelId, snapshot.requestedModelId);
  assert.equal(view.cwd, snapshot.cwd);
});
