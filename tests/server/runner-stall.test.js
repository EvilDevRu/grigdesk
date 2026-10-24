import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FactoryStateAdapter } from '../../server/src/adapters/factoryState.ts';

const attempt = `a_${'a'.repeat(32)}`;
const capacity = 'Selected model is at capacity. Please try a different model.';

/**
 * Старая остановка содержит только unknown, но её exact run сохранил настоящий отказ.
 * Проверяем оба публичных пути чтения без запуска сервера и изменения журнала попытки.
 */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-runner-stall-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const stateDir = path.join(root, 'state');
  const profilesDir = path.join(root, 'profiles');
  const runDir = path.join(stateDir, 'logs/runs/t49/BUILD/run-1');

  await mkdir(runDir, { recursive: true });
  await mkdir(path.join(profilesDir, 'demo'), { recursive: true });
  await writeFile(path.join(profilesDir, 'demo/graph.json'), JSON.stringify({
    default_route: 'feature',
    nodes: { build: ['agent', 'Сборка', ''] },
    keys: { build: 'BUILD' },
    optional: {},
    routes: { feature: { pos: { build: [0, 0] }, edges: [] } },
  }));

  const registry = [
    'PROFILE=demo', 'ROUTE=feature', 'WF_STATUS=running', 'STALLED_HUMAN=1', 'BUILD=failed',
    `ATTEMPT_ID=${attempt}`, 'ACTIVE_RUN_BUILD=run-1', 'ACTIVE_EPOCH_BUILD=3',
    'BUILD_COMMENT=исчерпан бюджет повторов: 2 захода без результата, последний — unknown',
  ].join('\n');
  const meta = [
    'SOURCE=runtime', 'RUNNER=codex', 'TASK=t49', 'STAGE=BUILD', 'RUN_ID=run-1', 'EPOCH=3',
    `ATTEMPT_ID=${attempt}`, 'MODEL=example-sol', 'CLI_VERSION=0.159.2', 'RESULT_CLASS=unknown', 'RC=1',
    `STARTED_AT=${new Date('2026-09-30T20:00:05').toISOString()}`,
    `FINISHED_AT=${new Date('2026-09-30T20:12:18').toISOString()}`,
  ].join('\n');

  await writeFile(path.join(stateDir, 't49.pipeline'), registry);
  await writeFile(path.join(stateDir, 'logs/t49.stages.log'), [
    '2026-09-30 20:00:00 [t49] route: узел build: подготовка к исполнению',
    '2026-09-30 20:12:38 [t49] route: BUILD: маршрут остановлен: human — '
      + 'исчерпан бюджет повторов: 2 захода без результата, последний — unknown',
  ].join('\n'));
  await writeFile(path.join(runDir, 'meta.env'), meta);
  await writeFile(path.join(runDir, 'events.jsonl'), JSON.stringify({
    type: 'turn.failed', error: { message: capacity },
  }) + '\n');

  return {
    stateDir,
    runDir,
    meta,
    registry,
    adapter: new FactoryStateAdapter({ stateDir, profilesDir }),
  };
}

test('сводка и граф старой остановки показывают перегрузку без нового запуска', async (t) => {
  const f = await fixture(t);
  const detail = await f.adapter.getTaskDetail('49');
  const graph = await f.adapter.getTaskGraph('49');

  for (const stall of [detail.stall, graph.stall, graph.nodeMeta.build.stall]) {
    assert.match(stall.title, /модель «example-sol» перегружена/);
    assert.match(stall.title, /2 захода/);
    assert.doesNotMatch(stall.title, /unknown/);
    assert.doesNotMatch(stall.comment, /unknown/);
    assert.match(stall.detail, /Selected model is at capacity/);
    assert.doesNotMatch(stall.hint, /подними класс времени/);
    assert.equal(stall.outcome, 'exhausted');
    assert.equal(stall.stop, 'human');
  }

  assert.equal(await readFile(path.join(f.stateDir, 't49.pipeline'), 'utf8'), f.registry);
  assert.equal(await readFile(path.join(f.runDir, 'meta.env'), 'utf8'), f.meta);
});

test('чужие эпоха, попытка, узел и предыдущий визит не объясняют остановку', async (t) => {
  const f = await fixture(t);

  for (const meta of [
    f.meta.replace('EPOCH=3', 'EPOCH=2'),
    f.meta.replace(attempt, `a_${'b'.repeat(32)}`),
    f.meta.replace('STAGE=BUILD', 'STAGE=REVIEW'),
    f.meta.replace('TASK=t49', 'TASK=t50'),
    f.meta.replace('RUN_ID=run-1', 'RUN_ID=run-2'),
    f.meta.replace('RC=1', 'RC=0'),
    f.meta.replace('RC=1', 'RC=124'),
    f.meta.replace('2026-09-30', '2026-09-29'),
  ]) {
    await writeFile(path.join(f.runDir, 'meta.env'), meta);

    assert.doesNotMatch((await f.adapter.getTaskDetail('49')).stall.title, /перегружена/);
  }
});

test('неизвестная ошибка видна текстом, а ссылка и вывод команды не становятся причиной', async (t) => {
  const f = await fixture(t);
  const events = path.join(f.runDir, 'events.jsonl');

  await writeFile(events, JSON.stringify({ type: 'turn.failed', error: { message: 'Provider E_NEW' } }));
  assert.match((await f.adapter.getTaskDetail('49')).stall.title, /Provider E_NEW/);

  await writeFile(events, JSON.stringify({
    type: 'item.completed', item: { type: 'command_execution', aggregated_output: capacity },
  }));
  assert.doesNotMatch((await f.adapter.getTaskDetail('49')).stall.title, /перегружена/);

  await rm(events);

  const external = path.join(f.stateDir, 'external.jsonl');

  await writeFile(external, JSON.stringify({ type: 'turn.failed', error: { message: capacity } }));
  await symlink(external, events);
  assert.doesNotMatch((await f.adapter.getTaskDetail('49')).stall.title, /перегружена/);
});

