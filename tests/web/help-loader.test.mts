import assert from 'node:assert/strict';
import test from 'node:test';
import { createHelpLoader } from '../../web/src/shared/helpLoader.ts';
import type { HelpLoadState } from '../../web/src/shared/helpLoader.ts';
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
