import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { ensureTestDeepSeekBinaryPair } from '../helpers/deepseekBinary.mts';
import { deepSeekProductionChatFixture } from '../helpers/deepseekChatParity.mjs';
import { chatHomeFor } from '../../server/src/lib/deepseek/env.ts';
import { sessionJournalDirectory } from '../../server/src/lib/deepseek/journal.ts';

/**
 * Совместимый rollback больше не копирует home по buildId: версии продолжают один журнал.
 * Активный A, другой чат B и несовместимый будущий codec наблюдаются на настоящих ELF.
 */
test('настоящий binary rollback сохраняет активный A, память B→A и будущий журнал', {
  timeout: 900000,
}, async (t) => {
  const { a, b } = await ensureTestDeepSeekBinaryPair();
  const arrived = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await deepSeekProductionChatFixture(t, {
    respond: async (_payload, index) => {
      if (index === 0) {
        arrived.resolve();
        await release.promise;
      }

      return { deltas: [{ content: 'rollback-memory' }] };
    }
  }, { mode: 'binary', candidate: a });
  const starts = [];
  const startServer = (options) => {
    starts.push(options.runtime.metadata.packageId);

    return f.startServer(options);
  };

  t.after(() => release.resolve());

  const active = f.run({
    chatKey: 'running-a',
    message: 'first-on-a',
    startServer
  });

  active.catch(arrived.reject);
  await arrived.promise;
  f.config.deepseekBin = b.binary;

  const other = await f.run({
    chatKey: 'other-b',
    message: 'other-on-b',
    startServer
  });

  assert.deepEqual(starts, [a.info.packageId, b.info.packageId]);
  release.resolve();

  const first = await active;
  const second = await f.run({
    chatKey: 'running-a',
    sessionId: first.sessionId,
    message: 'second-on-b',
    startServer,
  });

  f.config.deepseekBin = a.binary;

  const third = await f.run({
    chatKey: 'running-a',
    sessionId: second.sessionId,
    message: 'third-back-on-a',
    startServer,
  });

  assert.equal(second.sessionId, first.sessionId);
  assert.equal(third.sessionId, first.sessionId);
  assert.notEqual(other.sessionId, first.sessionId);
  assert.match(JSON.stringify(f.mock.payloads.at(-1).messages), /first-on-a/u);
  assert.match(JSON.stringify(f.mock.payloads.at(-1).messages), /second-on-b/u);
  assert.equal(f.launches[0].home, f.launches[2].home);
  assert.equal(f.launches[2].home, f.launches[3].home);
  assert.notEqual(f.launches[0].home, f.launches[1].home);

  const home = chatHomeFor(f.config.deepseekRuntimeHome, 'running-a', 'stable');
  const directory = sessionJournalDirectory(home, f.cwd, third.sessionId);
  const current = (await fs.readdir(directory)).find((name) => /^session\.v3\.jsonl(?:\.zstd)?$/u.test(name));

  assert.ok(current);

  const bytes = await fs.readFile(path.join(directory, current));
  const future = path.join(directory, `session.v99.jsonl${current.endsWith('.zstd') ? '.zstd' : ''}`);

  await fs.writeFile(future, bytes);

  const rotated = await f.run({
    chatKey: 'running-a',
    sessionId: third.sessionId,
    message: 'future-codec-on-a',
    startServer,
  });

  assert.notEqual(rotated.sessionId, third.sessionId);
  assert.match(JSON.stringify(rotated.steps), /формат журнала несовместим/u);
  assert.deepEqual(await fs.readFile(future), bytes);
  assert.deepEqual(starts, [a.info.packageId, b.info.packageId, b.info.packageId,
  a.info.packageId, a.info.packageId]);
});
