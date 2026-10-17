import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTIVE_STATUSES,
  Studio3dContractError,
  parseStudio3d,
} from '../../shared/studio3d/studio3dContracts.ts';

/**
 * Версия в том виде, в каком её отдаёт сервер. Сценарии портят одно поле и
 * проверяют, что окно не примет такой ответ.
 */
function versionDto(patch = {}) {
  return {
    libraryId: '00000000-0000-4000-8000-000000000099',
    id: 'v01-generate-ab12',
    seq: 1,
    parent: null,
    kind: 'model',
    operation: 'image-to-model',
    provider: 'tripo',
    label: 'Модель из картинки',
    status: 'running',
    progress: 40,
    etaSeconds: 12,
    params: {
      model: 'v3.1-20260211',
      texture: true,
      face_limit: null,
      animations: ['preset:walk']
    },
    files: [],
    preview: null,
    stats: null,
    task: {
      provider: 'tripo',
      id: '00000000-0000-4000-8000-000000000001',
      type: 'image_to_model'
    },
    cost: {
      estimated: 30,
      actual: null,
      free: false,
      unit: {
        one: 'кредит',
        few: 'кредита',
        many: 'кредитов'
      },
      state: 'reserved'
    },
    error: null,
    origin: 'section',
    createdAt: '2026-10-11T10:00:00Z',
    updatedAt: '2026-10-11T10:00:05Z',
    savedTo: [],
    rigCheck: null,
    intentId: '00000000-0000-4000-8000-000000000001',
    childId: 'child-1',
    waitReason: null,
    retryAvailable: false,
    retryReason: null,
    views: [],
    mainFileId: null,
    ...patch,
  };
}

test('CT-01 версия принимается целиком, поля формы — только простые значения', () => {
  const decoded = parseStudio3d.version(versionDto());

  assert.equal(decoded.status, 'running');
  assert.deepEqual(decoded.params.animations, ['preset:walk']);

  const nested = versionDto({ params: { bad: { nested: true } } });

  assert.throws(() => parseStudio3d.version(nested), Studio3dContractError);
});

test('CT-02 незнакомый статус или вид версии — ошибка контракта', () => {
  assert.throws(() => parseStudio3d.version(versionDto({ status: 'teleported' })), /поле version\.status/);
  assert.throws(() => parseStudio3d.version(versionDto({ kind: 'hologram' })), /поле version\.kind/);
});

test('CT-03 отсутствующие необязательные поля читаются как null', () => {
  const decoded = parseStudio3d.version(versionDto({
    etaSeconds: undefined,
    rigCheck: undefined
  }));

  assert.equal(decoded.etaSeconds, null);
  assert.equal(decoded.rigCheck, null);
});

test('FIX-01 unknown активен, unresolved сохраняет отдельный финансовый исход', () => {
  assert.equal(ACTIVE_STATUSES.includes('unknown'), true);
  assert.equal(ACTIVE_STATUSES.includes('unresolved'), false);
  assert.equal(parseStudio3d.version(versionDto({ status: 'unresolved' })).status, 'unresolved');
});

test('FIX-01 проверка скелета декодируется как самостоятельный lifecycle', () => {
  const common = {
    jobId: '00000000-0000-4000-8000-000000000001',
    childId: 'child-1',
    at: '2026-10-11T10:00:00Z'
  };
  const checks = [
    { ...common, status: 'pending' },
    {
      ...common,
      status: 'ready',
      riggable: true,
      rigType: 'biped'
    },
    {
      ...common,
      status: 'failed',
      error: {
        kind: 'network',
        message: 'Нет связи',
        detail: null
      }
    },
    {
      ...common,
      status: 'unknown',
      error: null
    },
    {
      ...common,
      status: 'unresolved',
      error: null
    },
  ];

  for (const rigCheck of checks) {
    const decoded = parseStudio3d.version(versionDto({ rigCheck }));

    assert.equal(decoded.rigCheck.status, rigCheck.status);
    assert.equal(decoded.rigCheck.childId, 'child-1');
  }

  assert.throws(() => parseStudio3d.version(versionDto({
    rigCheck: { ...common, status: 'ready' }
  })), Studio3dContractError);
});

test('FIX-01 удалённая проекция run имеет прежний intent, без выдуманной модели', () => {
  const decoded = parseStudio3d.run({
    libraryId: '00000000-0000-4000-8000-000000000099',
    intentId: '00000000-0000-4000-8000-000000000001',
    deleted: true,
    model: null,
    versions: []
  });

  assert.equal(decoded.deleted, true);
  assert.equal(decoded.model, null);
  assert.equal(decoded.intentId, '00000000-0000-4000-8000-000000000001');
});

