import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import {
  decodeBrowserBinding, readBrowserBinding, removeBrowserBinding,
} from '../../server/src/lib/browser/factoryBrowserBinding.ts';
import {
  factoryBrowserOwner, publishFactoryBrowserBinding,
} from '../../server/src/lib/browser/factoryBrowserIdentity.ts';

import type { BrowserRunProof } from '../../server/src/lib/browser/factoryBrowserBinding.ts';
import type { TrustedBrowserAttempt } from '../../server/src/lib/browser/factoryBrowserTrusted.ts';

const ATTEMPT = `a_${'a'.repeat(32)}`;
const NEXT_ATTEMPT = `a_${'b'.repeat(32)}`;
const BOOT_ID = '11111111-1111-4111-8111-111111111111';

/**
 * Управляемый barrier замораживает ровно нужный await без таймеров.
 * Изменение authority происходит после entered и до release.
 */
function barrier() {
  let enter = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    enter,
    release,
    entered,
    waiting
  };
}

/**
 * /proc format включает comm с пробелом и скобками: split по первому пробелу неверен.
 * Нужные индексы после последней скобки: state0, pgrp2, session3, starttime19.
 */
function procStat(pid: number, starttime: string, state = 'S'): string {
  const fields = Array<string>(22).fill('0');

  fields[0] = state;
  fields[1] = '1';
  fields[2] = String(pid);
  fields[3] = String(pid);
  fields[19] = starttime;

  return `${pid} (fixture ) worker) ${fields.join(' ')}\n`;
}

/**
 * Fixture не читает личный runtime и создаёт control вне provider-writable state.
 * Изменяемые closures дают детерминированные stale/death/PID-reuse сценарии.
 */
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-authority-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const proof: BrowserRunProof = {
    task: '77',
    stage: 'CHECK',
    runId: 'run-a',
    epoch: '2',
    attemptId: ATTEMPT,
    token: 'fixture-token-with-private-authority',
  };
  const tokenHash = createHash('sha256').update(proof.token).digest('hex');
  const active = path.join(root, 'runs/t77/CHECK.active');
  const live = path.join(root, 'runner-processes/t77.active');

  await mkdir(path.dirname(active), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(live), { recursive: true, mode: 0o700 });
  await writeFile(active, `SCHEMA=1\nRUN_ID=run-a\nEPOCH=2\nTOKEN_HASH=${tokenHash}\nSTATE=active\n`,
    { mode: 0o600 });
  await writeFile(live, 'SCHEMA=1\nTASK=77\nSTAGE=CHECK\nRUN_ID=run-a\nEPOCH=2\n'
    + 'RUNNER=codex\nPID=1234\nPGID=1234\nSESSION=1234\nSTARTTIME=987\nSTATE=active\n',
  { mode: 0o600 });

  let trusted: TrustedBrowserAttempt = {
    task: '77',
    attempt: ATTEMPT,
    profile: 'fixture',
    catalogHash: 'c'.repeat(64),
    route: 'feature',
    routeHash: 'd'.repeat(64),
    node: 'check',
    runKey: 'CHECK',
    sequence: 8,
    headEventHash: 'e'.repeat(64),
    identity: 'head-a',
  };
  let processText = procStat(1234, '987');
  let bootId = BOOT_ID;
  let dead = false;
  let denied = false;
  let hook: (() => Promise<void>) | null = null;
  const port = {
    controlRoot: root,
    processes: {
      bootId: async () => bootId,
      stat: async () => {
        if (dead) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }

        return processText;
      },
    },
    trusted: async () => {
      if (denied) {
        throw new Error('browser_run_stale');
      }

      const snapshot = structuredClone(trusted);
      const current = hook;

      hook = null;

      if (current) {
        await current();
      }

      return snapshot;
    },
  };

  await publishFactoryBrowserBinding(port, proof);

  return {
    root,
    proof,
    port,
    active,
    live,
    setTrusted: (patch: Partial<TrustedBrowserAttempt>) => {
      trusted = { ...trusted, ...patch };
    },
    setProcess: (value: string) => {
      processText = value;
    },
    setBoot: (value: string) => {
      bootId = value;
    },
    die: () => {
      dead = true;
    },
    deny: () => {
      denied = true;
    },
    defer: (gate: ReturnType<typeof barrier>) => {
      hook = async () => {
        gate.enter();
        await gate.waiting;
      };
    },
  };
}

