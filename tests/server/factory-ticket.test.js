// Контракт постановки задачи и форма аргументов единственного route-движка.
//
// Тикет движок читает НЕ на старте, а при сборке bootstrap-контекста — то есть уже
// после подъёма песочницы. Кривое поле обернулось бы отказом 78 через 20–25 минут
// провижининга и потерянным слотом стенда, поэтому правила валидатора продублированы
// в кокпите. Этот файл держит копию честной: он повторяет ровно те же правила, что
// engine/bin/factory-context (read_ticket), и падает, если они разъедутся.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  TICKET_LIMITS, TicketError, buildTicket, serializeTicket, validateTicket, writeTicketFile,
} from '../../server/src/lib/factoryTicket.ts';
import {
  parseRouteWorkTime, routeAbandonArgs, routeCheckArgs, routeGateArgs, routeGotoArgs,
  routeFailure, routeMessage, routeResumeArgs, routeStartArgs, routeWorkTimeArgs, startRegistryIdentity,
} from '../../server/src/lib/factoryRouteCli.ts';

const CONFIG = {
  factoryBin: '/engine/bin/factory',
  routesDir: '/home/u/.factory/routes',
  stateDir: '/home/u/.factory/state',
  factoryControlDir: '/home/u/.factory/control',
};

const BASE = {
  task: '8200',
  title: 'Починить обработку данных',
  description: 'Операция падает на больших выборках.',
  sourceUrl: 'https://portal.example.ru/company/personal/user/1/tasks/task/view/8200/',
};

test('TICKET-01: собранный тикет — ровно шесть полей валидатора движка', () => {
  const ticket = buildTicket({ ...BASE, acceptanceCriteria: ['операция не падает'] });
  assert.deepEqual(Object.keys(ticket).sort(), [
    'acceptanceCriteria', 'description', 'schema', 'sourceUrl', 'taskId', 'title',
  ]);
  assert.equal(ticket.schema, 1);
  // taskId именно строкой: TASK_RE валидатора работает по строке, число он отвергнет.
  assert.equal(ticket.taskId, '8200');
  assert.deepEqual(ticket.acceptanceCriteria, ['операция не падает']);
  // Сериализация ровно та, что уедет в файл: лишних полей объекта в ней нет.
  assert.equal(JSON.parse(serializeTicket({ ...ticket, лишнее: 1 })).лишнее, undefined);
});

test('TICKET-02: пустой список критериев допустим, пустая строка — нет', () => {
  const ticket = buildTicket({ ...BASE, acceptanceCriteria: ['', '   ', 'первый'] });
  assert.deepEqual(ticket.acceptanceCriteria, ['первый']);
  assert.deepEqual(buildTicket(BASE).acceptanceCriteria, []);
  // Критерии формулирует этап-переводчик; выдумывать их эвристикой нельзя — отказ
  // на GATE_ACCEPT откатывает маршрут на build со сбросом семи узлов.
  assert.throws(() => validateTicket({ ...ticket, acceptanceCriteria: [''] }, '8200'), TicketError);
});

test('TICKET-03: заголовок, описание и ссылка обязаны быть непустыми', () => {
  assert.throws(() => buildTicket({ ...BASE, title: '   ' }), TicketError);
  assert.throws(() => buildTicket({ ...BASE, sourceUrl: '' }), TicketError);
  assert.throws(() => buildTicket({ ...BASE, sourceUrl: 'портал.рф/задача/1' }), TicketError);
  // Описание пустым не остаётся: задача без постановки — не задача, поэтому в
  // описание уезжает хотя бы заголовок.
  assert.equal(buildTicket({ ...BASE, description: '' }).description, BASE.title);
});

test('TICKET-04: taskId обязан совпасть с номером запуска', () => {
  const ticket = buildTicket(BASE);
  assert.throws(() => validateTicket(ticket, '8201'), TicketError);
  assert.doesNotThrow(() => validateTicket(ticket, 8200));
});

