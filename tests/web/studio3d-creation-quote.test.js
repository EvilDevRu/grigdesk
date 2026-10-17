import assert from 'node:assert/strict';
import test from 'node:test';
import { compileModule, webFile, singletonUrl } from './helpers/compile-vue.js';

/**
 * Управляемые ответы позволяют менять порядок завершения без сетевых таймеров.
 * Модуль получает те же refs, которые читает форма и её кнопка.
 */
async function harness(overrides = {}) {
  const { ref } = await import(singletonUrl('vue'));
  const { useCreationQuote } = await compileModule(webFile('src/features/studio3d/useCreationQuote.ts'));
  const state = {
    creationOffers: ref([]), 
    quoted: ref(null), 
    batchQuoted: ref(null), 
    changedPrice: ref(false),
    error: ref(''), 
    offer: ref({ 
      provider: 'tripo', 
      operation: 'text-to-model', 
      quote: { total: 40 } 
    }),
    mode: ref('text'), 
    batch: ref(false), 
    values: ref({ prompt: 'кот' }),
  };
  const control = { 
    active: true, 
    alive: true, 
    library: 'library', 
    rows: 1 
  };
  const calls = [];
  const quote = useCreationQuote({
    ...state,
    inputs: () => [],
    lines: () => Array(control.rows).fill('кот'),
    batchRows: () => [{ values: { prompt: 'кот' } }],
    isAlive: () => control.alive,
    isActive: () => control.active,
    libraryId: () => control.library,
    loadOffers: async () => ({ libraryId: 'library', offers: [] }),
    quote: async (input) => {
      calls.push(['quote', input]);

      return null;
    },
    batchQuote: async (rows) => {
      calls.push(['batch', rows]);

      return { libraryId: 'library', totalEstimated: 80 };
    },
    ...overrides,
  });

  return { 
    ...state, 
    control, 
    calls, 
    quote 
  };
}

/**
 * Promise завершается явно: тест выбирает момент ответа после изменения формы.
 * Это проверяет поздние результаты, не полагаясь на задержки среды.
 */
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

test('CQ-01 новая форма немедленно очищает обе цены, B защищён от позднего A', async () => {
  const a = deferred();
  const b = deferred();
  let count = 0;
  const h = await harness({ quote: () => (++count === 1 ? a : b).promise });

  h.quoted.value = { quote: { total: 20 } };
  h.batchQuoted.value = { totalEstimated: 40 };
  h.changedPrice.value = true;
  h.quote.refreshQuote();
  assert.equal(h.quoted.value, null);
  assert.equal(h.batchQuoted.value, null);
  assert.equal(h.changedPrice.value, false);
  h.quote.refreshQuote();
  b.resolve({ libraryId: 'library', quote: { total: 50 } });
  await Promise.resolve();
  a.resolve({ libraryId: 'library', quote: { total: 20 } });
  await Promise.resolve();
  assert.equal(h.quoted.value.quote.total, 50);
});

test('CQ-02 скрытая или освобождённая форма не публикует старую цену', async () => {
  for (const change of ['hide', 'dispose', 'library']) {
    const result = deferred();
    const h = await harness({ quote: () => result.promise });

    h.quote.refreshQuote();

    if (change === 'hide') {
      h.control.active = false;
    } else if (change === 'dispose') {
      h.control.alive = false;
      h.quote.dispose();
    } else {
      h.control.library = 'new-library';
    }

    result.resolve({ libraryId: 'library', quote: { total: 40 } });
    await Promise.resolve();
    assert.equal(h.quoted.value, null, change);
  }
});

test('CQ-03 batchQuote ждёт 300 мс, новый расчёт отзывает прежний таймер', async (t) => {
  const h = await harness();

  t.mock.timers.enable({ apis: ['setTimeout'] });
  h.batch.value = true;
  h.quote.refreshQuote();
  t.mock.timers.tick(299);
  assert.equal(h.calls.length, 0);
  h.quote.refreshQuote();
  t.mock.timers.tick(299);
  assert.equal(h.calls.length, 0);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], 'batch');
  assert.equal(h.batchQuoted.value.totalEstimated, 80);
  h.quote.refreshQuote();
  h.quote.dispose();
  t.mock.timers.tick(300);
  assert.equal(h.calls.length, 1);
});

test('CQ-04 неизвестный total не превращается в ноль и не заказывает пачку', async (t) => {
  const h = await harness();

  t.mock.timers.enable({ apis: ['setTimeout'] });
  h.batch.value = true;
  h.offer.value.quote.total = null;
  h.quote.refreshQuote();
  t.mock.timers.tick(300);
  assert.equal(h.calls.length, 0);
  assert.equal(h.batchQuoted.value, null);
});

test('CQ-05 priceChanged меняет цену кнопки и ждёт изменения формы для batchQuote', async (t) => {
  const h = await harness();
  const next = { 
    total: 55, 
    unit: null, 
    lines: [], 
    usd: null, 
    note: null 
  };

  t.mock.timers.enable({ apis: ['setTimeout'] });
  h.batch.value = true;
  h.quoted.value = { quote: { total: 40 } };
  h.batchQuoted.value = { totalEstimated: 80 };
  h.quote.priceChanged(next);
  assert.equal(h.changedPrice.value, true);
  assert.deepEqual(h.quoted.value.quote, next);
  assert.equal(h.batchQuoted.value, null);
  t.mock.timers.tick(600);
  assert.equal(h.calls.length, 0);
  h.quote.refreshQuote();
  t.mock.timers.tick(300);
  assert.equal(h.calls.length, 1);
});

test('CQ-06 предложения отсекают поздний ответ прежнего входа', async () => {
  const a = deferred();
  const b = deferred();
  let count = 0;
  const h = await harness({ loadOffers: () => (++count === 1 ? a : b).promise });
  const first = h.quote.refreshOffers();
  const second = h.quote.refreshOffers();

  b.resolve({ libraryId: 'library', offers: [{ provider: 'B' }] });
  await second;
  a.resolve({ libraryId: 'library', offers: [{ provider: 'A' }] });
  await first;
  assert.deepEqual(h.creationOffers.value, [{ provider: 'B' }]);
});
