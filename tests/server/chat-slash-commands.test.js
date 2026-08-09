// Слэш-команды исполнителей: контракт commands(), выдача в /api/providers и
// серверный признак служебного хода slashCommand (без титул-хука, без автоповторов,
// без инвалидации Kimi binding при пустом выводе).
// Тесты test-first по плану docs/plans/chat-model-slash-commands-plan.md (§3).
import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { ChatSessionBindingStore } from '../../server/src/lib/chat/session-binding-store.js';
import {
  KIMI_AUTH_PROFILE_ID,
  KIMI_SECURITY_PROFILE,
} from '../../server/src/lib/kimi/profile.js';
import { KIMI_RETRY_CONTRACT } from '../../server/src/lib/chat/retry-contract.js';
import chatModule from '../../server/src/modules/chat/index.js';
import providersModule from '../../server/src/modules/providers/index.js';
import kimiExecutor from '../../server/src/lib/executors/kimi.js';
import claudeExecutor from '../../server/src/lib/executors/claude.js';
import codexExecutor from '../../server/src/lib/executors/codex.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

// ── Контракт commands() ──────────────────────────────────────────────────────

function assertCommandsShape(list, providerId) {
  assert.ok(Array.isArray(list), `${providerId}: commands() обязан вернуть массив`);
  assert.ok(list.length > 0, `${providerId}: список команд не пуст`);
  for (const entry of list) {
    assert.match(entry.cmd, /^\/\S+$/, `${providerId}: cmd начинается с /`);
    assert.ok(['prompt', 'none'].includes(entry.run), `${providerId}: ${entry.cmd} run ∈ prompt|none`);
    assert.equal(typeof entry.desc, 'string', `${providerId}: ${entry.cmd} desc — строка`);
    assert.ok(entry.desc.trim().length > 0, `${providerId}: ${entry.cmd} desc непустой`);
    assert.ok(entry.desc.length <= 120, `${providerId}: ${entry.cmd} desc ≤ 120 символов`);
  }
}