test('TICKET-05: уточнения и комментарии уезжают в описание своими заголовками', () => {
  const ticket = buildTicket({
    ...BASE,
    sections: [
      { title: '[Внутренние уточнения человека]', text: 'скрин в задаче неактуален' },
      { title: '[Комментарии к задаче из трекера]', text: '— Пётр: только для админов' },
      { title: '[Пусто]', text: '' },
    ],
  });
  assert.match(ticket.description, /^Операция падает на больших выборках\./);
  assert.match(ticket.description, /\[Внутренние уточнения человека\]\nскрин в задаче неактуален/);
  assert.match(ticket.description, /\[Комментарии к задаче из трекера\]\n— Пётр: только для админов/);
  assert.doesNotMatch(ticket.description, /\[Пусто\]/);
});

test('TICKET-06: файл обрезается по 256 КиБ, а не только по длине поля', () => {
  // Кириллица — два байта на символ: 100 000 символов проходят лимит ПОЛЯ и не
  // проходят лимит ФАЙЛА. Резать обязано описание — заголовок и критерии это
  // постановка, терять их молча нельзя.
  const ticket = buildTicket({ ...BASE, description: 'я'.repeat(TICKET_LIMITS.description) });
  const size = Buffer.byteLength(serializeTicket(ticket), 'utf8');
  assert.ok(size <= TICKET_LIMITS.fileBytes, `${size} байт при потолке ${TICKET_LIMITS.fileBytes}`);
  assert.match(ticket.description, /описание обрезано кокпитом/);
  assert.equal(ticket.title, BASE.title);
});

test('TICKET-07: файл пишется абсолютным путём в хранилище кокпита, режимом 600', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-ticket-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const file = await writeTicketFile({ dir, task: '8200', ticket: buildTicket(BASE) });

  // canonical_file движка требует абсолютный путь без symlink-компонентов.
  assert.equal(file, path.join(await realpath(dir), 't8200.ticket.json'));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(parsed.taskId, '8200');
});

test('ARGS-01: каталоги задаются явными аргументами, а не окружением', () => {
  const args = routeStartArgs(CONFIG, {
    task: '8200', profile: 'demo', route: 'feature', ticketFile: '/state/tickets/t8200.ticket.json',
  });
  assert.deepEqual(args, [
    '8200', 'start', '--profile', 'demo', '--route', 'feature',
    '--ticket-json', '/state/tickets/t8200.ticket.json',
    '--routes-dir', CONFIG.routesDir,
    '--state-dir', CONFIG.stateDir,
    '--control-dir', CONFIG.factoryControlDir,
  ]);
  // Окружение здесь не источник runtime roots: они всегда передаются явно.
  for (const build of [
    () => routeResumeArgs(CONFIG, { task: '8200', profile: 'demo', attempt: 'a_1' }),
    () => routeAbandonArgs(CONFIG, {
      task: '8200', profile: 'demo', attempt: 'a_1', reason: 'закрыто',
    }),
    () => routeGotoArgs(CONFIG, {
      task: '8200', profile: 'demo', attempt: 'a_1', node: 'build', reason: 'назад',
    }),
    () => routeWorkTimeArgs(CONFIG, { task: '8200', profile: 'demo', attempt: 'a_1' }),
  ]) {
    const built = build();
    assert.ok(built.includes('--state-dir') && !built.includes('--legacy-state-dir')
      && built.includes('--control-dir') && built.includes('--routes-dir'), built.join(' '));
  }
});

test('ARGS-01c: work-time разбирается только как безопасные целые счётчики', () => {
  assert.deepEqual(parseRouteWorkTime([
    'work_time_s=14157',
    'gate_wait_s=232',
    'last_event_at=1785748665',
  ].join('\n')), {
    workSec: 14157,
    gateWaitSec: 232,
    lastEventSec: 1785748665,
  });
  assert.equal(parseRouteWorkTime('work_time_s=не число'), null);
  assert.equal(parseRouteWorkTime('gate_wait_s=1'), null);
});

