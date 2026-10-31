import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserHost, executeBrowserCommand } from '../../web/src/shared/browser/browserHost.ts';
import type {
  BrowserCommand,
  BrowserCommandCache,
  BrowserHostIdentity,
} from '../../web/src/shared/browser/browserHost.ts';

/**
 * Все границы async управляются тестом; нет предположений о скорости filesystem или сети.
 * Барьер даёт положить поздний ACK ровно после logout/profile switch.
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return {
    promise,
    resolve,
    reject
  };
}

/**
 * Короткая проверка microtask progress не ожидает wall clock таймер.
 * Неудача называет незавершённое условие вместо зависания всего файла.
 */
async function settled(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) {
      return;
    }

    await Promise.resolve();
  }

  assert.equal(predicate(), true, 'microtask barrier не достигнут');
}

function command(hostId = 'host-1', hostEpoch = 1): BrowserCommand {
  return {
    requestId: 'request-1',
    hostId,
    hostEpoch,
    remainingMs: 1200,
    action: 'click',
    tabId: 'tab-1',
    grantEpoch: 2,
    pageEpoch: 3,
    ref: 'e1',
  };
}

/**
 * Один fake backend выдаёт commands только по явному deliver, timer — по tick.
 * Непогашенные waits/polls отклоняются при abort и не удерживают Node процесс.
 */
function fixture() {
  let now = 1000;
  let registrations = 0;
  let rejectNative = false;
  let registerGate: ReturnType<typeof deferred<BrowserHostIdentity>> | null = null;
  let registerFailure: Error | null = null;
  let heartbeatFailure = false;
  const native: Record<string, unknown>[] = [];
  const states: { phase: string; error: string }[] = [];
  const replies: unknown[] = [];
  const removed: string[] = [];
  const starts: boolean[] = [];
  const beats: unknown[] = [];
  const polls: {
    signal: AbortSignal;
    deliver(value: BrowserCommand | null): void;
  }[] = [];
  const waits: { signal: AbortSignal; resolve(): void }[] = [];
  const host = createBrowserHost({
    now: () => now,
    wait: async (_ms, signal) => new Promise<void>((resolve, reject) => {
      const cancel = () => reject(new Error('aborted'));

      signal.addEventListener('abort', cancel, { once: true });
      waits.push({ signal, resolve: () => {
        signal.removeEventListener('abort', cancel);
        resolve();
      } });
    }),
    register: async (takeover) => {
      registrations += 1;
      starts.push(takeover);

      if (registerFailure) {
        throw registerFailure;
      }

      return registerGate ? registerGate.promise : {
        id: 'host-' + registrations,
        token: 'private-' + registrations,
        hostEpoch: registrations,
        leaseMs: 15000,
      };
    },
    heartbeat: async (_identity, projection) => {
      beats.push(projection);

      if (heartbeatFailure) {
        throw new Error('offline');
      }

      return { leaseMs: 15000 };
    },
    poll: async (_identity, signal) => new Promise((resolve, reject) => {
      const cancel = () => reject(new Error('aborted'));

      signal.addEventListener('abort', cancel, { once: true });
      polls.push({ signal, deliver: (value) => {
        signal.removeEventListener('abort', cancel);
        resolve(value);
      } });
    }),
    result: async (_identity, requestId, value) => {
      replies.push({ requestId, value });
    },
    unregister: async (identity) => {
      removed.push(identity.id);
    },
    native: async (value) => {
      const request = value as Record<string, unknown>;

      native.push(request);

      if (request.operation === 'execute' && rejectNative) {
        throw new Error('sensitive native stack');
      }

      return request.operation === 'state' ? { tabs: [] } : { ok: true };
    },
    owners: async () => [{ id: 'owner-1', label: 'Fixture' }],
    grant: async () => ({ ok: true }),
    revoke: async () => {},
    changed: (state) => {
      states.push(state);
    },
  });

  return {
    host,
    native,
    states,
    replies,
    removed,
    starts,
    beats,
    polls,
    registrations: () => registrations,
    rejectNative: () => {
      rejectNative = true;
    },
    holdRegister() {
      registerGate = deferred<BrowserHostIdentity>();

      return registerGate;
    },
    failRegister(error: Error) {
      registerFailure = error;
    },
    failHeartbeat() {
      heartbeatFailure = true;
    },
    /**
     * Команда доставляется ровно одному живому ожиданию poll.
     * Abort предыдущего поколения исключает его из возможных получателей.
     */
    deliver(value: BrowserCommand) {
      const pending = polls.find((item) => !item.signal.aborted);

      assert.equal(Boolean(pending), true);
      polls.splice(polls.indexOf(pending!), 1);
      pending!.deliver(value);
    },
    /**
     * Fake clock сдвигается независимо от реального времени машины.
     * Разрешаются только ещё живые heartbeat ожидания этого шага.
     */
    tick() {
      now += 5000;

      for (const pending of waits.splice(0)) {
        if (!pending.signal.aborted) {
          pending.resolve();
        }
      }
    },
  };
}

test('BR-H01: duplicate/ACK failure не повторяют effect, remainingMs может уменьшиться', async () => {
  const cache: BrowserCommandCache = new Map();
  let executes = 0;
  let replies = 0;
  const port = {
    now: () => 1000,
    allowed: () => true,
    execute: async () => {
      executes += 1;

      return { ok: true };
    },
    reply: async () => {
      replies += 1;

      if (replies === 1) {
        throw new Error('lost ACK');
      }
    },
  };

  await assert.rejects(executeBrowserCommand(port, cache, command()), /lost ACK/u);
  await executeBrowserCommand(port, cache, { ...command(), remainingMs: 800 });
  assert.equal(executes, 1);
  assert.equal(replies, 2);
});

