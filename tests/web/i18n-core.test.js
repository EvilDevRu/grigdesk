import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../shared/i18n/', import.meta.url);
const messages = {
  ru: {
    tasks: { 
      one: '{count} задача', 
      few: '{count} задачи', 
      many: '{count} задач', 
      other: '{count} задачи' 
    },
    fallback: 'Русская подпись {name}',
    greeting: 'Привет, {name}',
  },
  en: {
    tasks: { one: '{count} task', other: '{count} tasks' },
    greeting: 'Hello, {name}',
  },
};
const locales = [
  { 
    id: 'ru', 
    name: 'Русский', 
    intlLocale: 'ru-RU' 
  },
  { 
    id: 'en', 
    name: 'English', 
    intlLocale: 'en-US' 
  },
];

/**
 * Отсутствие нового модуля — ожидаемый RED реализации, а не ошибка загрузки всего файла.
 * После появления ядра каждый сценарий выполняет проверки результата перевода.
 */
async function core() {
  const exists = await access(new URL('core.ts', root)).then(() => true, () => false);

  assert.equal(exists, true, 'К1/К7/К8: общего переводчика пока нет');

  return import(new URL('core.ts', root));
}

test('I18N-01: русская система, прочие системы и приоритет явного выбора', async () => {
  const { resolveLocale } = await core();

  for (const language of ['ru', 'RU', 'ru-KZ', 'ru-RU']) {
    assert.equal(resolveLocale('system', language), 'ru');
    assert.equal(resolveLocale('en', language), 'en');
  }

  for (const language of ['en', 'en-GB', 'de-DE', '', undefined]) {
    assert.equal(resolveLocale('system', language), 'en');
    assert.equal(resolveLocale('ru', language), 'ru');
  }

  assert.equal(resolveLocale('invalid', 'ru-KZ'), 'ru');
  assert.equal(resolveLocale(undefined, 'de-DE'), 'en');
});

test('I18N-02: plural, даты, relative, числа и пороги размеров по правилам Intl', async () => {
  const { createTranslator } = await core();
  const { formatDate, formatRelativeTime, formatNumber, formatBytes } = await import(
    new URL('formats.ts', root));
  const translator = createTranslator({ locales, messages });
  const counts = [0, 1, 2, 5, 11, 21, 1.5];
  const ru = ['0 задач', '1 задача', '2 задачи', '5 задач', '11 задач', '21 задача', '1,5 задачи'];

  for (const [index, count] of counts.entries()) {
    assert.equal(translator.t('ru', 'tasks', { count }), ru[index]);
    assert.equal(translator.t('en', 'tasks', { count }), `${count} ${count === 1 ? 'task' : 'tasks'}`);
  }

  const date = new Date('2026-04-05T12:34:56Z');
  const options = { 
    timeZone: 'UTC', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  };

  for (const [id, locale] of [['ru', 'ru-RU'], ['en', 'en-US']]) {
    assert.equal(formatDate(date, id, options), new Intl.DateTimeFormat(locale, options).format(date));
    assert.equal(formatRelativeTime(-5, 'minute', id),
      new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-5, 'minute'));
    assert.equal(formatNumber(12345.5, id), new Intl.NumberFormat(locale).format(12345.5));
    assert.match(formatBytes(1024, id), /1/);
    assert.equal(formatBytes(1536, id), id === 'ru' ? '2 КБ' : '2 KB');
    assert.notEqual(formatBytes(1024, id), formatBytes(1024 ** 2, id));
    assert.match(formatBytes(1024 ** 2, id), id === 'ru' ? /МБ/ : /MB/);
    assert.equal(formatBytes(NaN, id), '');
  }

  assert.equal(formatNumber(12345.5), formatNumber(12345.5, 'ru'));
  assert.equal(formatBytes(1536), formatBytes(1536, 'ru'));
});

test('I18N-03: RU fallback, явная подпись неизвестного ключа и неизменяемый raw/ref', async () => {
  const { createTranslator, messageRef } = await core();
  const translator = createTranslator({ locales, messages });

  assert.equal(translator.t('en', 'fallback', { name: 'Alpha' }), 'Русская подпись Alpha');
  assert.equal(translator.t('en', 'unknown.key', {}, 'Неизвестный раздел'), 'Неизвестный раздел');

  for (const raw of ['greeting', 'Ошибка сервера', 'Ответ агента: {name}', '<b>данные</b>']) {
    assert.equal(translator.resolveText(raw, 'en'), raw);
  }

  const params = { name: 'Alpha' };
  const ref = messageRef('greeting', params);

  params.name = 'изменено вызывающим';
  assert.equal(translator.resolveText(ref, 'ru'), 'Привет, Alpha');
  assert.equal(translator.resolveText(ref, 'en'), 'Hello, Alpha');
});

test('I18N-03: общие JSON-каталоги RU/EN зарегистрированы и не содержат HTML', async () => {
  await core();

  const registry = JSON.parse(await readFile(new URL('assets/locales/catalog.json', root), 'utf8'));

  assert.match(JSON.stringify(registry), /ru-RU/);
  assert.match(JSON.stringify(registry), /en-US/);

  for (const id of ['ru', 'en']) {
    for (const area of ['core', 'settings', 'desktop', 'native']) {
      const text = await readFile(new URL(`assets/locales/${id}/${area}.json`, root), 'utf8');

      assert.ok(Object.keys(JSON.parse(text)).length > 0, `${id}/${area}`);
      assert.doesNotMatch(text, /<\/?(?:script|div|span|button|html)\b/i);
    }
  }
});
