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
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import claude from '../../server/src/lib/executors/claude.ts';
import {
  buildClaudeTurnResult, createClaudeTurnCollector,
} from '../../server/src/lib/executors/_claudeStream.ts';

/**
 * Фальшивый CLI печатает готовый stream-json без запроса к модели.
 * Stream-сценарий сначала принимает prompt, чтобы не закрыть stdin до отправки.
 */
async function fakeClaude(t, events, { stream = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-claude-ctx-'));
  const bin = path.join(dir, 'fake-claude');
  const lines = events.map((event) => `printf '%s\\n' '${JSON.stringify(event)}'`).join('\n');
  const trace = path.join(dir, 'args.txt');

  const input = stream ? 'IFS= read -r line\n' : '';

  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${trace}'\n${input}${lines}\n`);
  await chmod(bin, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, bin };
}

/** Русская группировка разрядов — неразрывные пробелы; сверяем по цифрам. */
const digits = (s) => String(s).replace(/[\s ]/g, '');

test('R1: partial-прогресс до замера не объявляет контекст недоступным', () => {
  const progress = [];
  const collector = createClaudeTurnCollector({
    onProgress: (tokens, info) => progress.push({ tokens, ...info }),
  });

  collector.push({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'first-response' } },
  });
  assert.deepEqual(progress, [{ tokens: 0, tokensIsEstimate: true }]);

  collector.push({ type: 'system', subtype: 'compact_boundary' });
  assert.equal(progress.at(-1).contextTokens, 0);
  assert.equal(progress.at(-1).contextMetric, 'unavailable');
  assert.equal(progress.at(-1).contextIsEstimate, false);
  assert.equal(progress.at(-1).contextCache.status, 'unavailable');
});