test('shape commands() у kimi, claude и codex', async () => {
  // Скан пользовательских команд claude уводим в пустой fixture-HOME: набор
  // built-ins не должен зависеть от конфигурации машины, где гоняют тесты.
  const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), 'slash-shape-'));
  process.env.CLAUDE_CONFIG_DIR = emptyHome;
  try {
    for (const executor of [kimiExecutor, claudeExecutor, codexExecutor]) {
      assert.equal(typeof executor.commands, 'function', `${executor.id}: поле commands не объявлено`);
      assertCommandsShape(await executor.commands({}), executor.id);
    }
    // Codex exec не исполняет слэш-команды — весь список информационный.
    const codexList = await codexExecutor.commands({});
    assert.ok(codexList.every((c) => c.run === 'none' && c.hint), 'codex: все команды run=none с hint');
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test('claude сканирует пользовательские команды из $CLAUDE_CONFIG_DIR/commands', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-commands-'));
  const dir = path.join(home, 'commands');
  await fs.mkdir(path.join(dir, 'broken.md'), { recursive: true }); // каталог с .md — ошибка чтения
  await fs.writeFile(path.join(dir, 'alpha.md'), [
    '---',
    'description: Поставить задачу в B24',
    'argument-hint: "[создать]"',
    '---',
    '',
    '# Альфа',
    'Тело команды.',
  ].join('\n'));
  await fs.writeFile(path.join(dir, 'beta.md'), '# Бета-команда\n\nОписание ниже.\n');
  await fs.writeFile(path.join(dir, 'gamma.txt'), 'не markdown — игнорируем');
  const longDesc = `Очень длинное описание. ${'x'.repeat(200)}`;
  await fs.writeFile(path.join(dir, 'long.md'), `---\ndescription: ${longDesc}\n---\n`);

  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    const list = await claudeExecutor.commands({});
    const byCmd = new Map(list.map((c) => [c.cmd, c]));
    assert.equal(byCmd.get('/alpha')?.desc, 'Поставить задачу в B24');
    assert.equal(byCmd.get('/alpha')?.run, 'prompt');
    assert.equal(byCmd.get('/beta')?.desc, '# Бета-команда');
    assert.ok(!byCmd.has('/gamma'), 'не-md файлы не попадают в список');
    assert.ok(!byCmd.has('/broken'), 'нечитаемый файл пропускается, реестр не валится');
    assert.ok(byCmd.get('/long')?.desc.length <= 120, 'desc обрезается до 120 символов');
    // Built-ins на месте и идут раньше пользовательских.
    assert.ok(list.findIndex((c) => c.cmd === '/compact') < list.findIndex((c) => c.cmd === '/alpha'));
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test('claude без каталога команд возвращает только built-ins', async () => {
  process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), `no-such-dir-${Date.now()}`);
  try {
    const list = await claudeExecutor.commands({});
    assertCommandsShape(list, 'claude');
    assert.ok(list.some((c) => c.cmd === '/compact'));
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test('kimi сканирует пользовательские скиллы из <kimiHome>/skills', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kimi-skills-'));
  const dir = path.join(home, 'skills');
  await fs.mkdir(path.join(dir, 'pr-fixes'), { recursive: true });
  await fs.writeFile(path.join(dir, 'pr-fixes', 'SKILL.md'), [
    '---',
    'name: pr-fixes',
    'description: Цикл отработки замечаний ревью по открытым PR',
    'type: prompt',
    '---',
    '',
    '# Тело скилла',
  ].join('\n'));
  await fs.mkdir(path.join(dir, 'noname'), { recursive: true });
  await fs.writeFile(path.join(dir, 'noname', 'SKILL.md'), '# Без frontmatter\n');
  await fs.mkdir(path.join(dir, 'broken'), { recursive: true }); // без SKILL.md
  await fs.writeFile(path.join(dir, 'loose.md'), 'файл, а не каталог — игнорируем');
  const longDesc = `Очень длинное описание. ${'x'.repeat(200)}`;
  await fs.mkdir(path.join(dir, 'long'), { recursive: true });
  await fs.writeFile(path.join(dir, 'long', 'SKILL.md'), `---\ndescription: ${longDesc}\n---\n`);

  const list = await kimiExecutor.commands({ kimiLaunchMode: 'host', kimiHome: home });
  const byCmd = new Map(list.map((c) => [c.cmd, c]));
  assert.equal(byCmd.get('/pr-fixes')?.desc, 'Цикл отработки замечаний ревью по открытым PR');
  assert.equal(byCmd.get('/pr-fixes')?.run, 'prompt');
  assert.equal(byCmd.get('/noname')?.desc, 'Пользовательский скилл', 'без frontmatter — имя каталога и desc по умолчанию');
  assert.ok(!byCmd.has('/broken'), 'каталог без SKILL.md пропускается');
  assert.ok(!byCmd.has('/loose'), 'loose .md-файл не попадает в список');
  assert.ok(byCmd.get('/long')?.desc.length <= 120, 'desc обрезается до 120 символов');
  // Built-ins на месте и идут раньше скиллов.
  assert.ok(list.findIndex((c) => c.cmd === '/compact') < list.findIndex((c) => c.cmd === '/pr-fixes'));

  // Скилл с именем, совпадающим с built-in, не дублирует команду.
  await fs.mkdir(path.join(dir, 'status'), { recursive: true });
  await fs.writeFile(path.join(dir, 'status', 'SKILL.md'), '---\nname: status\n---\n');
  const deduped = await kimiExecutor.commands({ kimiLaunchMode: 'host', kimiHome: home });
  assert.equal(deduped.filter((c) => c.cmd === '/status').length, 1, 'built-in сильнее скилла');
});

test('kimi без каталога скиллов и в contained-режиме возвращает только built-ins', async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'kimi-skills-empty-'));
  const hostList = await kimiExecutor.commands({ kimiLaunchMode: 'host', kimiHome: empty });
  assertCommandsShape(hostList, 'kimi');
  assert.ok(hostList.some((c) => c.cmd === '/compact'));

  // contained хостовых скиллов не видит: читает kimiRuntimeHome, а не kimiHome.
  const hostHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kimi-skills-host-'));
  await fs.mkdir(path.join(hostHome, 'skills', 'pr-fixes'), { recursive: true });
  await fs.writeFile(path.join(hostHome, 'skills', 'pr-fixes', 'SKILL.md'), '---\nname: pr-fixes\n---\n');
  const contained = await kimiExecutor.commands({
    kimiLaunchMode: 'contained',
    kimiHome: hostHome,
    kimiRuntimeHome: empty,
  });
  assert.ok(!contained.some((c) => c.cmd === '/pr-fixes'), 'contained не видит скиллы kimiHome');
});

