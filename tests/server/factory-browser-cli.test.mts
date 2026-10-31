import assert from 'node:assert/strict';
import {
  mkdtemp, mkdir, rm, readFile, writeFile, symlink, unlink, readdir,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  browserMailboxRequest, browserMailboxOnce,
} from '../../server/src/lib/browser/browserMailbox.ts';

/**
 * Fixture выдаёт приватный каталог только синтетического запуска и scoped nonce.
 * published исключает гонку запуска consumer раньше появления готового request.
 */
async function mailboxFixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-mailbox-boundary-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const context = {
    stateDir: root,
    task: '77',
    stage: 'CHECK',
    runId: 'run-a',
    epoch: '2',
    nonce: 'a'.repeat(64),
  };
  const directory = path.join(root, 'logs/runs/t77/CHECK/run-a/control-requests/browser');

  await mkdir(directory, { recursive: true, mode: 0o700 });

  /**
   * Вызов fixture ждёт публикации encrypted request, а не произвольный таймер.
   * AbortController завершает только собственное ожидание без повторного действия.
   */
  const start = async (input: unknown, id = '11111111-1111-4111-8111-111111111111') => {
    const controller = new AbortController();
    let published = () => {};
    const ready = new Promise<void>((resolve) => {
      published = resolve;
    });
    const result = browserMailboxRequest({
      context,
      input,
      id,
      signal: controller.signal,
      published
    });

    result.catch(() => undefined);
    await ready;

    return {
      result,
      controller,
      request: path.join(directory, `${id}.browser`),
      reply: path.join(directory, `${id}.reply`)
    };
  };

  return {
    context,
    directory,
    start
  };
}

test('BR19: mailbox roundtrip передаёт только action, trusted relay добавляет authority', async (t) => {
  const f = await mailboxFixture(t);
  const pending = await f.start({ action: 'list' });
  const calls: unknown[] = [];

  await browserMailboxOnce({
    context: f.context,
    invoke: async (input) => {
      calls.push(input);

      return { ok: true, tabs: [] };
    },
  });
  assert.deepEqual(await pending.result, { ok: true, tabs: [] });
  assert.deepEqual(calls, [{ action: 'list' }]);
});

test('MB01: encrypted request/reply, чужой nonce и replay не вызывают второй эффект', async (t) => {
  const f = await mailboxFixture(t);
  const first = await f.start({
    action: 'fill',
    tabId: 'tab',
    pageEpoch: 1,
    ref: 'e1',
    text: 'PRIVATE_FILL_CANARY'
  });
  const envelope = await readFile(first.request, 'utf8');
  let calls = 0;
  const seen = new Set<string>();
  const invoke = async () => {
    calls += 1;

    return { text: 'PRIVATE_REPLY_CANARY' };
  };

  assert.equal(envelope.includes('PRIVATE_FILL_CANARY'), false);
  await assert.rejects(() => browserMailboxOnce({
    context: { ...f.context, nonce: 'b'.repeat(64) },
    seen,
    invoke,
  }), /browser_mailbox_signature/u);
  assert.equal(calls, 0);
  await browserMailboxOnce({
    context: f.context,
    seen,
    invoke,
    replied: (value) => assert.equal(JSON.stringify(value).includes('PRIVATE_REPLY_CANARY'), false),
  });
  assert.deepEqual(await first.result, { text: 'PRIVATE_REPLY_CANARY' });

  const replay = await f.start({ action: 'list' });

  await browserMailboxOnce({
    context: f.context,
    seen,
    invoke
  });
  await assert.rejects(replay.result, /outcome_unknown/u);
  assert.equal(calls, 1);
});

test('MB02: symlink/oversize request отвергается до invoke, abort не создаёт retry', async (t) => {
  const f = await mailboxFixture(t);
  let calls = 0;
  const invoke = async () => {
    calls += 1;

    return {};
  };
  const first = await f.start({ action: 'list' });
  const foreign = path.join(f.directory, 'foreign');

  await writeFile(foreign, await readFile(first.request), { mode: 0o600 });
  await unlink(first.request);
  await symlink(foreign, first.request);
  await assert.rejects(() => browserMailboxOnce({ context: f.context, invoke }));
  first.controller.abort();
  await assert.rejects(first.result);

  const second = await f.start({ action: 'list' });

  await writeFile(second.request, 'x'.repeat(65537), { mode: 0o600 });
  await assert.rejects(() => browserMailboxOnce({ context: f.context, invoke }), /browser_mailbox_invalid/u);
  second.controller.abort();
  await assert.rejects(second.result);
  assert.equal(calls, 0);
  assert.deepEqual((await readdir(f.directory)).filter((name) => name.endsWith('.browser')), []);
});

test('MB03: authority поля модели запрещены; symlink reply не раскрывает чужой JSON', async (t) => {
  const f = await mailboxFixture(t);

  await assert.rejects(() => browserMailboxRequest({
    context: f.context, input: {
      action: 'list',
      task: 'foreign',
      token: 'forged'
    },
  }));

  const request = await f.start({ action: 'list' });
  const foreign = path.join(f.directory, 'reply-foreign');

  await writeFile(foreign, JSON.stringify({ secret: 'FOREIGN_RESULT_CANARY' }), { mode: 0o600 });
  await symlink(foreign, request.reply);
  await assert.rejects(request.result);
  assert.equal((await readdir(f.directory)).some((name) => name.endsWith('.browser')), false);
});
