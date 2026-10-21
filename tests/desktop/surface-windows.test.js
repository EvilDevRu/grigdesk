import assert from 'node:assert/strict';
import test from 'node:test';
import { createSurfaceWindows } from '../../desktop/src/surfaceWindows.ts';
/**
 * Каждое окно наблюдаемо отдельно; загрузкой, сроком и отказом создания управляет тест.
 * Фикстура не поднимает Electron и не использует реальный профиль.
 */
function fixture() {
  const made = [];
  const timers = [];
  let origin = 'http://127.0.0.1:47101';
  let hold = null;
  let failCreate = false;
  const prepared = [];
  const controller = createSurfaceWindows({
    allowedOrigin: () => origin,
    beforeShow(win) {
      prepared.push({ id: win.target.id, shows: win.shows });
    },
    schedule(callback) {
      timers.push(callback);

      return () => {
      };
    },
    /**
     * Fake хранит свои события, индекс каскада и историю загрузок.
     * Удерживаемая загрузка завершается только по команде теста.
     */
    create(url, target, index) {
      if (failCreate) {
        throw new Error('Electron отказал в создании окна');
      }

      const handlers = new Map();
      const win = {
        target,
        index,
        destroyed: false,
        shows: 0,
        focuses: 0,
        loads: [],
        isDestroyed() {
          return this.destroyed;
        },
        show() {
          this.shows += 1;
        },
        focus() {
          this.focuses += 1;
        },
        isMinimized() {
          return false;
        },
        restore() {
        },
        destroy() {
          this.destroyed = true;
          handlers.get('closed')?.();
        },
        on(name, callback) {
          handlers.set(name, callback);

          return this;
        },
        /**
         * Удержание действует на одну следующую загрузку и сразу снимается.
         * Остальные загрузки завершаются в ближайшей микрозадаче.
         */
        async loadURL(value) {
          const current = hold;

          this.loads.push(value);
          hold = null;
          await current;
        },
      };

      made.push(win);

      return win;
    },
  });

  return {
    controller,
    made,
    timers,
    prepared,
    changeOrigin(value) {
      origin = value;
    },
    holdNext(promise) {
      hold = promise;
    },
    rejectCreate(value) {
      failCreate = value;
    },
  };
}

test('SW-01: у каждой задачи своё окно, повтор поднимает его без новой загрузки', async () => {
  const f = fixture();
  const origin = 'http://127.0.0.1:47101';
  const first = f.controller.open(origin, { kind: 'task', id: '42' });
  const quick = f.controller.open(origin, { kind: 'task', id: '42' });

  assert.equal(await first, true);
  assert.equal(await quick, true);
  assert.equal(f.made.length, 1);
  assert.equal(await f.controller.open(origin, { kind: 'task', id: '43' }), true);
  assert.equal(f.made.length, 2);
  assert.deepEqual(f.made.map((win) => win.target.id), ['42', '43']);
  assert.deepEqual(f.made.map((win) => win.index), [0, 1]);
  assert.deepEqual(f.made.map((win) => win.loads.length), [1, 1]);
  assert.equal(f.made[1].loads[0], origin + '/?surface=task&id=43#/surface');

  const focuses = f.made[0].focuses;

  assert.equal(await f.controller.open(origin, { kind: 'task', id: '42' }), true);
  assert.equal(f.made.length, 2);
  assert.equal(f.made[0].loads.length, 1);
  assert.equal(f.made[0].focuses, focuses + 1);
  assert.deepEqual(f.prepared, [{ id: '42', shows: 0 }, { id: '43', shows: 0 }]);
  f.controller.closeAll();
  assert.equal(f.made.every((win) => win.destroyed), true);
});
test('SW-02: отмена pending не показывает окно; старый origin не создаёт новое', async () => {
  const f = fixture();
  const blocked = Promise.withResolvers();

  f.holdNext(blocked.promise);

  const opening = f.controller.open('http://127.0.0.1:47101', { kind: 'task', id: '42' });

  f.controller.closeAll();
  blocked.resolve();
  assert.equal(await opening, false);
  assert.equal(f.made[0].destroyed, true);
  assert.equal(f.made[0].shows, 0);
  assert.deepEqual(f.prepared, []);
  f.changeOrigin('http://127.0.0.1:47102');
  assert.equal(await f.controller.open('http://127.0.0.1:47101', {
    kind: 'task',
    id: '43',
  }), false);
  assert.equal(f.made.length, 1);

  const stale = Promise.withResolvers();

  f.holdNext(stale.promise);

  const changed = f.controller.open('http://127.0.0.1:47102', { kind: 'task', id: '43' });

  f.changeOrigin('http://127.0.0.1:47103');
  stale.resolve();
  assert.equal(await changed, false);
  assert.equal(f.made[1].shows, 0);
  f.controller.closeAll();

  const next = fixture();
  const oldLoad = Promise.withResolvers();
  const origin = 'http://127.0.0.1:47101';
  const target = { kind: 'task', id: '42' };

  next.holdNext(oldLoad.promise);

  const oldOpen = next.controller.open(origin, target);

  next.controller.closeAll();
  assert.equal(await next.controller.open(origin, target), true);
  oldLoad.resolve();
  assert.equal(await oldOpen, false);
  assert.equal(await next.controller.open(origin, target), true);
  assert.equal(next.made.length, 2);
  assert.equal(next.made[1].loads.length, 1);
  next.controller.closeAll();
});
test('SW-03: срок уничтожает окно до отказа, затем та же задача открывается заново', async () => {
  const f = fixture();
  const origin = 'http://127.0.0.1:47101';

  f.holdNext(new Promise(() => {
  }));

  const pending = f.controller.open(origin, { kind: 'task', id: '42' });

  f.timers[0]();
  assert.equal(await pending, false);
  assert.equal(f.made[0].destroyed, true);
  assert.deepEqual(f.prepared, []);
  assert.equal(await f.controller.open(origin, { kind: 'task', id: '42' }), true);
  assert.equal(f.made.length, 2);
  f.controller.closeAll();
});
test('SW-04: закрытое окно освобождает задачу, отказ создания не оставляет записи', async () => {
  const f = fixture();
  const origin = 'http://127.0.0.1:47101';

  assert.equal(await f.controller.open(origin, { kind: 'task', id: '42' }), true);
  f.made[0].destroy();
  assert.equal(await f.controller.open(origin, { kind: 'task', id: '42' }), true);
  assert.equal(f.made.length, 2);
  assert.equal(f.made[1].index, 0);
  f.rejectCreate(true);
  assert.equal(await f.controller.open(origin, { kind: 'task', id: '43' }), false);
  f.rejectCreate(false);
  f.holdNext(Promise.reject(new Error('Загрузка документа отклонена')));
  assert.equal(await f.controller.open(origin, { kind: 'task', id: '43' }), false);
  assert.equal(f.made[2].destroyed, true);
  assert.equal(await f.controller.open(origin, { kind: 'task', id: '43' }), true);
  assert.equal(f.made.length, 4);
  assert.equal(f.made[3].index, 1);
  f.controller.closeAll();
});