// ── /api/providers: выдача commands ──────────────────────────────────────────

function stubAdapter(id, commandsImpl) {
  return {
    id,
    name: `Fake ${id}`,
    vendor: 'Test',
    color: '#123456',
    order: 90,
    bin: () => '/bin/true',
    probe: async () => ({ ok: true, version: '1.0' }),
    auth: async () => ({ mode: 'cli', label: 'ok', available: true }),
    seedModels: () => [],
    ...(commandsImpl ? { commands: commandsImpl } : {}),
  };
}

test('/api/providers отдаёт commands каждого исполнителя, падение адаптера → []', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'providers-commands-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let calls = 0;
  const adapters = new Map([
    ['fake', stubAdapter('fake', () => { // намеренно SYNC: контракт не обязывает async
      calls += 1;
      return [
        { cmd: '/status', desc: 'Показать статус', run: 'prompt' },
        { cmd: '/goal', desc: 'Автономная цель', run: 'none', hint: 'только в TUI' },
        { cmd: '/bad', desc: '', run: 'prompt' }, // невалидная запись отбрасывается
      ];
    })],
    ['broken', stubAdapter('broken', async () => { throw new Error('scan failed'); })],
    ['silent', stubAdapter('silent', null)],
  ]);
  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast() {} });
  await app.register(providersModule, {
    config: { modelsPath: path.join(root, 'models.json') },
    claudeAuth: null,
    prefs: { read: () => ({}) },
    getProviderAdapters: async () => adapters,
  });
  t.after(() => app.close());

  const first = await app.inject({ method: 'GET', url: '/api/providers' });
  assert.equal(first.statusCode, 200);
  const byId = new Map(first.json().providers.map((p) => [p.id, p]));
  assert.deepEqual(byId.get('fake')?.commands, [
    { cmd: '/status', desc: 'Показать статус', run: 'prompt' },
    { cmd: '/goal', desc: 'Автономная цель', run: 'none', hint: 'только в TUI' },
  ]);
  assert.deepEqual(byId.get('broken')?.commands, [], 'падение commands() не валит реестр');
  assert.deepEqual(byId.get('silent')?.commands, [], 'без commands() — пустой список');

  const refreshed = await app.inject({ method: 'GET', url: '/api/providers?refresh=1' });
  assert.equal(refreshed.statusCode, 200);
  assert.ok(calls >= 2, '?refresh=1 пересобирает списки команд');
});

test('/api/providers берёт поддержку доверенных каталогов из контракта адаптера', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'providers-trusted-dirs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const runtimeAdapter = (id, trustedDirectories) => ({
    ...stubAdapter(id, null),
    run: async () => ({ reply: 'ok' }),
    trustedDirectories,
  });
  const adapters = new Map([
    ['static', runtimeAdapter('static', true)],
    ['dynamic', runtimeAdapter('dynamic', (config) => config.enableExtraDirs === true)],
    ['broken', runtimeAdapter('broken', () => { throw new Error('capability failed'); })],
    // Setup-only карточка не получает ходы и не должна обещать доступ, даже если
    // ошибочно скопировала capability из полноценного адаптера.
    ['setup', { ...stubAdapter('setup', null), trustedDirectories: true }],
  ]);
  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast() {} });
  await app.register(providersModule, {
    config: { modelsPath: path.join(root, 'models.json'), enableExtraDirs: true },
    claudeAuth: null,
    prefs: { read: () => ({}) },
    getProviderAdapters: async () => adapters,
  });
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/api/providers' });
  assert.equal(response.statusCode, 200);
  const byId = new Map(response.json().providers.map((provider) => [provider.id, provider]));
  assert.equal(byId.get('static')?.trustedDirectories, true);
  assert.equal(byId.get('dynamic')?.trustedDirectories, true);
  assert.equal(byId.get('broken')?.trustedDirectories, false, 'сбой capability не валит реестр');
  assert.equal(byId.get('setup')?.trustedDirectories, false, 'setup-only не получает ход');
});

