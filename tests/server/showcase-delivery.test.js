// Доставка готового ролика: внешний и необратимый эффект.
//
// Проверяется то, из-за чего такие отправки обычно и вредят: ушёл не тот файл,
// ушёл дважды, ушёл после того как ролик пересобрали, и «ошибка» на месте
// неизвестного исхода — когда получатель на самом деле всё получил.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHANNEL_LIMITS,
  prepareDeliveryPlan,
  runDelivery,
} from '../../server/src/lib/showcase/delivery.ts';

function artifact(kind, id, overrides = {}) {
  return {
    id,
    kind,
    inputHash: 'input-1',
    contentHash: `${id}-content`,
    producerVersion: 'v1',
    durationMs: 60_000,
    byteSize: 4 * 1024 * 1024,
    ...overrides,
  };
}

function projectFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'project-1',
    title: 'Ролик о готовой работе',
    revision: 5,
    ref: { kind: 'sandbox', id: '990001' },
    target: {
      status: 'blocked',
      ref: { kind: 'sandbox', id: '990001' },
      reason: 'не важно для доставки',
      nextAction: null,
    },
    brief: [],
    scenes: [],
    decisions: [],
    latestFinal: {
      video: artifact('final', 'final-1'),
      subtitles: artifact('subtitles', 'subtitles-1', { byteSize: 2048, durationMs: null }),
      manifestId: 'manifest-1',
      builtAt: '2026-09-09T12:00:00.000Z',
      current: true,
    },
    createdAt: '2026-09-09T10:00:00.000Z',
    updatedAt: '2026-09-09T12:00:00.000Z',
    ...overrides,
  };
}

function planFor(project, overrides = {}) {
  return prepareDeliveryPlan({
    project,
    channel: 'b24',
    recipient: '4242',
    recipientLabel: 'задача 4242',
    includeSubtitles: true,
    ...overrides,
  });
}

function senderStub(overrides = {}) {
  const calls = [];

  return {
    calls,
    upload: async (attachment) => {
      calls.push(['upload', attachment.artifactId]);

      return `file-${attachment.artifactId}`;
    },
    attach: async (fileIds) => {
      calls.push(['attach', fileIds.join(',')]);

      return 'delivery-1';
    },
    ...overrides,
  };
}

test('план перечисляет точные байты, которые подтверждает человек', () => {
  const plan = planFor(projectFixture());

  assert.equal(plan.attachments.length, 2);
  assert.deepEqual(
    plan.attachments.map((item) => [item.name, item.contentHash]),
    [['showcase.mp4', 'final-1-content'], ['showcase.srt', 'subtitles-1-content']],
  );
  assert.ok(plan.fingerprint, 'у плана обязан быть отпечаток');
});

test('несобранный и устаревший ролик отправлять нельзя', () => {
  assert.throws(
    () => planFor(projectFixture({ latestFinal: null })),
    (error) => error.code === 'no_final',
  );

  const stale = projectFixture();

  assert.throws(
    () => planFor({ ...stale, latestFinal: { ...stale.latestFinal, current: false } }),
    (error) => error.code === 'final_stale',
  );
});

test('смена получателя или канала меняет отпечаток плана', () => {
  const project = projectFixture();
  const base = planFor(project);

  assert.notEqual(planFor(project, { recipient: '9999' }).fingerprint, base.fingerprint);
  assert.notEqual(planFor(project, { channel: 'telegram' }).fingerprint, base.fingerprint);
  assert.notEqual(planFor(project, { includeSubtitles: false }).fingerprint, base.fingerprint);
});

test('пересборка ролика делает прежнее подтверждение недействительным', async () => {
  const project = projectFixture();
  const oldPlan = planFor(project);
  const rebuilt = projectFixture({
    latestFinal: {
      ...project.latestFinal,
      video: artifact('final', 'final-2'),
    },
  });
  const newPlan = planFor(rebuilt);

  assert.notEqual(newPlan.fingerprint, oldPlan.fingerprint);

  await assert.rejects(
    () => runDelivery({
      plan: newPlan,
      decisionFingerprint: oldPlan.fingerprint,
      sender: senderStub(),
      existing: [],
    }),
    (error) => error.code === 'delivery_decision_stale',
  );
});

test('файл больше предела канала не уходит, и предел назван до отправки', async () => {
  const heavy = projectFixture({
    latestFinal: {
      ...projectFixture().latestFinal,
      video: artifact('final', 'final-big', { byteSize: CHANNEL_LIMITS.telegram.maxBytes + 1 }),
    },
  });
  const plan = planFor(heavy, { channel: 'telegram', recipient: '-1001' });
  const sender = senderStub();

  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /больше предела канала Telegram/);

  await assert.rejects(
    () => runDelivery({
      plan,
      decisionFingerprint: plan.fingerprint,
      sender,
      existing: [],
    }),
    (error) => error.code === 'delivery_blocked',
  );

  assert.deepEqual(sender.calls, [], 'до канала дело не дошло');
});

