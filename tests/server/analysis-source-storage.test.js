import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { Analyzer } from '../../server/src/lib/analysis/analyzer.ts';
import {
  analysisSourceFixture, completed, eventually, packageBytes, sourceQuery,
} from './helpers/analysisSource.js';

/**
 * Читает пакет из канонического пространства пары по принятому плану.
 * Эталон пути вычисляется из полного source, а не из значения ответа модели.
 */
function scopedFile(fx, source, suffix) {
  const scope = createHash('sha256').update(source).digest('hex');

  return path.join(fx.config.analysisDir, 'by-source', scope, `t42.${suffix}`);
}

test('SOURCE-STORAGE-01: A42 и B42 имеют независимые пакеты, дедуп и dismiss', async (t) => {
  const fx = await analysisSourceFixture(t, { held: true });
  const enqueue = (source) => fx.request('POST', '/api/tasks/42/analyze', { source });
  const first = await enqueue(fx.a.source);
  const duplicate = await enqueue(fx.a.source);
  const second = await enqueue(fx.b.source);

  assert.equal(first.json().outcome, 'queued');
  assert.equal(duplicate.json().outcome, 'already_queued');
  assert.equal(second.json().outcome, 'queued', 'B42 не должна дедуплицироваться с A42');

  fx.analyzer._active = 0;
  fx.analyzer.pluginToggled(true);
  await eventually(() => fx.analyzer._jobs.size, (size) => size === 0);

  for (const [context, label] of [[fx.a, 'A'], [fx.b, 'B']]) {
    const detail = await completed(fx, context.source);

    assert.equal(detail.analysis.summary, `Оценка ${label}`);
    assert.equal(detail.note, `Разведка ${label}`);
    assert.equal(detail.analysis.questions[0].id, `q-${label}`);

    const answer = await fx.request('POST', `/api/tasks/42/clarifications?${sourceQuery(context.source)}`, {
      answers: [{ questionId: `q-${label}`, text: `Ответ ${label}` }],
    });

    assert.equal(answer.statusCode, 200, answer.body);
    assert.match(answer.json().text, new RegExp(`Ответ ${label}`));
  }

  const beforeB = await packageBytes(path.dirname(scopedFile(fx, fx.b.source, 'analysis.json')));
  const dismissed = await fx.request('DELETE', `/api/analysis/42/status?${sourceQuery(fx.a.source)}`);

  assert.equal(dismissed.json().outcome, 'dismissed');
  assert.equal((await fx.request('GET', `/api/analysis/42?${sourceQuery(fx.a.source)}`)).json().status, null);
  assert.deepEqual(await packageBytes(path.dirname(scopedFile(fx, fx.b.source, 'analysis.json'))), beforeB);

  const extended = (await fx.request('GET', '/api/analysis?sources=1')).json();
  const legacy = (await fx.request('GET', '/api/analysis')).json();

  assert.deepEqual(extended.filter((row) => row.task === 42).map((row) => row.source).sort(),
    [fx.a.source, fx.b.source].sort());
  assert.equal(legacy.filter((row) => row.task === 42).length, 1);
  assert.equal(legacy[0].source, undefined);
  assert.equal(legacy[0].analysis.summary, 'Оценка B');
});

test('SOURCE-STORAGE-01: explicit не читает legacy, source-less сохраняет fallback', async (t) => {
  const fx = await analysisSourceFixture(t, { held: true });
  const bytes = '{"task":42,"summary":"Legacy неизвестной доски","questions":[]}\n';
  const file = path.join(fx.config.analysisDir, 't42.analysis.json');

  await writeFile(file, bytes);

  const explicit = (await fx.request('GET', `/api/analysis/42?${sourceQuery(fx.a.source)}`)).json();
  const legacy = (await fx.request('GET', '/api/analysis/42')).json();

  assert.equal(explicit.analysis, null, 'Нельзя присваивать старую безымянную оценку источнику A');
  assert.equal(legacy.analysis.summary, 'Legacy неизвестной доски');
  assert.equal(await readFile(file, 'utf8'), bytes);
});

test('SOURCE-RECOVERY-01: durable A восстанавливается при default B, owner сверяется заново', async (t) => {
  for (const mode of ['queued', 'running', 'owner-changed']) {
    await t.test(mode, async (st) => {
      const fx = await analysisSourceFixture(st, { held: true });
      const response = await fx.request('POST', '/api/tasks/42/analyze', { source: fx.a.source });

      assert.equal(response.statusCode, 200, response.body);

      const saved = await packageBytes(fx.config.analysisDir);
      const statusPath = Object.keys(saved).find((file) => file.endsWith('/t42.status.json'));

      assert.ok(statusPath, 'enqueue обязан записать durable status');

      if (mode === 'running') {
        assert.equal(statusPath, scopedFile(fx, fx.a.source, 'status.json'),
          'running восстанавливается из scoped пакета A, а не anonymous root');

        const status = JSON.parse(saved[statusPath]);

        await writeFile(statusPath, JSON.stringify({
          ...status,
          state: 'running',
          startedAt: Date.now(),
        }));
      }

      if (mode === 'owner-changed') {
        await fx.runtime.writeSettings({ drivers: ['fixture-a', 'fixture-b'], default: 'fixture-b' }, {
          'fixture-a': { endpoint: 'https://new-owner.fixture' },
        });
      }

      const restored = new Analyzer(fx.dependencies);

      await restored._ready;

      if (mode !== 'running') {
        await restored.start();
        await eventually(() => restored._jobs.size, (size) => size === 0);
      }

      const detail = await restored.get('42', { source: fx.a.source });

      assert.equal(detail.status?.state, mode === 'running' ? 'interrupted'
        : mode === 'owner-changed' ? 'failed' : 'done');
      assert.equal(fx.prompts.length, mode === 'queued' ? 1 : 0);

      if (mode === 'queued') {
        assert.equal(detail.analysis?.summary, 'Оценка A', 'Рестарт не должен переключать A на B');
      }
    });
  }
});
