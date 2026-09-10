// Настройка «чем отвечает компаньон»: форма значения, хранение в prefs и выдача клиенту.
// Модель резолвит браузер перед ходом, поэтому настройка обязана доехать до него тем же
// путём, что порог сжатия — вместе с историей чатов.
import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { COMPANION_DEFAULTS, normalizeCompanionSettings } from '../../server/src/lib/companionSettings.ts';
import { PrefsStore } from '../../server/src/lib/prefsStore.ts';
import chatModule from '../../server/src/modules/chat/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const CTRL = String.fromCharCode(10); // перевод строки — самый частый «невидимый» гость

test('COMP-RUN-01: полная пара сохраняется, регистр и пробелы нормализуются', () => {
  assert.deepEqual(
    normalizeCompanionSettings({ modelRef: { provider: ' CLAUDE ', model: '  claude-opus-5  ' }, effort: 'HIGH' }),
    { modelRef: { provider: 'claude', model: 'claude-opus-5' }, effort: 'high' },
  );
  // id локальной модели сам бывает со слэшами и двоеточиями — резать его нельзя.
  assert.deepEqual(
    normalizeCompanionSettings({ modelRef: { provider: 'ollama', model: 'hf.co/user/repo:tag' } }),
    { modelRef: { provider: 'ollama', model: 'hf.co/user/repo:tag' }, effort: '' },
  );
});

test('COMP-RUN-02: полупустая ссылка и усилие без модели дают дефолт реестра', () => {
  // Огрызок в настройках обещал бы выбор, которого нет: ход всё равно уйдёт дефолтом.
  assert.deepEqual(normalizeCompanionSettings({ modelRef: { provider: 'claude' }, effort: 'high' }), COMPANION_DEFAULTS);
  assert.deepEqual(normalizeCompanionSettings({ modelRef: { model: 'claude-opus-5' } }), COMPANION_DEFAULTS);
  assert.deepEqual(normalizeCompanionSettings({ effort: 'high' }), COMPANION_DEFAULTS);
  assert.deepEqual(normalizeCompanionSettings(null), COMPANION_DEFAULTS);
  assert.deepEqual(normalizeCompanionSettings({ modelRef: 'claude:opus' }), COMPANION_DEFAULTS);
});

test('COMP-RUN-03: значение уезжает в аргументы CLI — управляющие символы и переростки отвергаются', () => {
  assert.deepEqual(
    normalizeCompanionSettings({ modelRef: { provider: 'claude', model: `opus${CTRL}5` } }),
    COMPANION_DEFAULTS,
  );
  assert.deepEqual(
    normalizeCompanionSettings({ modelRef: { provider: 'cl aude', model: 'opus' } }),
    COMPANION_DEFAULTS,
  );
  assert.deepEqual(
    normalizeCompanionSettings({ modelRef: { provider: 'claude', model: 'x'.repeat(201) } }),
    COMPANION_DEFAULTS,
  );
  // Модель осталась, а испорченный уровень снят: ход уйдёт на умолчании исполнителя.
  assert.deepEqual(
    normalizeCompanionSettings({ modelRef: { provider: 'claude', model: 'opus' }, effort: `high${CTRL}` }),
    { modelRef: { provider: 'claude', model: 'opus' }, effort: '' },
  );
});

test('COMP-RUN-04: prefs хранит нормализованное и чинит испорченный файл', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-companion-prefs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const prefsPath = path.join(root, 'prefs.json');
  const prefs = new PrefsStore({ prefsPath });

  assert.deepEqual(prefs.read().companion, COMPANION_DEFAULTS);

  prefs.write({ companion: { modelRef: { provider: 'Codex', model: 'gpt-5.6' }, effort: 'xhigh', junk: 1 } });
  const stored = JSON.parse(await fs.readFile(prefsPath, 'utf8'));
  // На диск уходит ровно контракт: чужие поля значения не хранятся.
  assert.deepEqual(stored.companion, { modelRef: { provider: 'codex', model: 'gpt-5.6' }, effort: 'xhigh' });
  assert.deepEqual(prefs.read().companion, stored.companion);

  // Правка соседней настройки не должна ронять уже сохранённый выбор.
  prefs.write({ chatAutoCompactWindow: 150000 });
  assert.deepEqual(prefs.read().companion, stored.companion);

  // Битый файл не роняет старт кокпита: значение мягко возвращается к дефолту.
  await fs.writeFile(prefsPath, JSON.stringify({ companion: { modelRef: 42 } }), 'utf8');
  assert.deepEqual(prefs.read().companion, COMPANION_DEFAULTS);
});

test('COMP-RUN-05: GET /api/chat/store отдаёт настройку вместе с историей', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-companion-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast() {} });
  await app.register(chatModule, {
    config: {
      chatsDir: path.join(root, 'chats'),
      chatStoreLegacyPath: path.join(root, 'legacy.json'),
      chatBindingsDir: path.join(root, 'bindings'),
      rootDir: root,
      factoryHome: root,
      port: 18140,
    },
    prefs: {
      read() {
        return {
          speech: {},
          trustedDirectories: [],
          providerSettings: {},
          chatAutoCompactWindow: 0,
          // Сервер отдаёт клиенту нормализованное значение, даже если в файле лежит мусор
          // (например, после ручной правки prefs.json).
          companion: { modelRef: { provider: 'claude', model: 'claude-opus-5' }, effort: 'high', junk: true },
        };
      },
    },
    modelsRegistry: async () => ({}),
    executorResolver: async () => null,
    taskExists: async () => false,
  });
  await app.ready();
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/api/chat/store' });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().companion, {
    modelRef: { provider: 'claude', model: 'claude-opus-5' },
    effort: 'high',
  });
});
