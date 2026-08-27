import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function hostKeys(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-ssh-host-key-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let module;
  try {
    module = await import('../../server/src/lib/ssh/host-keys.js');
  } catch (error) {
    assert.fail(`надзор host key ещё не реализован: ${error.message}`);
  }
  const create = module.createHostKeyStore || module.createHostKeys || module.default;
  assert.equal(typeof create, 'function', 'host-keys.js обязан экспортировать фабрику хранилища');
  return create({
    file: path.join(root, 'known-hosts.json'),
    now: () => Date.parse('2026-08-27T10:00:00.000Z'),
    challengeTtlMs: 5 * 60 * 1000,
  });
}

test('первый host key требует явного доверия человека', async (t) => {
  const store = await hostKeys(t);
  const result = await store.check({
    host: 'server.internal',
    port: 22,
    algorithm: 'ssh-ed25519',
    fingerprint: 'SHA256:first',
  });

  assert.deepEqual({ status: result.status, decision: result.decision }, {
    status: 'unknown',
    decision: 'trust_required',
  });
});

test('сменившийся host key блокируется до отдельного replace', async (t) => {
  const store = await hostKeys(t);
  const first = await store.check({
    host: 'server.internal', port: 22, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:first',
  });
  await store.decide(first.challengeId, 'trust');
  const changed = await store.check({
    host: 'server.internal', port: 22, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:changed',
  });

  assert.deepEqual({
    status: changed.status,
    decision: changed.decision,
    previous: changed.previous?.fingerprint,
    current: changed.current?.fingerprint,
  }, {
    status: 'changed',
    decision: 'replace_required',
    previous: 'SHA256:first',
    current: 'SHA256:changed',
  });
});

test('одноразовый challenge нельзя подтвердить повторно', async (t) => {
  const store = await hostKeys(t);
  const first = await store.check({
    host: 'server.internal', port: 22, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:first',
  });
  await store.decide(first.challengeId, 'trust');

  await assert.rejects(() => store.decide(first.challengeId, 'trust'), /challenge|expired|used|not_found/i);
});
