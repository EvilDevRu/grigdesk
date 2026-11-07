import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserAddress,
  browserUrl,
  normalizeBrowserPreferences,
} from '../../shared/browser/browserContract.ts';

test('BR01: defaults, независимые настройки и канонический HTTP(S)', () => {
  assert.deepEqual(normalizeBrowserPreferences(null), {
    open: 'external',
    external: 'system',
    agents: false,
    search: 'yandex',
  });
  assert.deepEqual(normalizeBrowserPreferences({
    open: 'internal',
    external: 'app:firefox',
    agents: true,
    search: 'yandex',
  }), {
    open: 'internal',
    external: 'app:firefox',
    agents: true,
    search: 'yandex',
  });
  assert.equal(browserUrl('http://[::1]:5191/a#b'), 'http://[::1]:5191/a#b');

  for (const value of ['javascript:1', 'file:///tmp/a', 'https://u:p@a.test', '//a.test', 'x\n']) {
    assert.throws(() => browserUrl(value));
  }
});

test('BR02: адреса без схемы, loopback, IDN и поиск в выбранной системе', () => {
  const addresses = new Map([
    ['ya.ru', 'https://ya.ru/'],
    ['example.com/path?q=one#two', 'https://example.com/path?q=one#two'],
    ['пример.рф', 'https://xn--e1afmkfd.xn--p1ai/'],
    ['localhost:3000/form', 'http://localhost:3000/form'],
    ['127.0.0.1:5173', 'http://127.0.0.1:5173/'],
    ['[::1]:8080', 'http://[::1]:8080/'],
    ['https://example.com', 'https://example.com/'],
  ]);

  for (const [input, expected] of addresses) {
    assert.equal(browserAddress(`  ${input}  `, 'google'), expected);
  }

  for (const engine of ['yandex', 'google'] as const) {
    const url = new URL(browserAddress('погода & новости + сегодня', engine));

    assert.equal(url.origin, engine === 'google' ? 'https://www.google.com' : 'https://yandex.ru');
    assert.equal(url.searchParams.get(engine === 'google' ? 'q' : 'text'), 'погода & новости + сегодня');
  }

  assert.equal(new URL(browserAddress('кот', 'yandex')).searchParams.get('text'), 'кот');

  for (const value of ['', 'javascript:alert(1)', 'file:///etc/passwd', 'https://u:p@a.test',
    'u:p@a.test', '//a.test', 'line\nquery']) {
    assert.throws(() => browserAddress(value, 'google'), value);
  }

  assert.equal(normalizeBrowserPreferences({ search: 'google' }).search, 'google');
  assert.equal(normalizeBrowserPreferences({ search: 'unknown' }).search, 'yandex');
});