test('BR-H02: execute exception даёт bounded error ACK, не зависший broker request', async () => {
  const reply: unknown[] = [];
  let executes = 0;
  const port = {
    now: () => 1000,
    allowed: () => true,
    execute: async () => {
      executes += 1;

      throw new Error('private stack');
    },
    reply: async (_id: string, value: unknown) => {
      reply.push(value);
    },
  };
  const cache: BrowserCommandCache = new Map();

  await Promise.all([
    executeBrowserCommand(port, cache, command()),
    executeBrowserCommand(port, cache, command()),
  ]);
  assert.equal(executes, 1);
  assert.deepEqual(reply, [
    { ok: false, error: 'browser_execution_failed' },
    { ok: false, error: 'browser_execution_failed' },
  ]);
});

test('BR-H03: один register/poll, heartbeat независим, local deadline вместо server time', async (t) => {
  const f = fixture();

  t.after(() => f.host.dispose());
  f.host.update('profile/auth');
  f.host.update('profile/auth');
  await settled(() => f.polls.length === 1);
  assert.equal(f.registrations(), 1);
  f.tick();
  await settled(() => f.beats.length === 1);
  assert.equal(f.polls.length, 1);
  f.deliver(command());
  await settled(() => f.replies.length === 1);

  const effect = f.native.find((item) => item.operation === 'execute')!;

  assert.equal((effect.command as Record<string, unknown>).deadline, 7200);
  assert.equal('remainingMs' in (effect.command as object), false);
  assert.equal(f.polls.length, 1);
});

test('BR-H04: disable/logout abort poll, revoke native до unregister, late delivery без effect',
  async (t) => {
  const f = fixture();

  t.after(() => f.host.dispose());
  f.host.update('profile/auth');
  await settled(() => f.polls.length === 1);

  const old = f.polls[0]!;

  f.host.update(null);
  old.deliver(command());
  await settled(() => f.removed.length === 1);
  assert.equal(old.signal.aborted, true);
  assert.equal(f.native.some((item) => item.operation === 'execute'), false);
  assert.equal(f.native.some((item) => item.operation === 'host-stop' && item.hostId === 'host-1'), true);
  assert.equal(f.states.at(-1)?.phase, 'off');
});

test('BR-H05: поздний register после profile switch не запускает старый native host', async (t) => {
  const f = fixture();
  const gate = f.holdRegister();

  t.after(() => f.host.dispose());
  f.host.update('old/auth');
  f.host.update(null);
  gate.resolve({
    id: 'old',
    token: 'private',
    hostEpoch: 1,
    leaseMs: 15000
  });
  await settled(() => f.removed.includes('old'));
  assert.equal(f.native.some((item) => item.operation === 'host-start'), false);
  assert.equal(f.polls.length, 0);
});

test('BR-H06: конфликт не вызывает automatic takeover, действие человека делает takeover=true', async (t) => {
  const f = fixture();
  const error = Object.assign(new Error('conflict'), { status: 409 });

  t.after(() => f.host.dispose());
  f.failRegister(error);
  f.host.update('profile/auth');
  await settled(() => f.states.some((state) => state.phase === 'conflict'));
  assert.deepEqual(f.starts, [false]);
  f.host.retry(true);
  await settled(() => f.starts.length === 2);
  assert.deepEqual(f.starts, [false, true]);
});

test('BR-H07: native execute error отправляется broker, token не становится status', async (t) => {
  const f = fixture();

  t.after(() => f.host.dispose());
  f.rejectNative();
  f.host.update('profile/auth');
  await settled(() => f.polls.length === 1);
  f.deliver(command());
  await settled(() => f.replies.length === 1);
  assert.deepEqual(f.replies[0], {
    requestId: 'request-1', value: { ok: false, error: 'browser_execution_failed' },
  });
  assert.equal(JSON.stringify(f.states).includes('private'), false);
});

test('BR-H08: heartbeat failure abort-ит poll и отзывает native, без takeover retry', async (t) => {
  const f = fixture();

  t.after(() => f.host.dispose());
  f.host.update('profile/auth');
  await settled(() => f.polls.length === 1);
  f.failHeartbeat();
  f.tick();
  await settled(() => f.removed.length === 1);
  assert.equal(f.polls[0]!.signal.aborted, true);
  assert.equal(f.native.some((item) => item.operation === 'host-stop'), true);
  assert.equal(f.states.at(-1)?.phase, 'error');
  assert.deepEqual(f.starts, [false]);
});

test('BR-H09: команда другого host/epoch не достигает execute', async (t) => {
  const f = fixture();

  t.after(() => f.host.dispose());
  f.host.update('profile/auth');
  await settled(() => f.polls.length === 1);
  f.deliver(command('old-host', 1));
  await settled(() => f.removed.length === 1);
  assert.equal(f.native.some((item) => item.operation === 'execute'), false);
});

test('BR-H10: закрытое приложение возвращает browser_unavailable без раскрытия stack', async () => {
  let result: unknown;

  await executeBrowserCommand({
    now: () => 1000,
    allowed: () => true,
    execute: async () => {
      throw new Error('browser_unavailable');
    },
    reply: async (_id, value) => {
      result = value;
    },
  }, new Map(), command());
  assert.deepEqual(result, { ok: false, error: 'browser_unavailable' });
});