// ── POST /api/chat + slashCommand ────────────────────────────────────────────

async function chatFixture(t, { executor }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-slash-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast() {} });
  const config = {
    chatsDir: path.join(root, 'chats'),
    chatStoreLegacyPath: path.join(root, 'legacy.json'),
    chatBindingsDir: path.join(root, 'bindings'),
    rootDir: root,
    factoryHome: root,
    agentsDir: path.join(root, 'agents'),
    port: 18141,
  };
  await app.register(chatModule, {
    config,
    factoryState: { async readEnv() { return {}; } },
    prefs: { read() { return { trustedDirectories: [], providerSettings: {}, chatAutoCompactWindow: 0 }; } },
    claudeAuth: null,
    internalToken: 'test',
    modelsRegistry: async () => ({
      claude: [{ id: 'claude-test', efforts: [] }],
      kimi: [{ id: 'kimi-test', efforts: [] }],
    }),
    executorResolver: async () => executor,
  });
  t.after(() => app.close());
  return { app, config, root };
}

async function saveChat(app, id, provider, model) {
  const response = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        id,
        modelRef: { provider, model },
        messages: [],
        createdAt: Date.UTC(2026, 7, 1),
        updatedAt: Date.UTC(2026, 7, 1),
        revision: 0,
      },
    },
  });
  assert.equal(response.statusCode, 200);
}

const SLASH_COMMANDS = [
  { cmd: '/status', desc: 'Статус сессии', run: 'prompt' },
  { cmd: '/goal', desc: 'Автономная цель', run: 'none', hint: 'только в TUI' },
];

function slashExecutor(id, runImpl) {
  const calls = [];
  return {
    id,
    retryContract: id === 'kimi' ? KIMI_RETRY_CONTRACT : undefined,
    commands: () => SLASH_COMMANDS, // намеренно SYNC: контракт не обязывает async
    calls,
    async run(opts) {
      calls.push(opts);
      return runImpl(opts, calls.length);
    },
  };
}

test('slashCommand из списка провайдера проходит, текст уходит executor-у без титул-хука', async (t) => {
  const executor = slashExecutor('claude', async () => ({ reply: 'ok', sessionId: 's1', steps: [] }));
  const { app } = await chatFixture(t, { executor });
  await saveChat(app, 'slash-ok', 'claude', 'claude-test');

  const res = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'slash-ok',
      message: '/status',
      slashCommand: '/status',
      requestTitle: true, // даже с флагом первого хода хук не приклеивается
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().reply, 'ok');
  assert.equal(executor.calls.length, 1);
  assert.equal(executor.calls[0].message, '/status');
  assert.doesNotMatch(executor.calls[0].message, /COCKPIT_CHAT_TITLE/);
});

test('slashCommand валидация: чужая команда, none-команда и подмена текста → 400', async (t) => {
  const executor = slashExecutor('claude', async () => ({ reply: 'ok', sessionId: 's1', steps: [] }));
  const { app } = await chatFixture(t, { executor });
  await saveChat(app, 'slash-bad', 'claude', 'claude-test');

  for (const payload of [
    { message: '/hack', slashCommand: '/hack' }, // нет в списке исполнителя
    { message: '/goal', slashCommand: '/goal' }, // run: 'none' — исполнять нельзя
    { message: 'обычный текст', slashCommand: '/status' }, // подмена текста флагом
    { message: '/status', slashCommand: '/status; rm -rf /' }, // мусор в поле
  ]) {
    const res = await app.inject({ method: 'POST', url: '/api/chat', payload: { chatKey: 'slash-bad', ...payload } });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.equal(res.json().error, 'unknown_slash_command');
  }
  assert.equal(executor.calls.length, 0, 'ни один невалидный ход не дошёл до executor-а');
});

