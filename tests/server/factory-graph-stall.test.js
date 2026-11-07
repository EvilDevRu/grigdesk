import assert from 'node:assert/strict';
import {
  mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FactoryStateAdapter } from '../../server/src/adapters/factoryState.ts';
import { detectStall } from '../../server/src/lib/stall.ts';

test('graph exposes a human stall on the affected node instead of showing it as running', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-graph-stall-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const stateDir = path.join(root, 'state');
  const profilesDir = path.join(root, 'profiles');
  await mkdir(path.join(stateDir, 'logs'), { recursive: true });
  await mkdir(path.join(profilesDir, 'demo'), { recursive: true });
  await writeFile(path.join(profilesDir, 'demo', 'graph.json'), JSON.stringify({
    default_route: 'feature',
    nodes: {
      review: ['agent', '🤖 Ревью', ''],
      ship: ['human', '👤 Merge / Ship', ''],
    },
    keys: { review: 'REVIEW', ship: 'SHIP' },
    optional: {},
    routes: {
      feature: {
        pos: { review: [100, 50], ship: [300, 50] },
        edges: [['review', 'ship', '', 'plain', 'h']],
      },
    },
  }));
  await writeFile(path.join(stateDir, 't49.pipeline'), [
    'PROFILE=demo',
    'ROUTE=feature',
    'WF_STATUS=running',
    'STALLED_HUMAN=1',
    'REVIEW=running',
    'REVIEW_AT=2026-07-28 22:26:52',
    'REVIEW_FAILS=113',
    'SHIP=pending',
    '',
  ].join('\n'));
  await writeFile(path.join(stateDir, 'logs', 't49.stages.log'), [
    '2026-07-28 22:26:52 [t49] REVIEW: 3 попытки без результата — СТОП, нужен человек',
    '',
  ].join('\n'));

  const graph = await new FactoryStateAdapter({ stateDir, profilesDir }).getTaskGraph('49');

  assert.equal(graph.stall.stage, 'REVIEW');
  assert.equal(graph.stall.node, 'review');
  assert.match(graph.stall.title, /трижды не отчитался/);
  assert.equal(graph.statuses.review, 'stall');
  assert.equal(graph.progress.current, 'review');
  assert.deepEqual(graph.nodeMeta.review.stall, graph.stall);
});

test('route environment rc=75 is classified without prescribing shared cleanup', () => {
  const stall = detectStall({
    registry: { STALLED_HUMAN: '1' },
    daemonAlive: false,
    logText: [
      '2026-08-02 13:51:34 [t44] v2: обнаружена частично созданная песочница; автоматическое удаление запрещено',
      '2026-08-02 13:51:34 [t44] v2: среда профиля не готова (код 75)',
      '',
    ].join('\n'),
  });
  assert.equal(stall.stage, 'SANDBOX');
  assert.match(stall.title, /среда профиля не готова/);
  assert.match(stall.hint, /shared-ресурсы не удаляй/);
});

test('typed no-progress stop identifies the exact reviewer node', () => {
  const stall = detectStall({
    registry: {
      STALLED_HUMAN: '1',
      REVIEW_COMMENT: 'валидный regex всё ещё возвращает 422',
    },
    daemonAlive: false,
    logText: [
      '2026-08-03 11:15:00 [t43] REVIEW: маршрут остановлен: no-progress',
      '',
    ].join('\n'),
  });

  assert.equal(stall.stage, 'REVIEW');
  assert.match(stall.title, /не меняют набор замечаний/);
  assert.match(stall.hint, /отложенным/);
  assert.equal(stall.comment, 'валидный regex всё ещё возвращает 422');
});

// Оркестратор v2 пишет строки журнала с префиксом `route: `. Правила сторожа
// достались от v1 и якорятся на начало строки, поэтому на живых журналах не
// совпадало НИ ОДНО правило: любой затык v2 показывался как «причина не нашлась
// в журнале». Тесты этого не ловили — фикстуры были в форме v1, без префикса.
test('строка журнала v2 с префиксом route: распознаётся', () => {
  const stall = detectStall({
    registry: { STALLED_HUMAN: '1' },
    daemonAlive: false,
    logText: [
      '2026-08-10 00:46:09 [t48] route: REVIEW: маршрут остановлен: no-progress',
      '',
    ].join('\n'),
  });

  assert.equal(stall.stage, 'REVIEW');
  assert.match(stall.title, /не меняют набор замечаний/);
});

// Движок вычисляет точную причину остановки (повтор набора / осцилляция /
// расширение области) и с некоторых пор пишет её в журнал после тире. Пока её
// там не было, человек читал generic «повтор ИЛИ осцилляция» в момент, когда
// движок точно знал, что именно произошло, и шёл раскапывать ledger руками.
test('точная причина остановки доезжает до заголовка', () => {
  const stall = detectStall({
    registry: { STALLED_HUMAN: '1' },
    daemonAlive: false,
    logText: [
      '2026-08-10 00:46:09 [t48] REVIEW: маршрут остановлен: no-progress'
        + ' — повторяется тот же набор открытых замечаний после одного ремонта',
      '',
    ].join('\n'),
  });

  assert.equal(stall.stage, 'REVIEW');
  assert.match(stall.title, /повторяется тот же набор открытых замечаний/);
});

