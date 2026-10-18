// Готовность плагина для его настроек: состав пунктов и кнопки.
//
// Проверяется форма, а не скачивание: у требования, которое раздел умеет поставить
// сам, есть кнопка; у системного пакета и ключа — только слова о том, где взять;
// неизвестный пункт кнопкой не ставится и ничего не запускает.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createShowcaseService } from '../../server/src/lib/showcase/service.ts';

/**
 * Служба на профиле без входа и с явным «браузером» — существующим файлом node.
 * Так пункт браузера готов, а установка ему не предлагается.
 */
async function fixture(t, { browserPath = process.execPath, edgeVoice = undefined } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-setup-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const contractDir = path.join(root, 'profiles', 'demo-profile', 'showcase');

  await mkdir(contractDir, { recursive: true });
  await mkdir(path.join(root, 'state'), { recursive: true });
  await writeFile(path.join(contractDir, 'target.json'), JSON.stringify({
    version: 1,
    environment: 'read-only',
    project: { record: 'http://127.0.0.1:5173', view: 'http://127.0.0.1:5173' },
    sandbox: null,
    allowedOrigins: [],
    capabilities: ['record'],
  }), 'utf8');
  await writeFile(path.join(contractDir, 'screens.json'), JSON.stringify({
    version: 1,
    screens: [{ id: 'overview', title: 'Обзор', path: '/', readySelector: 'body', elements: [] }],
  }), 'utf8');

  const service = createShowcaseService({
    showcaseDir: path.join(root, 'showcase'),
    authDir: path.join(root, 'auth'),
    profilesDir: path.join(root, 'profiles'),
    stateDir: path.join(root, 'state'),
    browserPath,
    voiceDir: path.join(root, 'voice'),
    edgeVoice,
    listProjects: async () => ['demo-profile'],
    broadcast: () => {},
    limits: () => ({
      maxScenes: 20,
      maxSceneSeconds: 120,
      maxTotalSeconds: 600,
      retentionDays: 30,
      maxQueued: 4,
      jobTimeoutMs: 60_000,
    }),
  });

  await service.recover();

  return service;
}

function itemOf(status, id) {
  return status.items.find((item) => item.id === id);
}

test('пункты готовности: браузер, сборка видео, голоса, облако, речь, хранилище', async (t) => {
  const service = await fixture(t);
  const status = await service.setupStatus();
  const ids = status.items.map((item) => item.id);

  for (const expected of ['browser', 'media', 'yandex', 'speech', 'storage']) {
    assert.ok(ids.includes(expected), `нет пункта ${expected}`);
  }

  assert.ok(ids.some((id) => id.startsWith('voice:')), 'у каждого пакета голоса свой пункт');
  assert.match(status.checkedAt, /^\d{4}-/);

  const browser = itemOf(status, 'browser');

  assert.equal(browser.status, 'ready');
  assert.equal(browser.action, null, 'готовому браузеру установка не предлагается');

  const voice = status.items.find((item) => item.id.startsWith('voice:'));

  assert.equal(voice.status, 'blocked');
  assert.equal(voice.action.label, 'Установить');
  assert.match(voice.action.hint, /МБ|ГБ/, 'размер назван до нажатия');
  assert.equal(voice.job, null);

  // Qwen3-TTS ставится той же кнопкой, что и остальные: модель на гигабайты
  // называется гигабайтами, а не тысячами мегабайт.
  const qwen = itemOf(status, 'voice:qwen3-tts-1_7b');

  assert.ok(qwen, 'у Qwen3-TTS свой пункт готовности');
  assert.equal(qwen.status, 'blocked');
  assert.match(qwen.action.hint, /\d,\d ГБ/);
  assert.match(qwen.reason, /Apache/);

  const yandex = itemOf(status, 'yandex');

  assert.equal(yandex.status, 'blocked');
  assert.equal(yandex.action, null, 'ключ задаёт человек, кнопки у него нет');
  assert.match(yandex.reason, /GRIGDESK_SHOWCASE_YANDEX_API_KEY/);

  assert.equal(itemOf(status, 'media').action, null);
  assert.equal(itemOf(status, 'speech').action, null);
});

test('облако Microsoft без настройки не подключается, выключенное — видно с подсказкой', async (t) => {
  const silent = await fixture(t);

  assert.equal(itemOf(await silent.setupStatus(), 'edge'), undefined, 'без опции движка нет');

  const disabled = await fixture(t, { edgeVoice: { enabled: false } });
  const status = await disabled.setupStatus();
  const edge = itemOf(status, 'edge');
  const ids = status.items.map((item) => item.id);

  assert.equal(edge.status, 'blocked');
  assert.equal(edge.action, null, 'облако включают настройкой, кнопки у него нет');
  assert.match(edge.reason, /выключен/);
  assert.match(edge.reason, /GRIGDESK_SHOWCASE_EDGE_TTS/);
  assert.ok(ids.indexOf('edge') < ids.indexOf('yandex'), 'порядок облаков фиксированный');

  // Выключенный движок замыкает реестр голосов, а не занимает место по умолчанию.
  const catalog = await disabled.voiceCatalog();

  assert.equal(catalog.engines.at(-1).id, 'edge');
  assert.ok(catalog.engines.at(-1).voices.every((voice) => !voice.available));
});

test('без явного браузера пункт предлагает поставить Chromium', async (t) => {
  const service = await fixture(t, { browserPath: null });
  const browser = itemOf(await service.setupStatus(), 'browser');

  assert.equal(browser.status, 'blocked');
  assert.equal(browser.action.label, 'Установить Chromium');
  assert.match(browser.action.hint, /МБ/);
  assert.match(browser.reason, /настройках плагина/);
});

test('неизвестный пункт и чужой голос отвергаются до запуска чего-либо', async (t) => {
  const service = await fixture(t);

  await assert.rejects(
    () => service.runSetup('media'),
    (error) => error.code === 'unknown_setup' && error.status === 400,
  );
  await assert.rejects(
    () => service.runSetup('voice:чужой'),
    (error) => error.code === 'unknown_voice' && error.status === 400,
  );
  await assert.rejects(
    () => service.cancelSetup('speech'),
    (error) => error.code === 'unknown_setup',
  );
});
