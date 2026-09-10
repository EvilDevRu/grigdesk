// Контракт раздела «Презентации» на стороне клиента: что принимается за данные
// раздела, а что обязано отвергаться.
//
// Ответ сервера приходит по сети и до проверки данными не является. Особенно это
// важно здесь: по «готовой цели» раздел запускает браузер на адресе стенда, а по
// состоянию задания рисует ход небесплатной работы.
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';

const contract = await compileModule(webFile('../shared/showcaseContracts.ts'));

const SCOPE = {
  targetKind: 'sandbox',
  targetLabel: 'стенд 990001',
  profile: 'demo-profile',
  viewUrl: 'http://127.0.0.1:5192',
  environment: 'read-only',
  capabilities: ['record'],
  screens: [{ id: 'overview', title: 'Обзор', path: '/' }],
  targetFingerprint: 'fingerprint',
  policyRevision: 'policy',
  dataRevision: 'начальные',
  buildRevision: null,
};

const JOB = {
  id: 'job-1',
  projectId: 'project-1',
  kind: 'record',
  state: 'running',
  attempt: 1,
  sequence: 2,
  progress: { index: 1, total: 3, label: 'пишем сцену' },
  error: null,
  startedAt: '2026-09-09T10:00:00.000Z',
  finishedAt: null,
};

test('готовая цель и заблокированная разбираются как разные ветки', () => {
  const ready = {
    status: 'ready',
    ref: { kind: 'sandbox', id: '990001' },
    scope: SCOPE,
  };
  const blocked = {
    status: 'blocked',
    ref: { kind: 'task', id: '990002' },
    reason: 'Стенд не найден в реестре.',
    nextAction: {
      kind: 'open-sandboxes',
      label: 'Открыть «Песочницы»',
      hint: 'Поднимите стенд задачи.',
    },
  };

  assert.deepEqual(contract.parseShowcaseTarget(ready), ready);
  assert.deepEqual(contract.parseShowcaseTarget(blocked), blocked);
});

test('«готово» без области показа целью не считается', () => {
  // Ветку выбирает метка состояния, а дальше работает её собственный декодер:
  // «готово» без области — это расходящийся ответ, и показать по нему кнопку
  // записи значило бы запустить браузер туда, куда сервер ходить не разрешил.
  assert.throws(
    () => contract.parseShowcaseTarget({
      status: 'ready',
      ref: { kind: 'sandbox', id: '990001' },
      reason: 'Стенда нет.',
      nextAction: null,
    }),
    contract.ShowcaseContractError,
  );
});

test('лишние поля ответа не становятся состоянием раздела', () => {
  const parsed = contract.parseShowcaseTarget({
    status: 'ready',
    ref: { kind: 'sandbox', id: '990001' },
    scope: { ...SCOPE, recordUrl: 'http://127.0.0.1:9999', allowedOrigins: ['*'] },
    reason: 'Поле из чужой ветки.',
  });

  assert.equal(parsed.status, 'ready');
  assert.ok(!('reason' in parsed), 'поле чужой ветки в состояние не попадает');
  assert.ok(!('recordUrl' in parsed.scope), 'адрес записи в состояние не попадает');
  assert.ok(!('allowedOrigins' in parsed.scope), 'список назначений в состояние не попадает');
});

test('незнакомое состояние задания не проходит за известное', () => {
  assert.deepEqual(contract.parseShowcaseJob(JOB), JOB);

  for (const invalid of [
    { ...JOB, state: 'почти готово' },
    { ...JOB, kind: 'что-то' },
    { ...JOB, sequence: -1 },
    { ...JOB, sequence: 1.5 },
    { ...JOB, progress: { index: 1, total: 3 } },
    { ...JOB, startedAt: null },
  ]) {
    assert.throws(() => contract.parseShowcaseJob(invalid), contract.ShowcaseContractError);
  }
});

test('вид цели и среда показа закрыты перечислением', () => {
  for (const kind of ['project', 'sandbox', 'task']) {
    const value = {
      status: 'ready',
      ref: { kind, id: 'demo-profile' },
      scope: { ...SCOPE, targetKind: kind },
    };

    assert.equal(contract.parseShowcaseTarget(value).ref.kind, kind);
  }

  assert.throws(
    () => contract.parseShowcaseTarget({
      status: 'ready',
      ref: { kind: 'production', id: 'demo-profile' },
      scope: SCOPE,
    }),
    contract.ShowcaseContractError,
  );

  assert.throws(
    () => contract.parseShowcaseTarget({
      status: 'ready',
      ref: { kind: 'project', id: 'demo-profile' },
      scope: { ...SCOPE, environment: 'production' },
    }),
    contract.ShowcaseContractError,
  );
});

