// Живой размер контекста в кольце чата.
//
// До этого `contextTokens` возвращался ОДИН раз — вместе с ответом хода. Пока ходы
// короткие, разница незаметна; но собственный автокомпакт CLI срабатывает НА ГРАНИЦЕ
// хода, и весь остаток длинного хода кольцо могло гореть красным по контексту,
// которого уже нет.
//
// Поэтому claude отдаёт замер каждого обращения к модели вторым аргументом onProgress,
// а границу компакта называет вслух шагом ленты — иначе падение цифры втрое читается
// как «кольцо врёт».
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import claude from '../../server/src/lib/executors/claude.js';

/** Фальшивый CLI: печатает готовый stream-json и завершается. */
async function fakeClaude(t, events) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-claude-ctx-'));
  const bin = path.join(dir, 'fake-claude');
  const lines = events.map((event) => `printf '%s\\n' '${JSON.stringify(event)}'`).join('\n');
  await writeFile(bin, `#!/bin/sh\n${lines}\n`);
  await chmod(bin, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, bin };
}

/** Русская группировка разрядов — неразрывные пробелы; сверяем по цифрам. */
const digits = (s) => String(s).replace(/[\s ]/g, '');

test('Claude отдаёт размер контекста живьём, а не одной цифрой в конце хода', async (t) => {
  const events = [
    { type: 'system', subtype: 'init', model: 'claude-opus-5-1m', session_id: 'sess-live', permissionMode: 'default' },
    {
      type: 'assistant',
      session_id: 'sess-live',
      message: {
        model: 'claude-opus-5-1m',
        content: [{ type: 'text', text: 'Смотрю.' }],
        usage: { input_tokens: 10, cache_read_input_tokens: 179000, cache_creation_input_tokens: 990, output_tokens: 100 },
      },
    },
    // CLI сжал контекст сам, по порогу CLAUDE_CODE_AUTO_COMPACT_WINDOW.
    {
      type: 'system',
      subtype: 'compact_boundary',
      session_id: 'sess-live',
      compactMetadata: { trigger: 'auto', preTokens: 180000, durationMs: 12000 },
    },
    {
      type: 'assistant',
      session_id: 'sess-live',
      message: {
        model: 'claude-opus-5-1m',
        content: [{ type: 'text', text: 'Готово.' }],
        usage: { input_tokens: 10, cache_read_input_tokens: 59990, cache_creation_input_tokens: 0, output_tokens: 40 },
      },
    },
    // usage финального result — СУММА за все обращения: в кольцо её брать нельзя.
    {
      type: 'result',
      subtype: 'success',
      result: 'Готово.',
      session_id: 'sess-live',
      num_turns: 2,
      total_cost_usd: 0.42,
      usage: { input_tokens: 240000, cache_read_input_tokens: 239000, output_tokens: 140 },
    },
  ];
  const { dir, bin } = await fakeClaude(t, events);

  const progress = [];
  const live = [];
  const out = await claude.run({
    config: { claudeBin: bin }, message: 'test', cwd: dir, model: 'opus', effort: '',
    sessionId: null, permissionMode: 'default',
    onStep: (step) => live.push(step),
    onProgress: (tokens, info) => progress.push({
      tokens,
      contextTokens: info?.contextTokens ?? null,
      contextCache: info?.contextCache ?? null,
    }),
  });

  // Замер приезжает на КАЖДОМ обращении к модели, и падение после компакта видно сразу.
  assert.deepEqual(progress, [
    {
      tokens: 100,
      contextTokens: 180000,
      contextCache: {
        scope: 'request', status: 'reported', readTokens: 179000, writeTokens: 990, uncachedTokens: 10,
      },
    },
    {
      tokens: 140,
      contextTokens: 60000,
      contextCache: {
        scope: 'request', status: 'reported', readTokens: 59990, writeTokens: 0, uncachedTokens: 10,
      },
    },
  ]);
  assert.equal(out.contextTokens, 60000, 'итог — вход последнего обращения, а не сумма result.usage');
  assert.deepEqual(out.contextCache, {
    scope: 'request', status: 'reported', readTokens: 59990, writeTokens: 0, uncachedTokens: 10,
  }, 'итоговый кэш — тоже последний model request, а не сумма result.usage');
  assert.equal(out.sessionId, 'sess-live');
  assert.equal(out.actualModel, 'claude-opus-5-1m');

  // Компакт назван вслух: без него падение цифры втрое выглядит поломкой кольца.
  const note = out.steps.find((step) => step.k === 'note');
  assert.ok(note, 'граница компакта обязана попасть в ленту хода');
  assert.match(note.text, /Контекст сжат/);
  assert.match(note.text, /сам, по порогу/);
  assert.ok(digits(note.text).includes('180000'), `размер «до» обязан быть в тексте: ${note.text}`);
  assert.deepEqual(live, out.steps, 'лента уезжает в окно живьём и совпадает с сохранённой');
});

test('Ход без компакта и без обращений к модели не выдумывает замеров', async (t) => {
  const events = [
    { type: 'system', subtype: 'init', model: 'claude-opus-5-1m', session_id: 'sess-empty' },
    {
      type: 'result', subtype: 'success', result: 'ок', session_id: 'sess-empty', num_turns: 1, usage: {},
    },
  ];
  const { dir, bin } = await fakeClaude(t, events);

  const progress = [];
  const out = await claude.run({
    config: { claudeBin: bin }, message: 'test', cwd: dir, sessionId: null, permissionMode: 'default',
    onProgress: (tokens, info) => progress.push({ tokens, contextTokens: info?.contextTokens ?? null }),
  });

  assert.deepEqual(progress, [], 'нечего мерить — нечего и слать');
  assert.equal(out.contextTokens, 0);
  assert.deepEqual(out.contextCache, { scope: 'request', status: 'unavailable' });
  assert.equal(out.steps.filter((step) => step.k === 'note').length, 0);
});

test('Claude не превращает отсутствующие cache-поля в нули', async (t) => {
  const events = [
    { type: 'system', subtype: 'init', model: 'claude-opus-5-1m', session_id: 'sess-partial' },
    {
      type: 'assistant',
      session_id: 'sess-partial',
      message: {
        model: 'claude-opus-5-1m',
        content: [{ type: 'text', text: 'Готово.' }],
        usage: { input_tokens: 12, output_tokens: 3 },
      },
    },
    {
      type: 'result', subtype: 'success', result: 'Готово.', session_id: 'sess-partial',
      num_turns: 1, usage: { input_tokens: 12, output_tokens: 3 },
    },
  ];
  const { dir, bin } = await fakeClaude(t, events);

  const out = await claude.run({
    config: { claudeBin: bin }, message: 'test', cwd: dir, sessionId: null,
    permissionMode: 'default',
  });

  assert.deepEqual(out.contextCache, {
    scope: 'request', status: 'reported', uncachedTokens: 12,
  });
  assert.equal(Object.hasOwn(out.contextCache, 'readTokens'), false);
  assert.equal(Object.hasOwn(out.contextCache, 'writeTokens'), false);
});
