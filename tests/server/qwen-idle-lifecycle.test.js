import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatLiveSessions } from '../../server/src/lib/chat/liveSessions.ts';
import { decodeQwenActivity } from '../../server/src/lib/qwen/activity.ts';
import { QWEN_IDLE_EXTENSION } from '../../server/src/lib/qwen/idleBridgeRuntime.ts';

const idle = () => ({ state: 'idle', reasons: [] });
const scheduled = () => ({ state: 'busy', reasons: [{ kind: 'schedule', count: 1 }] });

/**
 * Один managed send открывает keepAlive-процесс, затем native сообщает полный статус.
 * Таймеры виртуальные, а условное закрытие остаётся отдельной наблюдаемой границей.
 */
async function poolFixture(t, close = async () => true) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });

  const pool = new ChatLiveSessions({ idleMs: 60000 });
  let hooks;
  let attempts = 0;
  const handle = {
    alive: true,
    send: async () => ({ sessionId: 'synthetic' }),
    interrupt: async () => {},
    close: async () => {
      handle.alive = false;
    },
    closeIfIdle: async () => {
      attempts += 1;

      return close();
    },
  };
  const executor = {
    id: 'observed',
    session: {
      mode: 'persistent',
      keepAlive: true,
      limitExempt: true,
      open: async (spec) => {
        hooks = spec.hooks;

        return handle;
      },
    },
  };

  t.after(async () => {
    t.mock.timers.reset();
    await pool.closeAll();
  });
  await pool.run({ chatKey: 'synthetic', executor }, {});

  return {
    pool,
    executor,
    hooks,
    attempts: () => attempts,
    async advance(milliseconds, activity = idle()) {
      for (let elapsed = 0; elapsed < milliseconds; elapsed += 10000) {
        hooks.onActivity(activity);
        t.mock.timers.tick(Math.min(10000, milliseconds - elapsed));
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

test('idle: повторные подтверждения не продлевают интервал, процесс закрывается', async (t) => {
  const f = await poolFixture(t);

  await f.advance(60000);
  assert.equal(f.attempts(), 1);
  assert.equal(f.pool.has('synthetic'), false);
});

test('idle: расписание удерживает процесс, после удаления начинается полный интервал', async (t) => {
  const f = await poolFixture(t);

  await f.advance(120000, scheduled());
  assert.equal(f.attempts(), 0);
  assert.equal(f.pool.stats()[0].idleAtMs, null);
  await f.advance(50000);
  assert.equal(f.attempts(), 0);
  await f.advance(10000);
  assert.equal(f.attempts(), 1);
});

test('idle: неизвестный или устаревший статус запрещает закрытие', async (t) => {
  const f = await poolFixture(t);

  f.hooks.onActivity(idle());
  t.mock.timers.tick(120000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.attempts(), 0);
  assert.equal(f.pool.stats()[0].activity.state, 'unknown');
  await f.advance(50000);
  assert.equal(f.attempts(), 0, 'После разрыва подтверждений нужен новый полный интервал');
  f.hooks.onActivity({ state: 'unknown', reasons: [{ kind: 'unknown' }] });
  t.mock.timers.tick(120000);
  assert.equal(f.attempts(), 0);
});

test('idle: отказ native закрытия сохраняет процесс и не крутит быстрый повтор', async (t) => {
  const f = await poolFixture(t, async () => false);

  await f.advance(60000);
  assert.equal(f.attempts(), 1);
  assert.equal(f.pool.has('synthetic'), true);
  await f.advance(50000);
  assert.equal(f.attempts(), 1);
});

test('idle: неподтверждённое завершение scope сохраняет запись с неизвестным статусом', async (t) => {
  const f = await poolFixture(t, async () => {
    throw new Error('synthetic scope completion unknown');
  });

  await f.advance(60000);
  assert.equal(f.pool.has('synthetic'), true);
  assert.equal(f.pool.stats()[0].activity.state, 'unknown');
});

for (const value of [
  {
    v: 1,
    sessionId: 'foreign',
    ...idle(),
  },
  {
    v: 1,
    sessionId: 'own',
    state: 'idle',
    reasons: [{ kind: 'schedule', count: 1 }],
  },
  {
    v: 1,
    sessionId: 'own',
    state: 'busy',
    reasons: [],
  },
  {
    v: 1,
    sessionId: 'own',
    state: 'busy',
    reasons: [{ kind: 'new-kind', count: 1 }],
  },
]) {
  test(`idle decoder: неизвестный снимок не даёт разрешение ${JSON.stringify(value)}`, () => {
    assert.equal(decodeQwenActivity(value, 'own').state, 'unknown');
  });
}

/**
 * Тот же extension исполняется на двойнике native Session с независимыми реестрами.
 * Проверяется покрытие невидимых heartbeat причин, а не текст шаблона патча.
 */
function nativeSession() {
  const schedules = [];
  const monitors = [];
  const goal = { goal: null };

  class Session {
    collectActiveWorkHolds() {
      return [];
    }

    getConfig() {
      return {
        getCronScheduler: () => ({ list: () => schedules, hasGatesInFlight: () => false }),
        getMonitorRegistry: () => ({ getAll: () => monitors }),
        getGoalRuntime: () => ({ getSnapshot: () => goal }),
      };
    }

    isTurnIdle() {
      return true;
    }
  }

  const createSnapshot = new Function('Session',
    QWEN_IDLE_EXTENSION + '\nreturn grigDeskSessionActivity;');
  const snapshot = createSnapshot(Session);
  const session = new Session();

  return {
    session,
    snapshot,
    schedules,
    monitors,
    goal,
  };
}

test('native extension: будущий wakeup защищён, удаление последнего снимает защиту', () => {
  const f = nativeSession();

  assert.equal(f.snapshot(f.session).state, 'idle');
  f.schedules.push({ cronExpr: '@wakeup', fireAtMs: Date.now() + 3600000 });
  assert.equal(f.snapshot(f.session).state, 'busy');
  assert.equal(f.snapshot(f.session).reasons[0].kind, 'schedule');
  assert.equal(f.session.collectActiveWorkHolds()[0].category, 'tool');
  f.schedules.length = 0;
  assert.equal(f.snapshot(f.session).state, 'idle');
});

test('native extension: монитор и активная цель удерживают условное закрытие', () => {
  const f = nativeSession();

  f.monitors.push({ status: 'running' });
  f.goal.goal = { status: 'active' };
  assert.deepEqual(f.snapshot(f.session).reasons.map((reason) => reason.kind), ['monitor', 'goal']);
  assert.equal(f.session.collectActiveWorkHolds().length, 2);
  f.session.closing = true;
  assert.equal(f.session.collectActiveWorkHolds().length, 2, 'Close gate не скрывает фоновые причины');
});

test('idle: новый пользовательский ход начинает полный интервал заново', async (t) => {
  const f = await poolFixture(t);

  await f.advance(50000);
  await f.pool.run({ chatKey: 'synthetic', executor: f.executor }, {});
  await f.advance(10000);
  assert.equal(f.attempts(), 0);
  await f.advance(50000);
  assert.equal(f.attempts(), 1);
});

test('idle: следующий send ждёт native-проверку и продолжает не закрытый процесс', async (t) => {
  let release;
  const checked = new Promise((resolve) => {
    release = resolve;
  });
  const f = await poolFixture(t, async () => {
    await checked;

    return false;
  });

  await f.advance(60000);

  let continued = false;
  const next = f.pool.run({ chatKey: 'synthetic', executor: f.executor }, {}).then(() => {
    continued = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(continued, false, 'Ход не должен уйти в проверяемое поколение');
  release();
  await next;
  assert.equal(continued, true);
  assert.equal(f.pool.has('synthetic'), true);
});
