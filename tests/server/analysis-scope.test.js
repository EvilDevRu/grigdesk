import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Analyzer, normalizeAnalysisScope } from '../../server/src/lib/analysis/analyzer.ts';
import { buildTriagePrompt } from '../../server/src/lib/analysis/prompt.ts';
import { scopeSuggestion } from '../../server/src/lib/factoryLaunchContract.ts';

// Объём задачи (scope) — то, что человек подтверждает на запуске как критерии приёмки.
// Без него у лёгких маршрутов критерии оставались пустыми, и узел мог сузить задачу до
// одного пункта, никому об этом не сказав (живой прогон: из трёх пунктов постановки сделан один).

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'analysis-scope-'));
  const analyzer = new Analyzer({
    config: { analysisDir: dir },
    claudeAuth: null,
    tracker: null,
    factoryState: {},
    log: null,
  });
  await analyzer._ready;
  t.after(() => rm(dir, { recursive: true, force: true }));

  return { analyzer, dir };
}

test('промпт триажа требует объём: по пункту постановки в do[] либо skip[] с причиной', () => {
  const prompt = buildTriagePrompt({
    task: 42,
    title: 'Задача',
    description: '',
    comments: [],
    clarifications: '',
    discussion: '',
    profile: { ctx: '', markers: '', repos: [] },
    jsonPath: '/tmp/t42.analysis.json',
    notePath: '/tmp/t42.md',
  });

  assert.match(prompt, /"scope":\s*\{[\s\S]*"do"[\s\S]*"skip"/);
  assert.match(prompt, /«Уже реализовано в коде» — НЕ причина для skip\[\]/);
});

test('нормализация объёма терпит любую форму ответа модели', () => {
  assert.deepEqual(normalizeAnalysisScope(undefined), { do: [], skip: [] });
  assert.deepEqual(normalizeAnalysisScope('строка'), { do: [], skip: [] });
  assert.deepEqual(normalizeAnalysisScope({
    do: ['  Подсказка в пустой ячейке  ', 'Подсказка в пустой ячейке', { text: 'объект' }, ''],
    skip: 'не список',
  }), {
    do: ['Подсказка в пустой ячейке'],
    skip: [],
  });
});

test('деталь и список оценок отдают объём нормализованным, старая оценка без него — пустым', async (t) => {
  const { analyzer, dir } = await fixture(t);
  await writeFile(path.join(dir, 't42.analysis.json'), JSON.stringify({
    task: 42,
    scope: { do: ['Окно называет тип частоты'], skip: ['Раздел «Частота» — по ответу человека'] },
  }));
  await writeFile(path.join(dir, 't43.analysis.json'), JSON.stringify({ task: 43, summary: 'старая' }));

  const detail = await analyzer.get('42');
  assert.deepEqual(detail.analysis.scope, {
    do: ['Окно называет тип частоты'],
    skip: ['Раздел «Частота» — по ответу человека'],
  });
  const rows = await analyzer.list();
  assert.deepEqual(rows.find((row) => row.task === 43).analysis.scope, { do: [], skip: [] });
});

test('форма запуска получает критерии из scope.do и список «не делаем» из scope.skip', () => {
  assert.deepEqual(scopeSuggestion(null), { criteria: [], skip: [] });
  assert.deepEqual(scopeSuggestion({ scope: { do: ['A', 'A', ' B '], skip: [42, 'C'] } }), {
    criteria: ['A', 'B'],
    skip: ['C'],
  });
});
