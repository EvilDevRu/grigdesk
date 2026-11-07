// Готовность раздела: отчёт обязан говорить правду о том, что можно делать сейчас.
//
// Проверяется главное свойство: пункт не исчезает и не молчит. Недоступная
// операция остаётся в списке с причиной, а доступная не объявляется готовой
// раньше, чем ею действительно можно воспользоваться.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createDoctorReport } from '../../server/src/lib/showcase/doctorReport.ts';

function engine(overrides = {}) {
  return {
    id: 'piper',
    name: 'Piper (локально)',
    kind: 'local',
    doctor: { status: 'ready', reason: 'работает', install: '' },
    voices: [],
    ...overrides,
  };
}

function reportWith(overrides = {}) {
  return createDoctorReport({
    resolveBrowserPath: async () => null,
    showcaseDir: path.join(os.tmpdir(), 'showcase-doctor-нет-такого'),
    voiceStatuses: async () => [engine()],
    transcribeAvailable: false,
    resolveTarget: async () => ({
      status: 'blocked',
      ref: { kind: 'project', id: 'demo-profile' },
      reason: 'профиль не объявил экраны',
      nextAction: null,
    }),
    ...overrides,
  });
}

function operationOf(report, id) {
  return report.operations.find((operation) => operation.id === id);
}

test('готовый движок называет себя, а не «голос подключён»', async () => {
  const report = await reportWith().doctor();
  const voice = operationOf(report, 'voice');

  assert.equal(voice.status, 'ready');
  assert.match(voice.reason, /Piper/);
});

test('неготовый голос остаётся в списке с причиной и подсказкой', async () => {
  const report = await reportWith({
    voiceStatuses: async () => [engine({
      doctor: {
        status: 'blocked',
        reason: 'Локальный синтез не установлен.',
        install: 'Установите голос кнопкой в разделе.',
      },
    })],
  }).doctor();
  const voice = operationOf(report, 'voice');

  assert.equal(voice.status, 'blocked');
  assert.match(voice.reason, /не установлен/);
  assert.match(voice.reason, /кнопк/i, 'человеку сказано, что делать');
});

test('упавший реестр голосов не выкидывает пункт из отчёта', async () => {
  const report = await reportWith({
    voiceStatuses: async () => {
      throw new Error('реестр недоступен');
    },
  }).doctor();
  const voice = operationOf(report, 'voice');

  assert.ok(voice, 'исчезнувший пункт человек читает как «всё в порядке»');
  assert.equal(voice.status, 'blocked');
});

test('проверка речи не объявляется готовой без распознавания', async () => {
  const withoutAsr = await reportWith().doctor();

  assert.equal(operationOf(withoutAsr, 'speech').status, 'unknown');
  assert.match(operationOf(withoutAsr, 'speech').reason, /пропущенн/);

  const withAsr = await reportWith({ transcribeAvailable: true }).doctor();

  assert.equal(operationOf(withAsr, 'speech').status, 'ready');
});

test('проверка сети остаётся ручной: она ходит на адрес показа', async () => {
  const report = await reportWith().doctor();

  assert.equal(operationOf(report, 'network').manual, true);
  assert.equal(operationOf(report, 'network').status, 'unknown');
});

test('без выбранной цели пункт цели не притворяется ни готовым, ни сломанным', async () => {
  const report = await reportWith().doctor();

  assert.equal(operationOf(report, 'target').status, 'unknown');
  assert.equal(operationOf(report, 'login').status, 'unknown');
});

test('заблокированная цель приносит свою причину, а вход честно неизвестен', async () => {
  const report = await reportWith().doctor({ kind: 'project', id: 'demo-profile' }, 'demo-profile');

  assert.equal(operationOf(report, 'target').status, 'blocked');
  assert.match(operationOf(report, 'target').reason, /не объявил экраны/);
});

test('существующий каталог роликов виден как готовое хранилище', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-doctor-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const existing = await reportWith({ showcaseDir: root }).doctor();

  assert.equal(operationOf(existing, 'storage').status, 'ready');

  // Ещё не созданный каталог — предупреждение, а не поломка: он появится вместе
  // с первым роликом, и пугать этим человека незачем.
  const missing = await reportWith().doctor();

  assert.equal(operationOf(missing, 'storage').status, 'warning');
});
