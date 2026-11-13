import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { latestScript } from '../../server/scripts/help/buildHelpSite.mts';

/**
 * Настоящий опубликованный скрипт получает управляемый HTTP-ответ и location.
 * Проверяется результат перехода и ошибки, а не наличие строки channel.json в исходнике.
 */
async function runLatest(response: unknown, fail = false, pathname = '/help/latest.html', search = '') {
  let redirected = '';
  const message = { textContent: '' };
  const requests: Array<{ url: string; credentials: unknown }> = [];
  const completion = runInNewContext(latestScript, {
    navigator: { language: 'ru' },
    document: { getElementById: () => message },
    AbortSignal,
    location: {
      pathname,
      search,
      hash: '#/help/chats',
      replace: (url: string) => {
        redirected = url;
      }
    },
    fetch: async (url: string, options: { credentials: unknown }) => {
      requests.push({ url, credentials: options.credentials });

      if (fail) {
        throw new Error('offline');
      }

      return Response.json(response);
    },
  }, { timeout: 1000 });

  await completion;

  return {
    redirected,
    message: message.textContent,
    requests
  };
}

test('HELP-L1: latest следует версии канала и сохраняет статью без cookies', async () => {
  for (const [channel, version, pathname] of [
    ['release', '0.2.0', '/help/latest.html'],
    ['dev', '0.2.0-dev.2', '/help/latest-dev.html'],
  ]) {
    const result = await runLatest({
      format: 2,
      channel,
      latest: { payload: { version } },
    }, false, pathname);

    assert.equal(result.redirected, `./${version}/index.html#/help/chats`);
    assert.deepEqual(result.requests, [{
      url: `../api/releases/v1/${channel}.json`,
      credentials: 'omit',
    }]);
  }
});

test('HELP-L3: latest сохраняет явно выбранный язык вместе со статьёй', async () => {
  const result = await runLatest({
    format: 2,
    channel: 'release',
    latest: { payload: { version: '0.2.0' } },
  }, false, '/help/latest.html', '?lang=en');

  assert.equal(result.redirected, './0.2.0/index.html?lang=en#/help/chats');
});

test('HELP-L2: отсутствующий/невалидный канал и сеть показывают ошибку без перехода', async () => {
  for (const response of [{ format: 1, latest: null }, { format: 1, latest: { version: '../../secret' } },
  { format: 2, latest: { version: '0.2.0' } }]) {
    const result = await runLatest(response);

    assert.equal(result.redirected, '');
    assert.match(result.message, /Не удалось открыть/u);
  }

  assert.equal((await runLatest({}, true)).redirected, '');
});
