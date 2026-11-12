import assert from 'node:assert/strict';
import { access, readFile, rm } from 'node:fs/promises';
import test from 'node:test';

import { resolveQwenSnapshot } from '../../server/src/lib/qwen/discovery.ts';
import { readQwenSnapshot } from '../../server/src/lib/qwen/settings.ts';
import { QWEN_KEY, qwenAdapter, qwenFixture } from '../helpers/qwenFixture.mjs';

/**
 * Удаление исходного settings повторяет чистую установку, а не подготовленный конфиг.
 * Каждый запрос каталога подменён; реальные ключи и внешние сервисы не используются.
 */
async function cleanInstall(t) {
  const fixture = await qwenFixture(t, { settings: {} });

  await rm(fixture.file);
  delete process.env.GRIGDESK_QWEN_SERVICE;

  return fixture;
}

test('qwen-clean-install-and-reinstall-discover-live-models-without-source-settings', async (t) => {
  const fixture = await cleanInstall(t);
  const adapter = await qwenAdapter();
  const requests = [];
  const data = [{
    id: 'new-coder',
    name: 'Новая модель',
    apiKey: 'ignored-inline-key',
  }];
  const fetch = async (url, init) => {
    requests.push({ url, init });

    return Response.json({ data });
  };
  const first = await adapter.catalog(fixture.config, { fetch });

  assert.deepEqual(first.map((entry) => entry.id), ['new-coder(openai)']);
  assert.equal(first[0].name, 'Новая модель');
  assert.equal(requests[0].url, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models');
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${QWEN_KEY}`);
  assert.equal(requests[0].init.redirect, 'error');
  await assert.rejects(access(fixture.file), { code: 'ENOENT' });

  const snapshot = await resolveQwenSnapshot(fixture.config, {
    fetch: async () => assert.fail('Ход использует уже полученный каталог'),
  });

  assert.equal(snapshot.settings.modelProviders.openai[0].envKey, 'DASHSCOPE_API_KEY');
  assert.equal(JSON.stringify(snapshot).includes(QWEN_KEY), false);
  assert.equal(JSON.stringify(snapshot).includes('ignored-inline-key'), false);
  assert.equal(adapter.auth(fixture.config).available, true);

  await rm(fixture.bin);
  await fixture.fake({ version: '0.27.3' });
  data.push({ id: 'appeared-after-install' });

  const afterReinstall = await adapter.catalog(fixture.config, { fetch });

  assert.equal((await adapter.probe(fixture.config)).ok, true);
  assert.deepEqual(afterReinstall.map((entry) => entry.id),
    ['new-coder(openai)', 'appeared-after-install(openai)']);
  assert.equal(requests.length, 2, 'Обновление каталога не застревает в прежней копии');
  await assert.rejects(access(fixture.file), { code: 'ENOENT' });
  assert.equal(await readFile(fixture.config.modelsPath, 'utf8'), 'sentinel-owner-registry');
});

test('qwen-service-and-key-isolate-discovery-and-auth-requires-secret', async (t) => {
  const fixture = await cleanInstall(t);
  const adapter = await qwenAdapter();
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);

    return Response.json({ data: [{ id: `model-${urls.length}` }] });
  };

  const before = await resolveQwenSnapshot(fixture.config, { fetch });

  process.env.GRIGDESK_QWEN_SERVICE = 'qwencloud-intl';

  const changed = await resolveQwenSnapshot(fixture.config, { fetch });

  assert.notEqual(changed.fingerprint, before.fingerprint);
  assert.match(urls[1], /^https:\/\/ap-southeast-1\.maas\.qwencloudapi\.com\//);
  assert.equal(changed.models[0].entry.id, 'model-2');
  process.env.DASHSCOPE_API_KEY = 'another-synthetic-account';

  const another = await resolveQwenSnapshot(fixture.config, { fetch });

  assert.notEqual(another.fingerprint, changed.fingerprint);
  assert.equal(another.models[0].entry.id, 'model-3');
  delete process.env.DASHSCOPE_API_KEY;
  assert.equal(adapter.auth(fixture.config).available, false, 'Сервис без ключа не даёт готовность');
  assert.equal((await resolveQwenSnapshot(fixture.config, { fetch })).models.length, 0);
  assert.equal(urls.length, 3, 'Отсутствующий ключ не отправляется в сеть');
});

/**
 * Individual Plan QwenCloud использует собственный endpoint, а не Alibaba Coding Plan.
 * Полный ответ API проходит native-подтверждение без общего семейства для разных моделей.
 */
test('qwencloud-token-plan-preserves-qwen4-and-full-live-model-list', async (t) => {
  const fixture = await cleanInstall(t);
  const adapter = await qwenAdapter();
  const ids = ['qwen4-max-preview', 'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus', 'auto'];
  const urls = [];

  process.env.GRIGDESK_QWEN_SERVICE = 'qwencloud-token';

  const models = await adapter.catalog(fixture.config, {
    fetch: async (url) => {
      urls.push(url);

      return Response.json({ data: ids.map((id) => ({ id })) });
    },
  });

  assert.deepEqual(urls, ['https://token-plan.maas.qwencloudapi.com/compatible-mode/v1/models']);
  assert.deepEqual(models.map((model) => model.id), ids.map((id) => `${id}(openai)`));
  assert.ok(models.every((model) => !model.family));
  assert.equal(adapter.auth(fixture.config).available, true);
});

test('qwen-discovery-refusal-is-visible-and-never-switches-service', async (t) => {
  const fixture = await cleanInstall(t);
  const adapter = await qwenAdapter();
  let calls = 0;

  await assert.rejects(resolveQwenSnapshot(fixture.config, {
    fetch: async () => {
      calls += 1;

      return new Response(QWEN_KEY, { status: 401 });
    },
  }), /HTTP 401/);
  assert.equal(calls, 1);
  assert.equal(adapter.auth(fixture.config).available, false);
  assert.match(adapter.auth(fixture.config).label, /HTTP 401/);
  assert.equal(adapter.auth(fixture.config).label.includes(QWEN_KEY), false);

  await resolveQwenSnapshot(fixture.config, {
    refresh: true,
    fetch: async () => Response.json({ data: [{ id: 'recovered' }] }),
  });
  assert.equal(adapter.auth(fixture.config).available, true);
  process.env.GRIGDESK_QWEN_SERVICE = 'unknown-service';
  await assert.rejects(resolveQwenSnapshot(fixture.config, {
    fetch: async () => assert.fail('Неизвестный сервис не получает ключ'),
  }), /выберите сервис/);
});

test('qwen-discovery-validates-data-and-cancels-without-exposing-fetch-errors', async (t) => {
  const fixture = await cleanInstall(t);

  for (const body of [{}, { data: [] }, { data: [{ id: 'bad\nmodel' }] }]) {
    await assert.rejects(resolveQwenSnapshot(fixture.config, {
      refresh: true,
      fetch: async () => Response.json(body),
    }), /каталог|модели чата/);
  }

  await assert.rejects(resolveQwenSnapshot(fixture.config, {
    refresh: true,
    fetch: async () => {
      throw new Error(`untrusted HTTP diagnostic ${QWEN_KEY}`);
    },
  }), (error) => !error.message.includes(QWEN_KEY) && /проверьте сервис/.test(error.message));

  const controller = new AbortController();

  controller.abort();
  await assert.rejects(resolveQwenSnapshot(fixture.config, {
    signal: controller.signal,
    fetch: async () => assert.fail('Отменённое чтение не запускается'),
  }), { name: 'AbortError' });
});

test('qwen-discovery-preserves-existing-provider-config-and-does-not-commit-stale-account', async (t) => {
  const fixture = await qwenFixture(t);
  const original = await readFile(fixture.file, 'utf8');
  const configured = await resolveQwenSnapshot(fixture.config, {
    fetch: async () => assert.fail('Явная конфигурация имеет приоритет'),
  });

  assert.equal(configured.automatic, false);
  assert.equal(configured.models.length, 2);
  assert.equal(await readFile(fixture.file, 'utf8'), original);
  await fixture.writeSettings({ modelProviders: {} });
  assert.equal((await resolveQwenSnapshot(fixture.config)).models.length, 0);
  await rm(fixture.file);

  const initial = readQwenSnapshot(fixture.config).fingerprint;

  await assert.rejects(resolveQwenSnapshot(fixture.config, {
    fetch: async () => {
      process.env.DASHSCOPE_API_KEY = 'changed-during-discovery';

      return Response.json({ data: [{ id: 'previous-account-model' }] });
    },
  }), /настройки доступа изменились/);
  assert.notEqual(readQwenSnapshot(fixture.config).fingerprint, initial);
});
