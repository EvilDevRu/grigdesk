import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { BUILTIN_DRIVER_SOURCES } from '../../server/src/lib/trackers/driverSources.ts';
import { trackerFixture } from './helpers/trackerFixture.js';

const endpoint = '/api/trackers/sources';
const b24Url = 'https://github.com/EvilDevRu/grigdesk-b24';
const jiraUrl = 'https://github.com/EvilDevRu/grigdesk-jira';
const localSource = { title: 'Локальный трекер', url: 'http://git.fixture/tracker' };
const sourceWarnings = (fixture) => fixture.logs.filter((line) =>
  line.includes('локальные источники проигнорированы'));

test('DRIVER-SOURCES-01: общий auth guard и обе встроенные записи без подготовки репозиториев', async (t) => {
  const fixture = await trackerFixture(t);
  const before = fixture.runtime.catalog();

  assert.equal((await fixture.app.inject(endpoint)).statusCode, 401);

  for (const headers of [fixture.headers, {
    'x-grigdesk-token': 'tracker-test-cli',
  }, {
    'x-grigdesk-internal': 'tracker-test-internal',
  }]) {
    const response = await fixture.app.inject({ url: endpoint, headers });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { sources: [
      { title: 'Битрикс24', url: b24Url },
      { title: 'Jira', url: jiraUrl },
    ] });
  }

  assert.deepEqual(fixture.runtime.catalog(), before);
  assert.equal(sourceWarnings(fixture).length, 0);
});

test('DRIVER-SOURCES-02: локальный title заменяет встроенный по URL, новые записи добавляются', async (t) => {
  const fixture = await trackerFixture(t);
  const local = [{ title: 'Мой Б24', url: b24Url }, localSource];
  const contents = JSON.stringify(local);

  await writeFile(fixture.config.driverSourcesPath, contents);

  const response = await fixture.request('GET', endpoint);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { sources: [
    local[0],
    { title: 'Jira', url: jiraUrl },
    localSource,
  ] });
  assert.equal(sourceWarnings(fixture).length, 0);
  assert.equal(await readFile(fixture.config.driverSourcesPath, 'utf8'), contents);
  assert.equal(BUILTIN_DRIVER_SOURCES[0].title, 'Битрикс24');

  await writeFile(fixture.config.driverSourcesPath, '[]');

  assert.deepEqual((await fixture.request('GET', endpoint)).json(), { sources: BUILTIN_DRIVER_SOURCES });
});

for (const [name, contents] of [
  ['битый JSON', '['],
  ['объект вместо массива', '{}'],
  ['null вместо записи', JSON.stringify([localSource, null])],
  ['нет title', JSON.stringify([localSource, { url: 'https://git.fixture/another' }])],
  ['пустой title', JSON.stringify([{ title: '  ', url: b24Url }])],
  ['нестроковый title', JSON.stringify([{ title: 24, url: b24Url }])],
  ['пустой url', JSON.stringify([{ title: 'Пустой', url: ' ' }])],
  ['нестроковый url', JSON.stringify([{ title: 'Адрес', url: 24 }])],
  ['относительный url', JSON.stringify([{ title: 'Адрес', url: '/tracker' }])],
  ['не HTTP(S)', JSON.stringify([{ title: 'Адрес', url: 'file:///tracker.git' }])],
  ['дубликаты url', JSON.stringify([localSource, { title: 'Повтор', url: localSource.url }])],
]) {
  test(`DRIVER-SOURCES-03: ${name} игнорирует всю надстройку с warn`, async (t) => {
    const fixture = await trackerFixture(t);

    await writeFile(fixture.config.driverSourcesPath, contents);

    const response = await fixture.request('GET', endpoint);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { sources: BUILTIN_DRIVER_SOURCES });
    assert.equal(sourceWarnings(fixture).length, 1);
    assert.equal(await readFile(fixture.config.driverSourcesPath, 'utf8'), contents);
  });
}

test('DRIVER-SOURCES-03: отказ чтения оставляет встроенные источники и warn', async (t) => {
  const fixture = await trackerFixture(t);

  await mkdir(fixture.config.driverSourcesPath);

  const response = await fixture.request('GET', endpoint);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { sources: BUILTIN_DRIVER_SOURCES });
  assert.equal(sourceWarnings(fixture).length, 1);
});