// Финал маршрута v2 — не обрыв. Формулировку движка поменяли, а сторож остался на
// v1-строке: доведённый до конца прогон висел как «✖ оборвалась» с советом «запусти
// заново» поверх уже закрытой попытки.
test('завершённый маршрут v2 не считается обрывом', () => {
  const stall = detectStall({
    registry: { WF_STATUS: 'running', GATE_ACCEPT: 'done', RESULT: 'completed' },
    daemonAlive: false,
    logText: [
      '2026-09-22 15:01:46 [t90002] route: gate gate_accept=approved зафиксирован',
      '2026-09-22 15:01:47 [t90002] route: маршрут завершён; хвост маршрута подтверждён',
      '',
    ].join('\n'),
  });
  assert.equal(stall, null);
});

// Журналы прогонов до снятия узла ретро заканчиваются прежней фразой: архив читается
// теми же правилами, что и живой журнал.
test('архивный журнал v2 с хвостом ретро по-прежнему читается как завершённый', () => {
  const stall = detectStall({
    registry: { WF_STATUS: 'running', RETRO: 'done', RESULT: 'completed' },
    daemonAlive: false,
    logText: [
      '2026-08-04 15:01:46 [t90002] route: узел retro: подготовка к исполнению',
      '2026-08-04 15:04:26 [t90002] route: маршрут завершён; SHIP и RETRO подтверждены',
      '',
    ].join('\n'),
  });
  assert.equal(stall, null);
});

test('архивный журнал v1 по-прежнему читается как завершённый', () => {
  const stall = detectStall({
    registry: {},
    daemonAlive: false,
    logText: '2026-05-01 10:00:00 [t7001] конвейер завершён\n',
  });
  assert.equal(stall, null);
});

// Выгрузку отложенных находок движок пишет следом за финалом. Живой журнал 08.10.2026
// кончался ею, и доведённый до публикации маршрут читался как «✖ оборвалась».
test('доведённый маршрут с отложенными находками не читается как оборванный', async () => {
  const factory = await readFile(new URL('../../engine/bin/factory', import.meta.url), 'utf8');

  assert.ok(
    factory.includes('v2_log "отложено находок: $count — список в t${task}.deferred.md"'),
    'движок сменил строку выгрузки — правило хвоста в stall.ts осталось без источника',
  );

  const stall = detectStall({
    registry: {
      WF_STATUS: 'running',
      RESULT: 'completed',
      STALLED_HUMAN: '0',
    },
    daemonAlive: false,
    logText: [
      '2026-10-08 14:59:57 [t90004] route: узел ship: подготовка к исполнению',
      '2026-10-08 15:03:52 [t90004] route: маршрут завершён; хвост маршрута подтверждён',
      '2026-10-08 15:03:52 [t90004] route: отложено находок: 6 — список в t90004.deferred.md',
      '',
    ].join('\n'),
  });

  assert.equal(stall, null);
});

// Незакрытая лиза блокирует следующий прогон по тем же ресурсам, поэтому строка
// «маршрут завершён, но…» обязана остаться видимой, а не тонуть в слове «завершён».
test('маршрут, не отпустивший shared lease, остаётся видимым', () => {
  const stall = detectStall({
    registry: { WF_STATUS: 'running' },
    daemonAlive: false,
    logText: [
      '2026-08-04 15:04:26 [t90003] route: маршрут завершён, но shared lease не освобождён (код 73)',
      '',
    ].join('\n'),
  });
  assert.equal(stall.kind, 'crashed');
  assert.match(stall.detail, /shared lease не освобождён/);
});

// Узел остановки нужен и в СВОДКЕ, которую читает `/api/tasks`, а не только в графе.
// По нему автоматический арбитр отличает «эту остановку я уже отдал человеку» от
// «маршрут встал в другом месте». Пока сводка узла не несла, сравнение не совпадало
// никогда: 28.08.2026 арбитр вернул решение человеку, через час взял ту же остановку
// повторно и решил её сам, сдвинув курсор задачи, о которой человека только что спросили.
test('сводка задачи называет узел остановки, а не только граф', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-stall-summary-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const attempt = 'a_06d6476159f1ff19374909045f71ade7';
  const hash = 'f'.repeat(64);
  const results = path.join(root, 'control', 'protocol-v2', 'tasks', 't8507', 'attempts', attempt,
    'stage-results');
  await mkdir(results, { recursive: true });
  await writeFile(path.join(results, `event.${'0'.repeat(20)}.${hash}.json`), JSON.stringify({
    kind: 'commit',
    node: 'build',
    outcome: 'failed',
    action: { stop: 'human' },
    at: '2026-08-28T17:03:40Z',
    verdict: { owner: 'plan', reviewed: [], findings: [] },
  }));

  const adapter = new FactoryStateAdapter({
    stateDir: path.join(root, 'state'),
    profilesDir: path.join(root, 'profiles'),
    controlDir: path.join(root, 'control'),
  });
  const stall = await adapter.summaryStall({
    registry: { STALLED_HUMAN: '1', BUILD: 'running' },
    timeline: [{ ts: '2026-08-28 20:03:40', event: 'route: BUILD: маршрут остановлен: human' }],
    daemonAlive: false,
    trusted: { attempt, cursor: { state: 'stopped', stop: 'human' } },
    task: '8507',
  });

  assert.equal(stall.stage, 'BUILD');
  assert.equal(stall.node, 'build', 'узел берётся у вердикта остановки — он уже прочитан');
  assert.equal(stall.arbitrable, true);
});