test('подмена каталога запуска ссылкой не разрешает читать чужой поток', async (t) => {
  const f = await fixture(t);
  const moved = path.join(f.stateDir, 'moved-run');

  await rename(f.runDir, moved);
  await symlink(moved, f.runDir);

  assert.doesNotMatch((await f.adapter.getTaskDetail('49')).stall.title, /перегружена/);
});

test('новый diagnostic mirror показывает причину без повторного чтения большого журнала', async (t) => {
  const f = await fixture(t);

  await writeFile(
    path.join(f.runDir, 'meta.env'),
    `${f.meta}\nFAILURE_CODE=capacity\nFAILURE_MESSAGE=${capacity}`,
  );
  await rm(path.join(f.runDir, 'events.jsonl'));

  assert.match((await f.adapter.getTaskDetail('49')).stall.title, /перегружена/);
});

test('ошибка в хвосте большого журнала читается без полной истории инструментов', async (t) => {
  const f = await fixture(t);

  await writeFile(path.join(f.runDir, 'events.jsonl'), JSON.stringify({
    type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'x'.repeat(600000) },
  }) + '\n' + JSON.stringify({ type: 'turn.failed', error: { message: capacity } }) + '\n');

  assert.match((await f.adapter.getTaskDetail('49')).stall.title, /перегружена/);
});

test('остановка этапа GLM показывает отказ wrapper-а из mirror и из потока', async (t) => {
  const f = await fixture(t);
  const glm = f.meta.replace('RUNNER=codex', 'RUNNER=glm')
    .replace('MODEL=example-sol', 'MODEL=["zai","glm-5.3"]');
  const events = path.join(f.runDir, 'events.jsonl');

  await writeFile(path.join(f.runDir, 'meta.env'), `${glm}\nFAILURE_CODE=glm_key_missing\n`
    + 'FAILURE_MESSAGE=GLM: нет ключа Обычного API\n');
  assert.match((await f.adapter.getTaskDetail('49')).stall.title, /нет ключа Обычного API/);

  await writeFile(path.join(f.runDir, 'meta.env'), glm);
  await writeFile(events, `${JSON.stringify({
    event: 'wrapper_error',
    code: 'glm_turn_failed',
    message: 'GLM: сеть оборвалась',
  })}\n`);
  assert.match((await f.adapter.getTaskDetail('49')).stall.title, /сеть оборвалась/);

  await writeFile(events, `${JSON.stringify({ type: 'turn.failed', error: { message: capacity } })}\n`);
  assert.doesNotMatch((await f.adapter.getTaskDetail('49')).stall.title, /перегружена/);
});

test('provider presentation сохраняет причину модель и заходы в summary и graph', async (t) => {
  const f = await fixture(t);
  const detail = await f.adapter.getTaskDetail('49');
  const graph = await f.adapter.getTaskGraph('49');

  for (const stall of [detail.stall, graph.stall, graph.nodeMeta.build.stall]) {
    assert.ok(stall.presentation, 'подтверждённая перегрузка не передана в краткий вид');
    assert.equal(stall.presentation.attempts, 2);
    assert.equal(stall.presentation.model, 'example-sol');
    assert.match(stall.presentation.lastFailure, /модель перегружена/);
    assert.doesNotMatch(stall.presentation.lastFailure, /example-sol/);
    assert.match(JSON.stringify(stall.presentation.details), /перегруж|провайдер/i);
    assert.doesNotMatch(stall.presentation.details.action, /подними.*врем|увелич.*врем/i);
    assert.doesNotMatch(stall.presentation.details.cause || '', /таймаут|лимит времени|не успел/i);
  }

  assert.deepEqual(graph.stall.presentation, detail.stall.presentation);
  assert.deepEqual(graph.nodeMeta.build.stall.presentation, detail.stall.presentation);
});

for (const [name, message, expected] of [
  ['лимит', 'Rate limit reached. Please try again later.', /частот|лимит/i],
  ['неизвестный подтверждённый отказ', 'Provider E_NEW: unknown field', /Provider E_NEW: unknown field/],
]) {
  test(`provider presentation уточняется: ${name}`, async (t) => {
    const f = await fixture(t);

    await writeFile(path.join(f.runDir, 'events.jsonl'), JSON.stringify({
      type: 'turn.failed', error: { message },
    }));

    const detail = await f.adapter.getTaskDetail('49');
    const graph = await f.adapter.getTaskGraph('49');

    for (const stall of [detail.stall, graph.stall]) {
      assert.ok(stall.presentation, 'нет краткого представления отказа');
      assert.match(stall.presentation.lastFailure, expected);
      assert.equal(stall.presentation.attempts, 2);
      assert.equal(stall.presentation.model, 'example-sol');
      assert.doesNotMatch(stall.presentation.lastFailure, /example-sol/);
    }
  });
}

test('без подходящего evidence presentation не выдумывает модель и причину провайдера', async (t) => {
  const f = await fixture(t);

  await writeFile(path.join(f.runDir, 'meta.env'), f.meta.replace('EPOCH=3', 'EPOCH=2'));

  const stall = (await f.adapter.getTaskDetail('49')).stall;

  assert.ok(stall.presentation, 'общая остановка тоже имеет краткое представление');
  assert.equal(stall.presentation.attempts, 2);
  assert.equal(stall.presentation.lastFailure, 'причина не названа');
  assert.ok(!stall.presentation.model);
  assert.doesNotMatch(JSON.stringify(stall.presentation), /перегружена|example-sol/);
});