test('успешная отправка идёт этапами и сохраняет идентификаторы файлов', async () => {
  const plan = planFor(projectFixture());
  const sender = senderStub();
  const record = await runDelivery({
    plan,
    decisionFingerprint: plan.fingerprint,
    sender,
    existing: [],
  });

  assert.equal(record.state, 'sent');
  assert.deepEqual(sender.calls, [
    ['upload', 'final-1'],
    ['upload', 'subtitles-1'],
    ['attach', 'file-final-1,file-subtitles-1'],
  ]);
  assert.equal(record.stageIds['final-1'], 'file-final-1');
  assert.equal(record.stageIds.delivery, 'delivery-1');
});

test('двойной клик возвращает ту же отправку, а не вторую', async () => {
  const plan = planFor(projectFixture());
  const sender = senderStub();
  const first = await runDelivery({
    plan,
    decisionFingerprint: plan.fingerprint,
    sender,
    existing: [],
  });
  const second = await runDelivery({
    plan,
    decisionFingerprint: plan.fingerprint,
    sender,
    existing: [first],
  });

  assert.equal(second.id, first.id);
  assert.equal(sender.calls.length, 3, 'канал больше не трогали');
});

test('потерянный ответ — неизвестный исход, а не отказ', async () => {
  const plan = planFor(projectFixture());
  const timeout = Object.assign(new Error('истекло время ожидания'), { code: 'ETIMEDOUT' });
  const record = await runDelivery({
    plan,
    decisionFingerprint: plan.fingerprint,
    sender: senderStub({
      attach: async () => {
        throw timeout;
      },
    }),
    existing: [],
  });

  assert.equal(record.state, 'outcome_unknown');
  assert.match(record.reason, /проверьте вручную/);
});

test('неизвестный исход не повторяется автоматически', async () => {
  const plan = planFor(projectFixture());
  const unknown = {
    id: 'prev',
    channel: 'b24',
    recipient: '4242',
    fingerprint: plan.fingerprint,
    state: 'outcome_unknown',
    reason: 'ответ потерян',
    stageIds: {},
    startedAt: '2026-09-09T12:10:00.000Z',
    finishedAt: '2026-09-09T12:11:00.000Z',
  };
  const sender = senderStub();
  const record = await runDelivery({
    plan,
    decisionFingerprint: plan.fingerprint,
    sender,
    existing: [unknown],
  });

  assert.equal(record.id, 'prev', 'решение о повторе принимает человек, а не раздел');
  assert.deepEqual(sender.calls, []);
});

test('явный отказ канала остаётся отказом, а загруженное — в журнале', async () => {
  const plan = planFor(projectFixture());
  const record = await runDelivery({
    plan,
    decisionFingerprint: plan.fingerprint,
    sender: senderStub({
      upload: async (attachment) => {
        if (attachment.artifactId === 'subtitles-1') {
          throw new Error('диск получателя переполнен');
        }

        return `file-${attachment.artifactId}`;
      },
    }),
    existing: [],
  });

  assert.equal(record.state, 'failed');
  assert.match(record.reason, /диск получателя переполнен/);
  assert.equal(
    record.stageIds['final-1'],
    'file-final-1',
    'уже загруженный файл остаётся известен: грузить его снова незачем',
  );
});

test('провалившаяся отправка не мешает новой попытке человека', async () => {
  const plan = planFor(projectFixture());
  const failed = {
    id: 'prev',
    channel: 'b24',
    recipient: '4242',
    fingerprint: plan.fingerprint,
    state: 'failed',
    reason: 'канал ответил отказом',
    stageIds: {},
    startedAt: '2026-09-09T12:10:00.000Z',
    finishedAt: '2026-09-09T12:11:00.000Z',
  };
  const sender = senderStub();
  const record = await runDelivery({
    plan,
    decisionFingerprint: plan.fingerprint,
    sender,
    existing: [failed],
  });

  assert.equal(record.state, 'sent');
  assert.notEqual(record.id, 'prev');
});

test('каналы честно объявляют, чего им не хватает', async () => {
  const { deliveryChannelStatuses, senderFor } = await import(
    '../../server/src/lib/showcase/deliveryChannels.ts'
  );
  const statuses = deliveryChannelStatuses({
    tracker: { uploadDiskFile: async () => ({ id: 'file-1' }) },
    telegramConnected: () => true,
  });

  assert.deepEqual(statuses.map((item) => item.id), ['b24', 'telegram']);

  for (const status of statuses) {
    assert.equal(status.ready, false, `${status.id} пока не готов`);
    assert.ok(status.missing, 'у неготового канала названо недостающее');
  }

  // Неготовый канал отказывает ДО загрузки: файл, повисший на диске получателя
  // без прикрепления, хуже, чем неначатая отправка.
  const sender = senderFor('b24', { tracker: { uploadDiskFile: async () => ({ id: 'file-1' }) } });

  await assert.rejects(
    () => sender.upload(
      {
        artifactId: 'final-1',
        name: 'showcase.mp4',
        mediaType: 'video/mp4',
        byteSize: 1024,
        contentHash: 'hash',
      },
      { channel: 'b24' },
    ),
    (error) => error.code === 'channel_not_ready' && /прикрепить/.test(error.message),
  );
});

test('неподключённый портал и Telegram называют свою причину', async () => {
  const { deliveryChannelStatuses } = await import(
    '../../server/src/lib/showcase/deliveryChannels.ts'
  );
  const statuses = deliveryChannelStatuses({});

  assert.match(statuses[0].reason, /Портал не подключён/);
  assert.match(statuses[1].reason, /не подключён/);
});
