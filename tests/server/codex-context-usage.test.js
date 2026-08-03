import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  codexTotalInputTokens,
  parseCodexTokenInfoLine,
  readCodexThreadTokenInfo,
  readLatestCodexTokenInfo,
} from '../../server/src/lib/executors/codex.js';

test('Codex cumulative input does not count cached input twice', () => {
  assert.equal(codexTotalInputTokens({
    input_tokens: 120_000,
    cached_input_tokens: 110_000,
  }), 120_000);
  assert.equal(codexTotalInputTokens({ input_tokens: 0, cached_input_tokens: 10_000 }), 0);
  assert.equal(codexTotalInputTokens(null), 0);
});

const TOKEN_EVENT = {
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: 25_626_388, cached_input_tokens: 25_025_792 },
      last_token_usage: { input_tokens: 83_286, cached_input_tokens: 80_640 },
      model_context_window: 258_400,
    },
  },
};

test('Codex token_count разделяет активный контекст и накопительный расход', () => {
  assert.deepEqual(parseCodexTokenInfoLine(JSON.stringify(TOKEN_EVENT)), {
    contextTokens: 83_286,
    contextWindow: 258_400,
    contextMetric: 'active-input-v1',
    contextIsEstimate: false,
    totalInputTokens: 25_626_388,
    cachedInputTokens: 25_025_792,
  });
  assert.equal(parseCodexTokenInfoLine('{"payload":{"type":"other"}}'), null);
});

test('Codex rollout читается с конца и находит thread по безопасному UUIDv7', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cockpit-codex-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const threadId = '019fbcdd-e900-7773-bc27-cf6a12c3e827';
  const day = path.join(home, 'sessions', '2026', '08', '01');
  const file = path.join(day, `rollout-test-${threadId}.jsonl`);
  await mkdir(day, { recursive: true });
  await writeFile(file, [
    JSON.stringify({ payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 10, cached_input_tokens: 2 },
      last_token_usage: { input_tokens: 8 }, model_context_window: 100,
    } } }),
    'x'.repeat(300_000),
    JSON.stringify(TOKEN_EVENT),
    JSON.stringify({ type: 'response_item', payload: { type: 'message' } }),
  ].join('\n'));

  assert.deepEqual(await readLatestCodexTokenInfo(file), parseCodexTokenInfoLine(JSON.stringify(TOKEN_EVENT)));
  assert.deepEqual(
    await readCodexThreadTokenInfo(threadId, { env: { CODEX_HOME: home } }),
    parseCodexTokenInfoLine(JSON.stringify(TOKEN_EVENT)),
  );
  assert.equal(await readCodexThreadTokenInfo('../../auth.json', { env: { CODEX_HOME: home } }), null);
});
