import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import claude, { parseClaudeUsagePayload } from '../../server/src/lib/executors/claude.ts';
import { acceptPatch, projectUsage } from '../../server/src/lib/providerUsageLive.ts';
import { normalizeProviderUsage } from '../../server/src/lib/providerUsage.ts';
import { remainingUsagePercent } from '../../web/src/features/providers/providerUsageSummary.ts';

/**
 * Фальшивый CLI печатает документированные синтетические события без обращения к модели.
 * В stream-режиме дополнительная недельная квота приходит уже между ходами.
 */
async function fixture(t, { idle = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-rate-event-'));
  const samplesPath = new URL('../fixtures/claude-rate-limit-events.jsonl', import.meta.url);
  const samples = (await readFile(samplesPath, 'utf8'))
    .trim().split('\n').map(JSON.parse);
  const weekly = {
    type: 'rate_limit_event',
    rate_limit_info: {
      rateLimitType: 'seven_day',
      utilization: 0.29,
      resetsAt: 1792828800,
    },
  };
  const script = path.join(root, 'cli.mjs');
  const bin = path.join(root, 'claude-fixture');

  await writeFile(script, `
import readline from 'node:readline';
const events = ${JSON.stringify([samples[0], samples[2], weekly])};
const say = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
const answer = () => {
  for (const event of events) say(event);
  say({ type: 'assistant', message: {
    id: 'msg-rate', model: 'fixture-model',
    content: [{ type: 'text', text: 'Готово' }], usage: { input_tokens: 10 },
  } });
  say({ type: 'result', subtype: 'success', result: 'Готово', usage: { output_tokens: 3 } });
};
if (process.argv.includes('--input-format')) {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (!JSON.parse(line).message) return;
    answer();
    if (${idle}) setTimeout(() => say(${JSON.stringify(weekly)}), 35);
  });
} else {
  answer();
}
`);
  await writeFile(bin, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o755 });
  t.after(() => rm(root, { recursive: true, force: true }));

  return { root, config: { claudeBin: bin } };
}

for (const stream of [false, true]) {
  test(`Claude публикует одно событие квоты один раз в разовом пути, stream=${stream}`, async (t) => {
    const f = await fixture(t);
    const patches = [];
    const result = await claude.run({
      ...f,
      cwd: f.root,
      message: 'Квоты',
      onProviderUsage: (patch) => {
        patches.push(patch);

        return true;
      },
      ...(stream ? { onInTurnReady: () => {} } : {}),
    });

    assert.equal(result.reply, 'Готово');
    assert.equal(patches.length, 2, 'rejected без чисел не вызывает обработчик');
    assert.deepEqual(patches[0].bars.map((bar) => [bar.key, bar.pct]),
      [['session', 99.6], ['weekly_all', 28]]);
    assert.equal(remainingUsagePercent(patches[0].bars[0].pct), '<1%');
    assert.equal(patches[0].bars[0].resetsAt, new Date(1792310400 * 1000).toISOString());
    assert.deepEqual(patches[1].bars.map((bar) => bar.key), ['weekly_all']);

    const entry = normalizeProviderUsage({ state: 'ok', bars: [
      ...patches[0].bars,
      {
        key: 'weekly_scopedFixture',
        label: 'Неделя модели',
        pct: 11
      },
    ] });
    const { state } = acceptPatch({
      generation: 0,
      seq: 0,
      bars: new Map()
    },
      entry.bars, patches[1], { now: 1 });

    assert.equal(projectUsage(entry, state).bars[2].pct, 11);
  });
}

test('Claude принимает квоты в простое и не открывает фоновый ход', async (t) => {
  const f = await fixture(t, { idle: true });
  const patches = [];
  let backgrounds = 0;
  const session = claude.session.open({
    ...f,
    cwd: f.root,
    hooks: {
      onProviderUsage: (patch) => {
        patches.push(patch);

        return true;
      },
      onBackgroundStart: () => {
        backgrounds += 1;
      },
    },
  });

  t.after(() => session.close());
  await session.send({ message: 'Квоты' });

  const deadline = Date.now() + 1000;

  while (patches.length < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(patches.length, 3);
  assert.equal(backgrounds, 0);
});

test('сбой обработчика квот не мешает ответу Claude, HTTP-проценты не умножаются повторно', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const result = await claude.run({
    ...f,
    cwd: f.root,
    message: 'Квоты',
    onProviderUsage: () => {
      calls += 1;

      throw new Error('fixture-sink-error');
    },
  });

  assert.equal(result.reply, 'Готово');
  assert.equal(calls, 2);
  assert.equal(parseClaudeUsagePayload({ five_hour: { utilization: 99.6 } })[0].pct, 99.6);
});
