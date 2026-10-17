import assert from 'node:assert/strict';
import test from 'node:test';
import { createViewerLease, viewerDiagnostics } from '../../web/src/shared/viewer3d/viewerBudget.ts';

const MiB = 1024 * 1024;

/**
 * Все доли, временные и опубликованные, освобождаются даже при упавшем assertion.
 * Прямой импорт проверяет один бюджет без создания engine или новой сборки three.
 */
function leases(t) {
  const held = [];

  assert.deepEqual(viewerDiagnostics(), { contexts: 0, memory: 0 });
  t.after(() => {
    held.reverse().forEach((lease) => lease.release());
    assert.deepEqual(viewerDiagnostics(), { contexts: 0, memory: 0 });
  });

  return {
    create() {
      const lease = createViewerLease();

      held.push(lease);

      return lease;
    },
    publish(lease, amount) {
      const published = lease.publish(amount);

      held.push(published);

      return published;
    }
  };
}

test('VL-01 reserve принимает абсолютный объём и не уменьшает максимум', (t) => {
  const h = leases(t);
  const lease = h.create();

  for (const [amount, expected] of [[100, 100], [300, 300], [200, 300]]) {
    lease.reserve(amount * MiB);
    assert.equal(viewerDiagnostics().memory, expected * MiB);
  }
});

test('VL-02 поток по 64 КиБ и рост собственного резерва не учитываются дважды', (t) => {
  const h = leases(t);
  const lease = h.create();

  for (let amount = 64 * 1024; amount <= 100 * MiB; amount += 64 * 1024) {
    lease.reserve(amount);
  }

  assert.equal(viewerDiagnostics().memory, 100 * MiB);
  lease.reserve(300 * MiB);
  lease.reserve(800 * MiB);
  assert.equal(viewerDiagnostics().memory, 800 * MiB);
});

test('VL-03 два одновременных резерва 600 и 500 МиБ отклоняются', (t) => {
  const h = leases(t);
  const a = h.create();
  const b = h.create();

  a.reserve(600 * MiB);
  assert.throws(() => b.reserve(500 * MiB), {
    message: 'Загрузка и две модели превышают общий бюджет 1024 МиБ.'
  });
  assert.equal(viewerDiagnostics().memory, 600 * MiB);
});

test('VL-04 publish переводит резерв в память модели без двойного учёта', (t) => {
  const h = leases(t);
  const lease = h.create();

  lease.reserve(800 * MiB);

  const model = h.publish(lease, 600 * MiB);

  assert.equal(viewerDiagnostics().memory, 600 * MiB);
  lease.release();
  assert.equal(viewerDiagnostics().memory, 600 * MiB);
  model.release();
  assert.equal(viewerDiagnostics().memory, 0);
});

test('VL-05 отказ publish не меняет долю опубликованной A', (t) => {
  const h = leases(t);
  const a = h.create();
  const b = h.create();

  a.reserve(600 * MiB);
  h.publish(a, 600 * MiB);
  b.reserve(400 * MiB);
  assert.throws(() => b.publish(500 * MiB), {
    message: 'Две модели превышают общий бюджет 1024 МиБ.'
  });
  assert.equal(viewerDiagnostics().memory, 1000 * MiB);
  b.release();
  assert.equal(viewerDiagnostics().memory, 600 * MiB);
});

test('VL-06 повторный release A оставляет ровно B и запрещает превышение третьей моделью', (t) => {
  const h = leases(t);
  const a = h.create();
  const b = h.create();

  a.reserve(100 * MiB);

  const modelA = h.publish(a, 100 * MiB);

  b.reserve(600 * MiB);
  h.publish(b, 600 * MiB);
  modelA.release();
  modelA.release();
  a.release();
  a.release();
  assert.equal(viewerDiagnostics().memory, 600 * MiB);

  const c = h.create();

  assert.throws(() => c.reserve(500 * MiB), {
    message: 'Загрузка и две модели превышают общий бюджет 1024 МиБ.'
  });
  assert.equal(viewerDiagnostics().memory, 600 * MiB);
});
