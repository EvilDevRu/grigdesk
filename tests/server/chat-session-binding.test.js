import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BindingStoreError,
  ChatSessionBindingStore,
} from '../../server/src/lib/chat/session-binding-store.js';

async function fresh(t, { retentionMs, now } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-binding-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new ChatSessionBindingStore({
    dir: path.join(root, 'bindings'),
    ...(retentionMs !== undefined ? { retentionMs } : {}),
    ...(now ? { now } : {}),
  });
}

const identity = (over = {}) => ({
  chatKey: 'chat-a',
  provider: 'kimi',
  cwdRealpath: '/workspace/project',
  model: 'kimi-runtime-model',
  authProfileId: 'kimi-default',
  securityProfile: 'kimi-contained-v1',
  ...over,
});

test('binding CAS резервирует generation и сохраняет ранний session id до prompt', async (t) => {
  const store = await fresh(t);
  const reserved = await store.rotate(identity(), null);
  assert.equal(reserved.generation, 1);
  assert.equal(reserved.sessionId, null);

  const bound = await store.compareAndSwap({ ...identity(), sessionId: 'kimi-session-1' }, 1);
  assert.equal(bound.generation, 2);
  assert.equal(bound.sessionId, 'kimi-session-1');
  assert.deepEqual(await store.assertResumeOwner({
    chatKey: 'chat-a', provider: 'kimi', sessionId: 'kimi-session-1',
  }), bound);

  const mode = (await fs.stat(store.fileOf('chat-a'))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('stale generation и forged client session fail closed', async (t) => {
  const store = await fresh(t);
  await store.rotate(identity(), null);
  await assert.rejects(
    store.compareAndSwap({ ...identity(), sessionId: 'late' }, 0),
    (error) => error instanceof BindingStoreError && error.code === 'stale_binding_generation',
  );
  await assert.rejects(
    store.assertResumeOwner({ chatKey: 'chat-a', provider: 'kimi', sessionId: 'from-client' }),
    (error) => error.code === 'forged_session',
  );
});

test('один provider/session id нельзя связать с двумя chat keys', async (t) => {
  const store = await fresh(t);
  await store.compareAndSwap({ ...identity(), sessionId: 'shared-session' }, null);
  await assert.rejects(
    store.compareAndSwap({
      ...identity({ chatKey: 'chat-b' }),
      sessionId: 'shared-session',
    }, null),
    (error) => error.code === 'session_owned_by_another_chat' && error.ownerChatKey === 'chat-a',
  );
});

test('backup/restore и retention cleanup не зависят от chat PUT', async (t) => {
  let clock = Date.UTC(2026, 7, 1);
  const store = await fresh(t, { retentionMs: 1_000, now: () => clock });
  const original = await store.compareAndSwap({ ...identity(), sessionId: 'restore-me' }, null);
  const backup = await store.backup('before-migration');
  await store.compareAndSwap({ ...identity(), sessionId: 'newer' }, original.generation);
  await store.restore(backup);
  assert.equal((await store.read('chat-a')).sessionId, 'restore-me');

  clock += 2_000;
  assert.deepEqual(await store.cleanup({ activeChatKeys: ['chat-a'], now: clock }), []);
  assert.deepEqual(await store.cleanup({ activeChatKeys: [], now: clock }), ['chat-a']);
  assert.equal(await store.read('chat-a'), null);
});