test('FIX-01 job различает children, причины ожидания и неизвестный расход', () => {
  const job = {
    libraryId: '00000000-0000-4000-8000-000000000099',
    intentId: '00000000-0000-4000-8000-000000000001',
    deleted: false,
    modelId: 'hero-0001',
    updatedAt: '2026-10-11T10:00:00Z',
    children: [{
      childId: 'child-2',
      versionId: 'v02-animate-0002',
      operation: 'animate',
      status: 'unknown',
      waitReason: 'Верните прежний доступ',
      estimated: 10,
      actual: null,
      paymentState: 'unknown',
      taskId: null,
      candidates: [{
        taskId: 'fixture-task-02',
        type: 'animate_retarget',
        createdAt: null,
        credits: 10
      }],
      retryAvailable: false,
      retryReason: 'Принятие заказа неизвестно',
      error: null
    }],
  };
  const decoded = parseStudio3d.job(job);

  assert.equal(decoded.children[0].childId, 'child-2');
  assert.equal(decoded.children[0].paymentState, 'unknown');
  assert.equal(decoded.children[0].retryAvailable, false);
  assert.throws(() => parseStudio3d.job({
    ...job,
    children: [{ ...job.children[0], paymentState: 'refunded-by-assumption' }]
  }), Studio3dContractError);
});

test('FIX-01 обязательные числовые поля не пропускают NaN и Infinity', () => {
  assert.throws(() => parseStudio3d.version(versionDto({
    params: { height: NaN }
  })), Studio3dContractError);
  assert.throws(() => parseStudio3d.version(versionDto({
    progress: 150
  })), Studio3dContractError);
});

test('FIX-01 DTO пачки сохраняют цены, libraryId и самостоятельные children', () => {
  const libraryId = '00000000-0000-4000-8000-000000000099';
  const intentId = '00000000-0000-4000-8000-000000000001';
  const row = {
    provider: 'tripo',
    operation: 'text-to-model',
    values: { prompt: 'Тестовая модель' },
    name: 'Модель',
    project: null,
    category: null,
    expectedPrice: 30.5
  };
  const quoted = {
    libraryId,
    snapshot: {
      libraryId,
      rows: [row],
      catalogVersion: 'fixture-v2',
      totalEstimated: 30.5,
      unit: null
    },
    snapshotHash: 'fixture-sha256',
    totalEstimated: 30.5,
    unit: null
  };
  const result = parseStudio3d.batchRun({
    libraryId,
    intentId,
    children: [{
      childId: 'row-1',
      intentId,
      modelId: null,
      status: 'unknown',
      estimated: 30.5
    }],
    totalEstimated: 30.5,
    unit: null,
    status: 'unknown'
  });

  assert.equal(parseStudio3d.batchQuote(quoted).snapshot.rows[0].expectedPrice, 30.5);
  assert.equal(result.children[0].status, 'unknown');
  assert.throws(() => parseStudio3d.batchQuote({ ...quoted, accountKey: 'fixture-private' }),
    Studio3dContractError);
  assert.throws(() => parseStudio3d.batchQuote({ ...quoted, totalEstimated: -1 }), Studio3dContractError);
  assert.throws(() => parseStudio3d.batchQuote({ ...quoted, libraryId: '../other' }), Studio3dContractError);
});

test('FIX-01 state, расходы и ошибки строго декодируются без предположения полноты', () => {
  const libraryId = '00000000-0000-4000-8000-000000000099';
  const state = parseStudio3d.state({
    libraryId,
    library: {
      dir: '/fixture/library',
      ok: true,
      error: null,
      bytes: 20,
      freeBytes: null,
      lowDisk: false,
      modelBytes: 10,
      inputBytes: 5,
      temporaryBytes: 5
    },
    providers: [{
      id: 'tripo',
      name: 'Tripo',
      local: false,
      available: true,
      unit: null,
      balance: { available: 0, reserved: 0 },
      billingUrl: 'https://fixture.example/billing'
    }],
    active: 0,
    autoImport: false
  });
  const groups = ['tripo', 'another'].map((provider) => ({
    provider,
    unit: {
      one: provider,
      few: provider,
      many: provider
    },
    actual: 0.5,
    sectionActual: 0.5,
    externalActual: 0,
    reserved: 10,
    estimated: 10,
    refunded: 0,
    unknownCount: 1,
    unknownEstimated: 10
  }));

  const tasks = parseStudio3d.tasks({
    libraryId,
    active: [],
    recent: [],
    external: [],
    week: { partial: true, groups },
    historyPartial: true,
    historyError: 'Нет связи'
  });

  assert.equal(state.providers[0].balance.available, 0);
  assert.equal(tasks.week.partial, true);
  assert.equal(tasks.week.groups[1].unit.one, 'another');
  assert.throws(() => parseStudio3d.version({ ...versionDto(), credentials: 'fixture' }),
    Studio3dContractError);
  assert.throws(() => parseStudio3d.run({
    libraryId,
    intentId: '00000000-0000-4000-8000-000000000001',
    deleted: false,
    model: null,
    versions: []
  }), Studio3dContractError);
});
