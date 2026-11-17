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

import { createFakeShowcaseVoice } from './helpers/showcaseVoice.js';

import { createShowcaseService } from '../../server/src/lib/showcase/service.ts';

/**
 * Служба на профиле без входа и с явным «браузером» — существующим файлом node.
 * Так пункт браузера готов, а установка ему не предлагается.
 */
async function fixture(t, { browserPath = process.execPath, unused = undefined } = {}) {
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

  const voice = await createFakeShowcaseVoice(root, { ready: ['qwen-studio'] });
  const service = createShowcaseService({
    ...voice,
    showcaseDir: path.join(root, 'showcase'),
    authDir: path.join(root, 'auth'),
    profilesDir: path.join(root, 'profiles'),
    stateDir: path.join(root, 'state'),
    browserPath,
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

test('готовность показывает пакеты voice и облака Qwen без кнопки', async (t) => {
  const service = await fixture(t);
  const status = await service.setupStatus();
  const piper = status.items.find((item) => item.id === 'voice:piper-irina');
  const silero = status.items.find((item) => item.id === 'voice:silero-v5_5_ru');
  const studio = status.items.find((item) => item.id === 'qwen-studio');
  const token = status.items.find((item) => item.id === 'qwen-token');

  assert.ok(piper && silero && studio && token);
  assert.equal(piper.action.label, 'Установить');
  assert.match(piper.action.hint, /МБ/u);
  assert.equal(studio.action, null);
  assert.equal(token.action, null);
  assert.equal(status.items.some((item) => item.id === 'edge' || item.id === 'yandex'), false);
  assert.equal(status.items.some((item) => item.id.startsWith('voice:qwen')), false);
});

test('каталог голосов содержит только движки пакета voice', async (t) => {
  const service = await fixture(t);
  const catalog = await service.voiceCatalog();

  assert.deepEqual(
    catalog.engines.map((engine) => engine.id).sort(),
    ['piper', 'qwen-studio', 'qwen-token', 'silero'],
  );
  assert.deepEqual(
    catalog.install.available.map((pack) => pack.id).sort(),
    ['piper-irina', 'silero-v5_5_ru'],
  );
});