test('ARGS-01b: UI launch передаёт immutable debug и delivery inputs явными аргументами', () => {
  const args = routeStartArgs(CONFIG, {
    task: '42',
    profile: 'project-alpha',
    route: 'debug',
    ticketFile: '/state/tickets/t42.ticket.json',
    instrumentationFiles: ['service-a:src/handlers/restore-item.js'],
    diagnosisKind: 'data',
    diagnosisSignal: 'после повторной операции число элементов удваивается',
    deliveryTargets: ['backend=master', 'frontend=main'],
  });
  assert.deepEqual(args.slice(-10), [
    '--instrumentation-file', 'service-a:src/handlers/restore-item.js',
    '--diagnosis-kind', 'data',
    '--diagnosis-signal', 'после повторной операции число элементов удваивается',
    '--delivery-target', 'backend=master',
    '--delivery-target', 'frontend=main',
  ]);
});

test('ARGS-01d: publish launch разрешает task-comment явным флагом движку', () => {
  const args = routeStartArgs(CONFIG, {
    task: '47',
    profile: 'project-alpha',
    route: 'feature',
    ticketFile: '/state/tickets/t47.ticket.json',
    deliveryTargets: ['backend=master', 'frontend=main'],
    taskComment: true,
  });
  // Флаг идёт последним: delivery contract читается из immutable-файла попытки,
  // порядок остальных аргументов от этого не меняется.
  assert.deepEqual(args.slice(-5), [
    '--delivery-target', 'backend=master',
    '--delivery-target', 'frontend=main',
    '--task-comment',
  ]);
  assert.equal(routeStartArgs(CONFIG, {
    task: '47', profile: 'project-alpha', route: 'hunt',
    ticketFile: '/state/tickets/t47.ticket.json',
  }).includes('--task-comment'), false);
});

test('ARGS-02: check не имеет побочных эффектов, gate всегда --commit-only', () => {
  assert.deepEqual(routeCheckArgs(CONFIG, { profile: 'demo', route: 'feature' }), [
    'check', '--profile', 'demo', '--route', 'feature', '--routes-dir', CONFIG.routesDir,
  ]);
  const gate = routeGateArgs(CONFIG, {
    task: '8200', profile: 'demo', attempt: 'a_1', node: 'gate_plan', decision: 'approved',
  });
  assert.ok(gate.includes('--commit-only'), 'без него gate тянет за собой весь следующий этап');
  assert.ok(!gate.includes('--comment'), 'пустой комментарий не передаётся');
});

test('EC-01: catalog hash проходит через check/start, queue dispatch — только через start', () => {
  const catalogHash = 'c'.repeat(64);
  const dispatchId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.deepEqual(routeCheckArgs(CONFIG, {
    profile: 'demo', route: 'feature', expectedCatalogHash: catalogHash,
  }), [
    'check', '--profile', 'demo', '--route', 'feature',
    '--expected-catalog-hash', catalogHash,
    '--routes-dir', CONFIG.routesDir,
  ]);
  const started = routeStartArgs(CONFIG, {
    task: '8200', profile: 'demo', route: 'feature',
    ticketFile: '/state/tickets/t8200.ticket.json',
    expectedCatalogHash: catalogHash,
    queueDispatchId: dispatchId,
  });
  assert.deepEqual(started.slice(8, 12), [
    '--expected-catalog-hash', catalogHash, '--queue-dispatch-id', dispatchId,
  ]);
  assert.throws(() => routeCheckArgs(CONFIG, {
    profile: 'demo', route: 'feature', expectedCatalogHash: 'ABC',
  }), /sha256/);
  assert.throws(() => routeStartArgs(CONFIG, {
    task: '8200', profile: 'demo', route: 'feature',
    ticketFile: '/state/tickets/t8200.ticket.json', queueDispatchId: dispatchId,
  }), /expectedCatalogHash/);
  assert.throws(() => routeStartArgs(CONFIG, {
    task: '8200', profile: 'demo', route: 'feature',
    ticketFile: '/state/tickets/t8200.ticket.json',
    expectedCatalogHash: catalogHash, queueDispatchId: 'not-a-uuid',
  }), /UUID/);
  assert.throws(() => routeStartArgs(CONFIG, {
    task: '8200', profile: 'demo', route: 'feature',
    ticketFile: '/state/tickets/t8200.ticket.json',
    expectedCatalogHash: catalogHash, queueDispatchId: dispatchId.toUpperCase(),
  }), /UUID/);
});