test('служебный ход claude не автоповторяется при пустом выводе, ответ — плашка note', async (t) => {
  // legacy retryContract (не объявлен) = LEGACY_EMPTY_RUN_ONCE: обычный пустой ход
  // повторяется один раз, служебный — никогда.
  const executor = slashExecutor('claude', async () => ({ reply: '', sessionId: 's1', steps: [], emptyRun: true }));
  const { app } = await chatFixture(t, { executor });
  await saveChat(app, 'slash-empty', 'claude', 'claude-test');

  const plain = await app.inject({
    method: 'POST', url: '/api/chat',
    payload: { chatKey: 'slash-empty', message: 'вопрос' },
  });
  assert.equal(plain.statusCode, 200);
  assert.equal(executor.calls.length, 2, 'обычный пустой ход повторён один раз (прежнее поведение)');

  const slash = await app.inject({
    method: 'POST', url: '/api/chat',
    payload: { chatKey: 'slash-empty', message: '/status', slashCommand: '/status' },
  });
  assert.equal(slash.statusCode, 200);
  assert.equal(executor.calls.length, 3, 'служебный ход без автоповтора');
  assert.equal(slash.json().note, true);
  assert.match(slash.json().reply, /\/status/);
  assert.notEqual(slash.json().reply.trim(), '', 'пустой вывод подменён плашкой');
});

test('служебный ход kimi: пустой вывод не инвалидирует session binding', async (t) => {
  let created = false;
  const executor = slashExecutor('kimi', async (opts) => {
    if (!created) {
      created = true;
      await opts.onSessionCreated?.('provider-sess-1');
      return { reply: 'привет', sessionId: 'provider-sess-1', steps: [{ k: 'text', text: 'привет' }] };
    }
    return { reply: '', sessionId: 'provider-sess-1', steps: [], emptyRun: true, retryState: 'post_prompt' };
  });
  const { app, config } = await chatFixture(t, { executor });
  await saveChat(app, 'slash-kimi', 'kimi', 'kimi-test');
  const bindings = new ChatSessionBindingStore({ dir: config.chatBindingsDir });

  const first = await app.inject({
    method: 'POST', url: '/api/chat',
    payload: { chatKey: 'slash-kimi', message: 'привет' },
  });
  assert.equal(first.statusCode, 200);
  const before = await bindings.read('slash-kimi');
  assert.equal(before.sessionId, 'provider-sess-1');

  const slash = await app.inject({
    method: 'POST', url: '/api/chat',
    payload: { chatKey: 'slash-kimi', message: '/status', slashCommand: '/status' },
  });
  assert.equal(slash.statusCode, 200);
  assert.equal(slash.json().note, true);
  const after = await bindings.read('slash-kimi');
  assert.equal(after.sessionId, 'provider-sess-1', 'binding не инвалидирован');
  assert.equal(after.generation, before.generation, 'generation не вращалась');

  // Контраст: тот же пустой ход БЕЗ признака — прежняя ловушка на месте.
  const plain = await app.inject({
    method: 'POST', url: '/api/chat',
    payload: { chatKey: 'slash-kimi', message: 'вопрос' },
  });
  assert.equal(plain.statusCode, 500);
  assert.equal(plain.json().error, 'kimi_empty_response');
  const invalidated = await bindings.read('slash-kimi');
  assert.equal(invalidated.sessionId, null, 'обычный пустой ход по-прежнему сбрасывает сессию');
});

test('kimi служебный ход с аргументом (/compact <текст>) проходит валидацию', async (t) => {
  const executor = slashExecutor('kimi', async () => ({
    reply: 'сжато', sessionId: 's1', steps: [{ k: 'text', text: 'сжато' }],
  }));
  executor.commands = async () => [{ cmd: '/compact', desc: 'Сжать контекст', run: 'prompt' }];
  const { app } = await chatFixture(t, { executor });
  await saveChat(app, 'slash-args', 'kimi', 'kimi-test');

  const res = await app.inject({
    method: 'POST', url: '/api/chat',
    payload: {
      chatKey: 'slash-args',
      message: '/compact только решения',
      slashCommand: '/compact',
      requestTitle: true, // даже с флагом первого хода хук не приклеивается
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(executor.calls[0].message, '/compact только решения');
  assert.doesNotMatch(executor.calls[0].message, /COCKPIT_CHAT_TITLE/);
});
