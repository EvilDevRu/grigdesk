import assert from 'node:assert/strict';
import test from 'node:test';
import { createHelpLoader } from '../../web/src/shared/helpLoader.ts';
import type { HelpLoadState } from '../../web/src/shared/helpLoader.ts';
import { localeCorpus } from '../helpers/helpLocale.mts';

/**
 * Ответы разрешает сам тест, поэтому гонка не зависит от сетевых таймингов.
 * Второй сервер выбран до завершения чтения первого.
 */
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return {
    promise,
    resolve,
    reject
  };
}

function corpus(version: string) {
  return {
    format: 1,
    version,
    commit: 'a'.repeat(40),
    revision: 'b'.repeat(64),
    locale: 'ru',
    articles: [{
      id: 'overview',
      file: 'README.md',
      title: 'Начало',
      section: 'Основы',

      keywords: [],
      routes: [],
      markdown: '# Начало'
    }]
  };
}

test('HELP-UI1: ответ старой машины не возвращается после смены или отмены', async () => {
  const first = deferred();
  const second = deferred();
  const queue = [first.promise, second.promise];
  const states: HelpLoadState[] = [];
  const loader = createHelpLoader(() => queue.shift()!, (state) => states.push(state));
  const left = loader.reload();
  const right = loader.reload();

  second.resolve(corpus('0.2.0'));
  await right;
  first.resolve(corpus('0.1.0'));
  await left;
  assert.equal(states.at(-1)?.bundle?.version, '0.2.0');
  loader.cancel();
  assert.equal(states.at(-1)?.bundle, null);
});
test('HELP-UI2: старый сервер, повреждённый JSON и повтор — наблюдаемые разные состояния', async () => {
  const states: HelpLoadState[] = [];
  let mode = 0;
  const loader = createHelpLoader(async () => {
    if (mode === 0) {
      throw {
        status: 404
      };
    }

    return mode === 1 ? {
      unexpected: true
    } : corpus('0.2.0');
  }, (state) => states.push(state));

  await loader.reload();
  assert.equal(states.at(-1)?.error, 'helpServerUpgradeRequired');
  mode = 1;
  await loader.reload();
  assert.equal(states.at(-1)?.error, 'helpUnavailable');
  mode = 2;
  await loader.reload();
  assert.equal(states.at(-1)?.status, 'ready');
});


test('HELP-KEEP-LATE-ERROR: поздний отказ A оставляет готовый B, cancel очищает корпус', async () => {
  const first = deferred();
  const states: HelpLoadState[] = [];
  let calls = 0;
  const loader = createHelpLoader(() => ++calls === 1 ? first.promise : Promise.resolve(corpus('0.2.0')),
    (state) => states.push(state));
  const old = loader.reload();

  await loader.reload();
  first.reject(new Error('Старый сервер недоступен'));
  await old;
  assert.deepEqual(states.at(-1)?.bundle, corpus('0.2.0'));
  loader.cancel();
  assert.equal(states.at(-1)?.bundle, null);
});

/**
 * Старая сигнатура вызывается обычным JS-вызовом с лишним аргументом.
 * RED определяется переданной локалью и итоговым корпусом, а не ошибкой TypeScript.
 */
function reloadLocale(loader: ReturnType<typeof createHelpLoader>, locale: string) {
  return Reflect.apply(loader.reload, loader, [locale]);
}

test('HELP-UI-L1: callback получает snapshot locale, состояние содержит цельную identity', async () => {
  const states: HelpLoadState[] = [];
  const requested: unknown[] = [];
  const loader = createHelpLoader(async (...args: unknown[]) => {
    requested.push(args[0]);

    return localeCorpus(args[0] === 'en' ? 'en' : 'ru', '0.2.0');
  }, (state) => states.push(state));

  await reloadLocale(loader, 'en');
  assert.deepEqual(requested, ['en']);
  assert.deepEqual(states.at(-1)?.bundle, localeCorpus('en', '0.2.0'));
});

for (const kind of ['legacy', 'locale-404', 'endpoint-404', 'unauthorized', 'network',
  'invalid-json', 'wrong-locale', 'fallback-failure']) {
  test(`HELP-UI-L1: ${kind} имеет явный результат и безопасный повтор`, async () => {
    const states: HelpLoadState[] = [];
    const requested: unknown[] = [];
    let retry = false;
    const loader = createHelpLoader(async (...args: unknown[]) => {
      const locale = args[0];

      requested.push(locale);

      if (retry) {
        return localeCorpus('en');
      }
      if (kind === 'legacy') {
        return localeCorpus('ru');
      }
      if (locale === 'ru') {
        if (kind === 'fallback-failure') {
          throw new Error('Резерв тоже недоступен');
        }

        return localeCorpus('ru');
      }
      if (kind === 'invalid-json') {
        return { broken: true };
      }
      if (kind === 'wrong-locale') {
        return { ...localeCorpus('en'), locale: 'de' };
      }

      throw kind === 'network' ? new Error('Нет сети') : {
        status: kind === 'unauthorized' ? 401 : 404,
        data: { error: kind === 'endpoint-404' ? 'not_found' : 'help_locale_unavailable' },
      };
    }, (state) => states.push(state));

    await reloadLocale(loader, 'en');
    assert.equal(requested[0], 'en');

    if (kind === 'legacy' || kind === 'locale-404') {
      assert.deepEqual(states.at(-1)?.bundle, localeCorpus('ru'));
      assert.equal(states.at(-1)?.status, 'ready');
    } else {
      assert.equal(states.at(-1)?.bundle, null);
      assert.equal(states.at(-1)?.error,
        kind === 'endpoint-404' ? 'helpServerUpgradeRequired' : 'helpUnavailable');
    }

    assert.deepEqual(requested, kind === 'locale-404' || kind === 'fallback-failure'
      ? ['en', 'ru'] : ['en']);
    retry = true;
    await reloadLocale(loader, 'en');
    assert.deepEqual(states.at(-1)?.bundle, localeCorpus('en'));
  });
}