test('ARGS-03: коды отказа движка объясняются человеку', () => {
  assert.match(routeMessage(78, 'die: маршрут не найден'), /контракт/);
  assert.match(routeMessage(73, ''), /занято/);
  assert.match(routeMessage(75, ''), /частично/);
  const preflight = 'runner preflight не пройден [FACTORY_ERROR=runner_preflight_unavailable RUNNERS=kimi,codex]';
  assert.deepEqual(routeFailure(preflight), {
    error: 'runner_preflight_unavailable',
    runners: ['kimi', 'codex'],
    message: 'недоступны исполнители профиля: kimi, codex',
  });
  assert.equal(routeMessage(1, preflight), 'недоступны исполнители профиля: kimi, codex (код 1)');
  assert.equal(routeFailure('FACTORY_ERROR=runner_preflight_unavailable'), null,
    'typed unavailable без runner id считается повреждённым');
  assert.equal(routeFailure('обычная shell-ошибка с кодом 1'), null,
    'голый код 1 не выдаётся за preflight');
  assert.equal(routeMessage(0, ' готово \n'), 'готово');

  const expectedCatalogHash = 'c'.repeat(64);
  const actualCatalogHash = 'd'.repeat(64);
  assert.deepEqual(routeFailure(
    `FACTORY_ERROR=catalog_changed EXPECTED=${expectedCatalogHash} ACTUAL=${actualCatalogHash}`,
  ), {
    error: 'catalog_changed',
    expectedCatalogHash,
    actualCatalogHash,
    message: 'опубликованный каталог изменился после выбора маршрута; поставь задачу заново',
  });
});

test('ARGS-04: запуск подтверждается только полной и не stalled identity маршрута', () => {
  const complete = {
    ATTEMPT_ID: 'a_0123456789abcdef0123456789abcdef',
    ROUTE_HASH: 'a'.repeat(64),
    ORCH_PID: '12345',
    PROFILE: 'demo',
    ROUTE: 'hunt',
    RUN_PROTOCOL: '2',
    CATALOG_PROTOCOL: 'route-v2',
    DELIVERY_MODE: 'disabled',
    STALLED_HUMAN: '0',
  };
  assert.equal(
    startRegistryIdentity(complete, { profile: 'demo', route: 'hunt' }),
    `${complete.ATTEMPT_ID}:${complete.ORCH_PID}:${complete.ROUTE_HASH}`,
  );

  for (const patch of [
    { ATTEMPT_ID: '' },
    { ROUTE_HASH: '' },
    { ROUTE: 'feature' },
    { DELIVERY_MODE: 'pending' },
    { STALLED_HUMAN: '1' },
  ]) {
    assert.equal(startRegistryIdentity({ ...complete, ...patch }, {
      profile: 'demo', route: 'hunt',
    }), null, JSON.stringify(patch));
  }
});

test('EC-04: queue launch требует точную catalog/dispatch/runner registry identity', () => {
  const expectedCatalogHash = 'b'.repeat(64);
  const dispatchId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const complete = {
    ATTEMPT_ID: 'a_0123456789abcdef0123456789abcdef',
    ROUTE_HASH: 'a'.repeat(64),
    CATALOG_HASH: expectedCatalogHash,
    QUEUE_DISPATCH_ID: dispatchId,
    RUNNER_OVERRIDE_PRIMARY: 'codex',
    ORCH_PID: '12345',
    PROFILE: 'demo',
    ROUTE: 'feature',
    RUN_PROTOCOL: '2',
    CATALOG_PROTOCOL: 'route-v2',
    DELIVERY_MODE: 'disabled',
    STALLED_HUMAN: '0',
  };
  const options = {
    profile: 'demo', route: 'feature', expectedCatalogHash,
    queueDispatchId: dispatchId, runnerPrimaryOverride: 'codex',
  };
  assert.ok(startRegistryIdentity(complete, options));
  for (const patch of [
    { CATALOG_HASH: 'c'.repeat(64) },
    { QUEUE_DISPATCH_ID: '00000000-0000-4000-8000-000000000002' },
    { RUNNER_OVERRIDE_PRIMARY: 'claude' },
  ]) assert.equal(startRegistryIdentity({ ...complete, ...patch }, options), null);
});