test('R8: коллектор суммирует result двух сегментов одного хода с уточнением', () => {
  const progress = [];
  const collector = createClaudeTurnCollector({
    onProgress: (tokens, info) => progress.push({ tokens, ...info }),
  });

  for (const [id, tokens] of [['first-segment', 100], ['queued-segment', 50]]) {
    collector.push({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
    collector.push({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { output_tokens: tokens } },
    });
    collector.push({
      type: 'result',
      result: 'Готово',
      usage: { output_tokens: tokens },
    });
  }

  assert.equal(collector.state.spentTokens, 150);
  assert.equal(progress.at(-1).tokens, 150);
  assert.equal(progress.at(-1).tokensIsEstimate, false);
});

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
      estimate: info?.tokensIsEstimate ?? null,
      contextTokens: info?.contextTokens ?? null,
      contextCache: info?.contextCache ?? null,
    }),
  });

  // Замер приезжает на КАЖДОМ обращении к модели, и падение после компакта видно сразу.
  // Расход по ходу — оценка по символам ответа («Смотрю.» — 7 знаков ≈ 2 токена, с «Готово.»
  // ≈ 5): `output_tokens` assistant-события — снимок начала ответа, а не расход. Точная
  // цифра за ход — из result, и она уже не оценка.
  assert.deepEqual(progress, [
    {
      tokens: 2,
      estimate: true,
      contextTokens: 180000,
      contextCache: {
        scope: 'request', status: 'reported', readTokens: 179000, writeTokens: 990, uncachedTokens: 10,
      },
    },
    {
      tokens: 2,
      estimate: true,
      contextTokens: 0,
      contextCache: { scope: 'request', status: 'unavailable' },
    },
    {
      tokens: 5,
      estimate: true,
      contextTokens: 60000,
      contextCache: {
        scope: 'request', status: 'reported', readTokens: 59990, writeTokens: 0, uncachedTokens: 10,
      },
    },
    {
      tokens: 140,
      estimate: false,
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
  assert.equal(out.contextMetric, 'unavailable');
  assert.deepEqual(out.contextCache, { scope: 'request', status: 'unavailable' });
  assert.equal(out.steps.filter((step) => step.k === 'note').length, 0);
});

test('Claude не принимает расход result и замеры субагента за контекст родителя', () => {
  const progress = [];
  const collector = createClaudeTurnCollector({ onProgress: (_tokens, info) => progress.push(info) });
  collector.push({ type: 'result', result: 'готово', usage: { input_tokens: 900_000 } });
  assert.equal(buildClaudeTurnResult(collector).contextMetric, 'unavailable');
  assert.equal(buildClaudeTurnResult(collector).contextTokens, 0);

  collector.push({
    type: 'assistant', session_id: 'parent-session',
    message: { model: 'parent', usage: { input_tokens: 80_000 } },
  });
  collector.push({
    type: 'assistant', parent_tool_use_id: 'child-tool', session_id: 'child-session',
    message: { model: 'child', usage: { input_tokens: 2_000 } },
  });
  assert.equal(buildClaudeTurnResult(collector).contextTokens, 80_000);
  assert.equal(buildClaudeTurnResult(collector).actualModel, 'parent');
  assert.equal(buildClaudeTurnResult(collector).sessionId, 'parent-session');
  assert.equal(progress.length, 1);

  collector.push({ type: 'system', subtype: 'compact_boundary' });
  assert.equal(progress.at(-1).contextMetric, 'unavailable');
  assert.equal(buildClaudeTurnResult(collector).contextMetric, 'unavailable');

  collector.push({ type: 'assistant', message: { model: 'parent', usage: { input_tokens: 0 } } });
  const result = buildClaudeTurnResult(collector);
  assert.equal(result.contextTokens, 0, 'измеренный ноль не заменяется суммой из result');
  assert.equal(result.contextMetric, 'active-input-v1');
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

test('Расход хода Claude — оценка по потоку с «≈», точная цифра — из result', () => {
  const progress = [];
  const collector = createClaudeTurnCollector({
    onProgress: (tokens, info) => progress.push({ tokens, estimate: info.tokensIsEstimate }),
  });
  const block = (id, content) => ({
    type: 'assistant',
    message: {
      id,
      model: 'claude-opus-5',
      content: [content],
      // Снимок НАЧАЛА ответа: живой CLI присылает здесь 2–4 токена при сотнях по итогу.
      usage: { input_tokens: 5, output_tokens: 4 },
    },
  });

  const thinking = (estimated_tokens, estimated_tokens_delta) => ({
    type: 'system', subtype: 'thinking_tokens', estimated_tokens, estimated_tokens_delta,
  });
  const input = { command: 'echo probe-ok!!' };
  const inputChars = JSON.stringify(input).length;

  // Рассуждения оценивает CLI — накопительно по обращению, поэтому берутся дельты.
  collector.push(thinking(50, 50));
  collector.push(thinking(128, 78));
  assert.equal(collector.state.spentTokens, 128);
  assert.equal(collector.state.spentIsEstimate, true);

  // Ответ идёт по блоку на событие: рассуждения второй раз не считаются, текст и аргументы
  // инструмента — по символам (29 знаков JSON ≈ 10 токенов). Снимок output_tokens не суммируется.
  collector.push(block('msg-1', { type: 'thinking', thinking: 'долгие размышления модели о задаче' }));
  collector.push(block('msg-1', { type: 'tool_use', name: 'Bash', input }));
  assert.equal(collector.state.spentTokens, 128 + Math.round(inputChars / 3));
  assert.equal(progress.at(-1).estimate, true, 'по ходу цифра помечена оценкой');

  // Второе обращение: CLI снова считает рассуждения с нуля — дельта складывается, а не заменяет.
  collector.push(thinking(40, 40));
  collector.push(block('msg-2', { type: 'text', text: 'Готово: probe-ok' }));
  assert.equal(collector.state.spentTokens, 168 + Math.round((inputChars + 'Готово: probe-ok'.length) / 3));

  // Итог хода — точный output_tokens за ЭТОТ ход: он заменяет оценку и уходит без «≈».
  collector.push({
    type: 'result', subtype: 'success', result: 'Готово: probe-ok', usage: { output_tokens: 188 },
  });
  assert.equal(collector.state.spentTokens, 188);
  assert.equal(collector.state.spentIsEstimate, false);
  assert.deepEqual(progress.at(-1), { tokens: 188, estimate: false });
  assert.ok(progress.length >= 3, 'оценка уходила в окно по ходу, а не только итогом');
});

test('Claude без обращений к модели расход не выдумывает, а без рассуждений считает по тексту', () => {
  const progress = [];
  const collector = createClaudeTurnCollector({
    onProgress: (tokens, info) => progress.push({ tokens, estimate: info.tokensIsEstimate }),
  });

  // Пустой usage у result (ход без единого обращения) — события прогресса нет вовсе.
  collector.push({ type: 'result', subtype: 'success', result: '', usage: {} });
  assert.deepEqual(progress, []);
  assert.equal(collector.state.spentTokens, 0);

  // Ответ без блока рассуждений: оценка — только по символам текста.
  collector.push({
    type: 'assistant',
    message: {
      id: 'msg-1',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'Париж' }],
      usage: { output_tokens: 2 },
    },
  });
  assert.deepEqual(progress.at(-1), { tokens: 2, estimate: true });
});


test('явный assistant replay не меняет расход, контекст и кэш основного агента', () => {
  const collector = createClaudeTurnCollector();
  const original = {
    type: 'assistant',
    message: {
      id: 'msg-1',
      model: 'claude-fixture',
      content: [{ type: 'text', text: 'abcdef' }],
      usage: {
        input_tokens: 500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 30
      },
    },
  };

  collector.push(original);

  const before = structuredClone(collector.state);

  collector.push({
    ...original,
    isReplay: true,
    message: { ...original.message, usage: { input_tokens: 100 } },
  });
  assert.equal(collector.state.spentTokens, before.spentTokens);
  assert.equal(collector.state.lastTurnInput, before.lastTurnInput);
  assert.deepEqual(collector.state.lastContextCache, before.lastContextCache);
});


test('коллектор Claude использует точный partial-output по обращениям и поправку result', () => {
  const collector = createClaudeTurnCollector();
  const push = (event) => collector.push({ type: 'stream_event', event });

  push({ type: 'message_start', message: { id: 'request-a' } });
  collector.push({
    type: 'assistant',
    message: {
      id: 'request-a',
      model: 'fixture-model',
      usage: { input_tokens: 500 },
      content: [{ type: 'text', text: 'abcdef' }],
    },
  });
  push({ type: 'message_delta', usage: { output_tokens: 20 } });
  push({ type: 'message_delta', usage: { output_tokens: 120 } });
  push({ type: 'message_stop' });
  push({ type: 'message_start', message: { id: 'request-b' } });
  push({ type: 'message_delta', usage: { output_tokens: 80 } });
  collector.push({
    type: 'system',
    subtype: 'thinking_tokens',
    estimated_tokens_delta: 100
  });
  assert.equal(collector.state.spentTokens, 200);
  assert.equal(collector.state.spentIsEstimate, false);
  collector.push({ type: 'result', usage: { output_tokens: 188 } });
  assert.equal(collector.state.spentTokens, 188);
  assert.equal(collector.state.spentIsEstimate, false);
});


test('stream-путь Claude отдаёт точный output до result без дублирования шагов', async (t) => {
  const partial = (event) => ({ type: 'stream_event', event });
  const events = [
    partial({ type: 'message_start', message: { id: 'partial-a' } }),
    partial({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    }),
    partial({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'abcdef' }
    }),
    { type: 'assistant', message: {
      id: 'partial-a',
      model: 'fixture-model',
      usage: { input_tokens: 500 },
      content: [{ type: 'text', text: 'abcdef' }],
    } },
    partial({ type: 'message_delta', usage: { output_tokens: 120 } }),
    partial({ type: 'message_stop' }),
    partial({ type: 'message_start', message: { id: 'partial-b' } }),
    { type: 'assistant', message: {
      id: 'partial-b',
      model: 'fixture-model',
      usage: { input_tokens: 700 },
      content: [{
        type: 'tool_use',
        id: 'partial-tool',
        name: 'Read',
        input: { file_path: 'a' }
      }],
    } },
    partial({ type: 'message_delta', usage: { output_tokens: 80 } }),
    partial({ type: 'message_stop' }),
    {
      type: 'result',
      subtype: 'success',
      result: 'Готово',
      usage: { output_tokens: 188 }
    },
  ];
  const { dir, bin } = await fakeClaude(t, events, { stream: true });
  const progress = [];
  const result = await claude.run({
    config: { claudeBin: bin },
    cwd: dir,
    message: 'Проверь',
    onInTurnReady: () => {},
    onProgress: (tokens, info) => progress.push({ tokens, ...info }),
  });

  assert.ok(progress.some((item) => item.tokens === 200 && item.tokensIsEstimate === false));
  assert.equal(progress.at(-1).tokens, 188);
  assert.equal(progress.at(-1).tokensIsEstimate, false);
  assert.equal(result.steps.filter((step) => step.k === 'text').length, 1);
  assert.equal(result.steps.filter((step) => step.k === 'tool').length, 1);
  assert.equal(result.contextTokens, 700);

  const args = await readFile(path.join(dir, 'args.txt'), 'utf8');

  assert.equal(args.includes('--include-partial-messages'), true);
});


test('разовый execFile Claude сохраняет ограниченный stdout без partial-флага', async (t) => {
  const { dir, bin } = await fakeClaude(t, [
    { type: 'assistant', message: {
      model: 'fixture-model',
      content: [{ type: 'text', text: 'abcdef' }],
      usage: { input_tokens: 500 },
    } },
    {
      type: 'result',
      result: 'Готово',
      subtype: 'success'
    },
  ]);
  const progress = [];

  await claude.run({
    config: { claudeBin: bin },
    cwd: dir,
    message: 'Проверь',
    onProgress: (tokens, info) => progress.push({ tokens, ...info }),
  });

  const args = await readFile(path.join(dir, 'args.txt'), 'utf8');

  assert.equal(args.includes('--include-partial-messages'), false);
  assert.equal(progress.at(-1).tokensIsEstimate, true);
});
