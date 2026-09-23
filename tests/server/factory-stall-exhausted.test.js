import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FactoryStateAdapter } from '../../server/src/adapters/factoryState.ts';

// Исчерпанный бюджет повторов: узел коммитится `exhausted` с `action.stop: human`, но
// вердикта агента в событии нет — результата не было ни у одного захода. В сводке такой
// остановке нельзя предлагать арбитра: гейт ответил бы `arc_unknown`, а кнопка, за которой
// стоит отказ, хуже отсутствующей (t7989: «отдать арбитру» рядом с «раннер не получил
// результат»). Вид остановки при этом остаётся `human`, а исход — `exhausted`.
test('сводка исчерпанной остановки не предлагает арбитра и называет исход', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-stall-exhausted-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const attempt = 'a_0e20a3fdcaca6f2bdc2ede03470c9ee4';
  const hash = 'c'.repeat(64);
  const results = path.join(root, 'control', 'protocol-v2', 'tasks', 't7989', 'attempts', attempt,
    'stage-results');
  await mkdir(results, { recursive: true });
  await writeFile(path.join(results, `event.${'0'.repeat(19)}1.${hash}.json`), JSON.stringify({
    kind: 'commit',
    node: 'plan',
    outcome: 'exhausted',
    action: { stop: 'human' },
    at: '2026-09-22T09:35:43Z',
    sequence: 1,
    reason: null,
  }));
  const reason = 'исчерпан бюджет повторов: 3 захода без результата, последний — '
    + 'убит по лимиту времени этапа';

  const adapter = new FactoryStateAdapter({
    stateDir: path.join(root, 'state'),
    profilesDir: path.join(root, 'profiles'),
    controlDir: path.join(root, 'control'),
  });
  const stall = await adapter.summaryStall({
    registry: { STALLED_HUMAN: '1', PLAN: 'failed', PLAN_COMMENT: reason },
    timeline: [
      { ts: '2026-09-22 15:05:11', event: 'route: узел plan: подготовка к исполнению' },
      { ts: '2026-09-22 16:35:51', event: `route: PLAN: маршрут остановлен: human — ${reason}` },
    ],
    daemonAlive: false,
    trusted: { attempt, cursor: { state: 'stopped', stop: 'human' } },
    task: '7989',
  });

  assert.equal(stall.stage, 'PLAN');
  assert.equal(stall.stop, 'human');
  assert.equal(stall.outcome, 'exhausted');
  assert.equal(stall.comment, reason);
  assert.equal(stall.arbitrable, false, 'без вердикта арбитру разбирать нечего');
});