test('HELP-UI-L1: обратные ответы и отменённый EN отказ не запускают запасное чтение', async () => {
  const states: HelpLoadState[] = [];
  const old = deferred();
  const current = deferred();
  const requested: unknown[] = [];
  const loader = createHelpLoader((...args: unknown[]) => {
    requested.push(args[0]);

    return requested.length === 1 ? old.promise : current.promise;
  }, (state) => states.push(state));
  const left = reloadLocale(loader, 'en');
  const right = reloadLocale(loader, 'ru');

  current.resolve(localeCorpus('ru', '0.2.0', 'CURRENT'));
  await right;
  old.reject({ status: 404, data: { error: 'help_locale_unavailable' } });
  await left;
  assert.deepEqual(requested, ['en', 'ru']);
  assert.deepEqual(states.at(-1)?.bundle, localeCorpus('ru', '0.2.0', 'CURRENT'));
  loader.cancel();
  assert.equal(states.at(-1)?.bundle, null);
});

test('HELP-UI-L1: поздний запасной RU не заменяет новое EN поколение', async () => {
  const states: HelpLoadState[] = [];
  const fallback = deferred();
  const started = deferred();
  let calls = 0;
  const loader = createHelpLoader(async (...args: unknown[]) => {
    calls += 1;

    if (calls === 1) {
      throw { status: 404, data: { error: 'help_locale_unavailable' } };
    }
    if (args[0] === 'ru') {
      started.resolve(true);

      return fallback.promise;
    }

    return localeCorpus('en', '0.2.0', 'CURRENT');
  }, (state) => states.push(state));
  const old = reloadLocale(loader, 'en');

  // Микрозадачи запускают fallback; база вместо него заканчивает основную попытку ошибкой.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 2, 'Отказ недоступной локали запускает ровно один fallback');
  await started.promise;
  await reloadLocale(loader, 'en');
  fallback.resolve(localeCorpus('ru'));
  await old;
  assert.deepEqual(states.at(-1)?.bundle, localeCorpus('en', '0.2.0', 'CURRENT'));
});

test('HELP-UI-L1: cancel до EN отказа запрещает даже начало fallback', async () => {
  const pending = deferred();
  const requested: unknown[] = [];
  const states: HelpLoadState[] = [];
  const loader = createHelpLoader((...args: unknown[]) => {
    requested.push(args[0]);

    return pending.promise;
  }, (state) => states.push(state));
  const attempt = reloadLocale(loader, 'en');

  loader.cancel();
  pending.reject({ status: 404, data: { error: 'help_locale_unavailable' } });
  await attempt;
  assert.deepEqual(requested, ['en']);
  assert.equal(states.at(-1)?.bundle, null);
  assert.equal(states.at(-1)?.status, 'loading');
});

test('HELP-UI-L1: ru→en→ru отбрасывает оба старых success с чужой identity', async () => {
  const queue = [deferred(), deferred(), deferred()];
  const states: HelpLoadState[] = [];
  let index = 0;
  const requested: unknown[] = [];
  const loader = createHelpLoader((...args: unknown[]) => {
    requested.push(args[0]);

    return queue[index++]!.promise;
  }, (state) => states.push(state));
  const oldRu = reloadLocale(loader, 'ru');
  const oldEn = reloadLocale(loader, 'en');
  const current = reloadLocale(loader, 'ru');

  queue[2]!.resolve(localeCorpus('ru', '0.2.0', 'CURRENT'));
  await current;
  queue[1]!.resolve(localeCorpus('en', '0.1.0', 'OLD-EN'));
  await oldEn;
  queue[0]!.resolve(localeCorpus('ru', '0.1.0', 'OLD-RU'));
  await oldRu;
  assert.deepEqual(requested, ['ru', 'en', 'ru']);
  assert.deepEqual(states.at(-1)?.bundle, localeCorpus('ru', '0.2.0', 'CURRENT'));
});

test('HELP-UI-L1: EN ответ на RU запрос является ошибкой без fallback', async () => {
  const states: HelpLoadState[] = [];
  const requested: unknown[] = [];
  const loader = createHelpLoader(async (...args: unknown[]) => {
    requested.push(args[0]);

    return localeCorpus('en');
  }, (state) => states.push(state));

  await reloadLocale(loader, 'ru');
  assert.deepEqual(requested, ['ru']);
  assert.equal(states.at(-1)?.error, 'helpUnavailable');
  assert.equal(states.at(-1)?.bundle, null);
});