test('событие прогресса проверяется так же, как ответ ручки', () => {
  const event = {
    jobId: 'job-1',
    projectId: 'project-1',
    state: 'running',
    sequence: 4,
    label: 'сборка',
  };

  assert.deepEqual(contract.parseShowcaseProgressEvent(event), event);

  for (const invalid of [
    null,
    { ...event, state: 'идёт' },
    { ...event, sequence: '4' },
    { ...event, label: null },
  ]) {
    assert.throws(
      () => contract.parseShowcaseProgressEvent(invalid),
      contract.ShowcaseContractError,
    );
  }
});

test('каталог голосов приносит и состояние установки', () => {
  const catalog = {
    engines: [
      {
        id: 'piper',
        name: 'Piper (локально)',
        kind: 'local',
        doctor: { status: 'blocked', reason: 'не установлен', install: 'нажмите «Установить»' },
        voices: [],
      },
    ],
    install: {
      available: [
        {
          id: 'irina',
          name: 'Ирина',
          language: 'ru',
          timbre: 'женский',
          byteSize: 58_340_190,
          license: 'GPLv2',
          installed: false,
        },
      ],
      job: {
        id: 'attempt-1',
        engineId: 'piper',
        voiceId: 'irina',
        state: 'running',
        step: 'packages',
        label: 'ставлю движок',
        error: null,
        startedAt: '2026-09-09T10:00:00.000Z',
        finishedAt: null,
      },
    },
  };

  assert.deepEqual(contract.parseShowcaseVoiceCatalog(catalog), catalog);

  for (const invalid of [
    { ...catalog, install: undefined },
    {
      ...catalog,
      install: { ...catalog.install, job: { ...catalog.install.job, state: 'ставится' } },
    },
    {
      ...catalog,
      install: {
        ...catalog.install,
        available: [{ ...catalog.install.available[0], byteSize: '58 МБ' }],
      },
    },
  ]) {
    assert.throws(
      () => contract.parseShowcaseVoiceCatalog(invalid),
      contract.ShowcaseContractError,
    );
  }
});

test('событие установки голоса проверяется так же, как ответ ручки', () => {
  const event = {
    installId: 'attempt-1',
    voiceId: 'irina',
    state: 'succeeded',
    step: 'done',
    label: 'голос готов',
    error: null,
  };

  assert.deepEqual(contract.parseShowcaseVoiceEvent(event), event);

  for (const invalid of [{ ...event, state: 'готово' }, { ...event, label: 3 }]) {
    assert.throws(
      () => contract.parseShowcaseVoiceEvent(invalid),
      contract.ShowcaseContractError,
    );
  }
});

test('ошибка контракта называет путь поля, но не его значение', () => {
  try {
    contract.parseShowcaseJob({ ...JOB, state: 'секретное-значение' });
    assert.fail('ожидалась ошибка контракта');
  } catch (error) {
    assert.ok(error instanceof contract.ShowcaseContractError);
    assert.match(error.message, /job\.state/);
    assert.ok(
      !error.message.includes('секретное-значение'),
      'значение поля в текст ошибки не попадает',
    );
  }
});

test('краткая карточка не выдумывает цель у заблокированного ролика', () => {
  const project = {
    schemaVersion: 1,
    id: 'project-1',
    title: 'Ролик',
    revision: 2,
    ref: { kind: 'task', id: '990002' },
    target: {
      status: 'blocked',
      ref: { kind: 'task', id: '990002' },
      reason: 'Стенд не найден в реестре.',
      nextAction: null,
    },
    brief: [],
    scenes: [],
    decisions: [],
    latestFinal: null,
    createdAt: '2026-09-09T10:00:00.000Z',
    updatedAt: '2026-09-09T11:00:00.000Z',
  };
  const summary = contract.toProjectSummary(contract.parseShowcaseProject(project), 'blocked');

  assert.equal(summary.targetLabel, '');
  assert.equal(summary.state, 'blocked');
  assert.equal(summary.hasFinal, false);
});