test('BR17-A: binding связывает secret/run/current visit и не содержит token', async (t) => {
  const f = await fixture(t);
  const owner = await factoryBrowserOwner(f.port, f.proof);

  assert.deepEqual(owner, {
    kind: 'task',
    key: '77',
    projectId: 'fixture',
    attemptId: ATTEMPT
  });

  const text = await readFile(path.join(f.root, 'browser-runs/t77/run-a.json'), 'utf8');

  assert.equal(text.includes(f.proof.token), false);
  await assert.rejects(() => factoryBrowserOwner(f.port, { ...f.proof, token: 'forged' }),
    /browser_run_stale/u);
  await assert.rejects(() => factoryBrowserOwner(f.port, { ...f.proof, owner: 'task:victim' }),
    /browser_run_stale/u);
  await assert.rejects(() => publishFactoryBrowserBinding(f.port, f.proof));
  assert.deepEqual(await factoryBrowserOwner(f.port, f.proof), owner);
});

test('BR17-B: смена attempt внутри trusted await отвергает старый proof', async (t) => {
  const f = await fixture(t);
  const gate = barrier();

  f.defer(gate);

  const pending = factoryBrowserOwner(f.port, f.proof);
  const rejected = assert.rejects(pending, /browser_run_stale/u);

  await gate.entered;
  f.setTrusted({ attempt: NEXT_ATTEMPT, identity: 'new-attempt' });
  gate.release();
  await rejected;
});

test('BR17-C: тот же node после rewind с новым visit не получает старый run', async (t) => {
  const f = await fixture(t);
  const gate = barrier();

  f.defer(gate);

  const pending = factoryBrowserOwner(f.port, f.proof);
  const rejected = assert.rejects(pending, /browser_run_stale/u);

  await gate.entered;
  f.setTrusted({
    sequence: 10,
    headEventHash: 'f'.repeat(64),
    identity: 'new-visit'
  });
  gate.release();
  await rejected;
});

test('BR17-D: переход cursor в другой node внутри await закрывает run', async (t) => {
  const f = await fixture(t);
  const gate = barrier();

  f.defer(gate);

  const rejected = assert.rejects(factoryBrowserOwner(f.port, f.proof), /browser_run_stale/u);

  await gate.entered;
  f.setTrusted({
    node: 'build',
    runKey: 'BUILD',
    identity: 'cursor-build'
  });
  gate.release();
  await rejected;
});

test('BR17-D2: terminal или forbid при повторном trusted read закрывает run', async (t) => {
  const f = await fixture(t);
  const gate = barrier();

  f.defer(gate);

  const rejected = assert.rejects(factoryBrowserOwner(f.port, f.proof), /browser_run_stale/u);

  await gate.entered;
  f.deny();
  gate.release();
  await rejected;
});

test('BR17-E: death и PID reuse внутри await закрывают доступ', async (t) => {
  for (const mode of ['death', 'reuse', 'zombie', 'boot'] as const) {
    await t.test(mode, async (sub) => {
      const f = await fixture(sub);
      const gate = barrier();

      f.defer(gate);

      const rejected = assert.rejects(factoryBrowserOwner(f.port, f.proof), /browser_run_stale/u);

      await gate.entered;

      if (mode === 'death') {
        f.die();
      } else if (mode === 'reuse') {
        f.setProcess(procStat(1234, '988'));
      } else if (mode === 'zombie') {
        f.setProcess(procStat(1234, '987', 'Z'));
      } else {
        f.setBoot('22222222-2222-4222-8222-222222222222');
      }

      gate.release();
      await rejected;
    });
  }
});

test('BR17-F: active epoch и удалённая launcher identity проверяются после await', async (t) => {
  for (const mode of ['epoch', 'missing-live'] as const) {
    await t.test(mode, async (sub) => {
      const f = await fixture(sub);
      const gate = barrier();

      f.defer(gate);

      const rejected = assert.rejects(factoryBrowserOwner(f.port, f.proof), /browser_run_stale/u);

      await gate.entered;

      if (mode === 'epoch') {
        const text = await readFile(f.active, 'utf8');

        await writeFile(f.active, text.replace('EPOCH=2', 'EPOCH=3'));
      } else {
        await unlink(f.live);
      }

      gate.release();
      await rejected;
    });
  }
});

test('BR17-G: подмена binding, неизвестное поле и небезопасный mode запрещены', async (t) => {
  const f = await fixture(t);
  const binding = await readBrowserBinding(f.root, f.proof);

  assert.throws(() => decodeBrowserBinding({ ...binding, extra: true }), /browser_run_stale/u);
  assert.throws(() => decodeBrowserBinding({ ...binding, sequence: -1 }), /browser_run_stale/u);
  await chmod(f.live, 0o644);
  await assert.rejects(() => factoryBrowserOwner(f.port, f.proof), /browser_run_stale/u);
});

test('BR17-H: revoke binding идемпотентен и оставляет прежний status active без изменения', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.active, 'utf8');

  await removeBrowserBinding(f.root, f.proof);
  await removeBrowserBinding(f.root, f.proof);
  assert.equal(await readFile(f.active, 'utf8'), before);
  await assert.rejects(() => factoryBrowserOwner(f.port, f.proof), /browser_run_stale/u);
});
