// Обсуждение из телеграма во входе триажа.
//
// Четвёртая точка встройки разворота — и, пожалуй, самая заслуженная. Триаж сам
// расписывается в бессилии на этих ссылках: в его промпте прямым текстом стоит
// «есть недоступные ссылки (t.me/…) — ставь confidence low и заполняй questions[]».
// То есть каждая задача, где суть обсуждения лежит в чате, приезжала оценщику
// заведомо мутной, и он честно отвечал «нужно уточнение» вместо оценки.
//
// Обещания, которые здесь проверяются:
//
//  • обсуждение доезжает в промпт ОТДЕЛЬНЫМ блоком, а не в хвосте описания:
//    описание режется потолком CAP_DESC с конца, и секция, стоящая последней,
//    срезалась бы первой и молча (та же грабля, что в тикете и в чате);
//  • граница проекта работает и здесь. Проект задачи — профиль её прогона;
//    задача без реестра (а в триаже это норма, оценивают ДО запуска) означает
//    «проект неизвестен», и это не повод ни закрыть привязанный чат, ни открыть
//    непривязанный;
//  • у отказа наружу уходит только причина: ни переписки, ни имени чужого чата;
//  • триаж не имеет права падать из-за обсуждения. Выключенный плагин, сломанный
//    архив, упавший разворот — оценка обязана состояться, просто без переписки.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Analyzer } from '../../server/src/lib/analysis/analyzer.ts';
import { TelegramArchiveStore } from '../../server/src/lib/telegram/archiveStore.ts';
import { TelegramRulesStore } from '../../server/src/lib/telegram/rulesStore.ts';
import { DISCUSSION_SECTION_TITLE } from '../../server/src/lib/telegram/discussion.ts';
import telegramModule from '../../server/src/modules/telegram/index.ts';
import {
  TelegramModuleCredentials,
  telegramModuleConnection,
} from './helpers/telegram-account-module.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const TOKEN = '8123456789:AAHrEaLLyLoNgSeCrEtPaRt_x1y2z3w4v5u6';
const BUGS = -1001234567890;   // рабочий чат, привязан к проекту demo
const OTHER = -1009999999999;  // чужой чат, правила нет
const T0 = Date.UTC(2026, 7, 1, 9, 0, 0) / 1000;

const ME = {
  id: 8123456789,
  username: 'example_inbox_bot',
  firstName: 'GrigDesk · входящие',
  canJoinGroups: true,
  canReadAllGroupMessages: true,
};

const SECRET = 'чек не проводится только при оплате картой, наличные проходят';
const link = (chatId, id) => `https://t.me/c/${String(chatId).replace('-100', '')}/${id}`;

const msg = (over = {}) => ({
  chatId: BUGS,
  chatUsername: '',
  chatTitle: 'GrigDesk · баги',
  chatType: 'supergroup',
  isForum: false,
  messageId: 100,
  threadId: null,
  replyToMessageId: null,
  date: T0,
  editedAt: null,
  from: { id: 7, name: 'Аня', username: 'anya' },
  text: SECRET,
  media: [],
  ...over,
});

const TASK = {
  id: 4821,
  title: 'Касса не пробивает чек',
  description: `<p>Обсуждение: ${link(BUGS, 100)}</p>`,
};

const logStub = () => ({ warn() {}, error() {}, info() {}, debug() {} });

/**
 * Живой модуль telegram + настоящий Analyzer с перехваченным запуском модели.
 *
 * Analyzer создаётся ДО регистрации telegram — ровно как в `app.js` (там он
 * рождается строкой 142, а модуль telegram регистрируется много ниже). Значит
 * ссылка на декоратор обязана быть ленивой, и фикстура это воспроизводит, а не
 * обходит.
 */
async function fixture(t, {
  messages = [],
  rules: ruleList = [{ project: 'demo', chatId: BUGS }],
  profile = 'demo',
  enabled = true,
  archive: archiveStub = null,
  discussion: discussionStub = null,
  task = TASK,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-triage-tg-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const creds = new TelegramModuleCredentials();
  creds.write({ token: TOKEN, bot: ME });
  const store = new TelegramArchiveStore({ dir: path.join(root, 'archive'), log: logStub() });
  for (const m of messages) await store.append(m);
  const rules = new TelegramRulesStore({ dir: path.join(root, 'rules'), log: logStub() });
  await rules.write(ruleList, { projects: ['demo', 'other'] });

  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', () => enabled);

  const analyzer = new Analyzer({
    config: {
      analysisDir: path.join(root, 'analysis'),
      chatsDir: path.join(root, 'chats'),
      factoryHome: root,
      // Профиля триажа нет: проектных путей у пустого стенда не бывает, а
      // разведка кода к обсуждению отношения не имеет.
      profilesDir: path.join(root, 'profiles'),
      factoryProfile: '',
      analysisTimeoutMs: 1000,
    },
    claudeAuth: null,
    tracker: {
      taskDetail: async () => task,
      taskPageData: async () => ({ comments: [] }),
    },
    factoryState: {
      async primaryProfile() { return null; },
      async readRegistry() {
        // Профиль прогона — он же проект для allowlist. В триаже задачу обычно
        // ещё не запускали, и реестра нет вовсе: это штатный случай.
        if (!profile) throw new Error('реестра нет');
        return { registry: { PROFILE: profile }, mtime: 0 };
      },
    },
    prefs: { read: () => ({}) },
    log: logStub(),
    discussion: discussionStub ?? ((text, opts) => app.telegramDiscussion?.(text, opts)),
    pluginEnabled: () => true,
    pluginSettings: () => ({
      triageModel: { provider: 'claude', model: 'claude-test' },
      autoArbitrate: false,
    }),
    providerRegistry: async () => ({
      claude: [{ id: 'claude-test', efforts: null }],
    }),
    executorFor: async () => ({
      id: 'claude',
      scopedWorkspace: true,
      async run(options) {
        const prompt = String(options.message || '');
        captured.prompt = prompt;
        const jsonPath = prompt.match(/(?:- |\[Схема )([^\s\]]+\.analysis\.json)/)?.[1];
        const notePath = prompt.match(/- ([^\s]+\/t\d+\.md)/)?.[1];
        await writeFile(jsonPath, JSON.stringify({ task: TASK.id, complexity: 1 }));
        await writeFile(notePath, '# Разведка\n');
        return { cost: 0, contextTokens: 0, actualModel: 'claude-test' };
      },
    }),
  });

  const nativeBotApi = {
    getMe: async () => ME,
    callBotApi: async () => { throw new Error('сеть в тесте не нужна'); },
  };
  const connection = telegramModuleConnection({
    creds, archive: archiveStub ?? store, rules, botApi: nativeBotApi,
  });
  await app.register(telegramModule, {
    connection,
    botApi: nativeBotApi,
    listProjects: async () => ['demo', 'other'],
  });
  await app.ready();
  t.after(() => app.close());

  const captured = {};

  return {
    async run(id = String(TASK.id)) {
      const res = await analyzer.analyze(id);
      assert.equal(res.ok, true, `триаж упал: ${res.error}`);
      return captured.prompt;
    },
  };
}

test('переписка по ссылке из задачи доезжает в промпт триажа', async (t) => {
  const { run } = await fixture(t, {
    messages: [msg({ messageId: 99, text: 'до' }), msg(), msg({ messageId: 101, text: 'после' })],
  });

  const prompt = await run();
  assert.ok(prompt.includes(DISCUSSION_SECTION_TITLE), 'секции обсуждения нет вовсе');
  assert.match(prompt, new RegExp(SECRET));
  assert.match(prompt, /Чат «GrigDesk · баги»/);
  assert.match(prompt, /← ссылка/);

  // Обсуждение — часть ВХОДА оценки: агент читает его вместе с задачей, до
  // указаний, что делать. Приклеенное в хвост промпта оно читалось бы как
  // приложение к схеме результата.
  assert.ok(
    prompt.indexOf(DISCUSSION_SECTION_TITLE) > prompt.indexOf(`[Задача #${TASK.id}]`),
    'обсуждение встало раньше самой задачи',
  );
  assert.ok(
    prompt.indexOf(DISCUSSION_SECTION_TITLE) < prompt.indexOf('[Что сделать]'),
    'обсуждение вывалилось из входа оценки',
  );
});

test('обсуждение — отдельный блок: потолок описания его не режет', async (t) => {
  // Та самая грабля: описание в промпте обрезается с КОНЦА, а секция стоит
  // последней. Внутри описания обсуждение исчезало бы молча и именно у тех
  // задач, где текста много, — то есть у самых сложных.
  const { run } = await fixture(t, {
    messages: [msg()],
    task: {
      ...TASK,
      description: `Обсуждение: ${link(BUGS, 100)}\n${'подробности постановки. '.repeat(500)}\nХВОСТ-ОПИСАНИЯ`,
    },
  });

  const prompt = await run();
  assert.equal(prompt.includes('ХВОСТ-ОПИСАНИЯ'), false, 'описание внезапно перестало обрезаться — проверка потеряла смысл');
  assert.match(prompt, new RegExp(SECRET), 'обрезка описания унесла с собой обсуждение');
});

test('задача без телеграм-ссылок: промпт не обрастает пустым блоком', async (t) => {
  const { run } = await fixture(t, {
    task: { ...TASK, description: '<p>Просто описание</p>' },
  });

  const prompt = await run();
  assert.equal(prompt.includes(DISCUSSION_SECTION_TITLE), false, 'пустой блок в промпте — лишний шум');
});

test('чат чужого проекта закрыт и для триажа: причина есть, переписки нет', async (t) => {
  const { run } = await fixture(t, {
    profile: 'demo',
    rules: [{ project: 'other', chatId: BUGS }],
    messages: [msg()],
  });

  const prompt = await run();
  assert.equal(prompt.includes(SECRET), false, 'переписка чужого проекта уехала оценщику');
  assert.equal(prompt.includes('GrigDesk · баги'), false, 'даже имя чужого чата наружу не уезжает');
  assert.match(prompt, /Ссылка не раскрыта/);
  assert.match(prompt, /привязан к проекту/i);
});

test('задача без реестра: проект неизвестен, но allowlist на месте', async (t) => {
  // Нормальное состояние задачи в триаже: её ещё не запускали, профиля нет.
  // Сверять не с чем — значит работает голый allowlist, не больше и не меньше.
  const { run } = await fixture(t, {
    profile: '',
    task: { ...TASK, description: `<p>${link(BUGS, 100)} и ${link(OTHER, 7)}</p>` },
    messages: [msg(), msg({ chatId: OTHER, chatTitle: 'Чужой чат', messageId: 7, text: 'чужое' })],
  });

  const prompt = await run();
  assert.match(prompt, new RegExp(SECRET));
  assert.equal(prompt.includes('Чужой чат'), false);
  assert.match(prompt, /Ссылка не раскрыта/);
});

test('выключенный плагин: триаж идёт, а обсуждения нет и объяснений тоже', async (t) => {
  const { run } = await fixture(t, { enabled: false, messages: [msg()] });

  const prompt = await run();
  assert.equal(prompt.includes(DISCUSSION_SECTION_TITLE), false);
  assert.equal(prompt.includes('Ссылка не раскрыта'), false, 'выключенный раздел ничего не объясняет');
  assert.match(prompt, new RegExp(`\\[Задача #${TASK.id}\\]`), 'задача в промпте осталась');
});

test('сломанный архив не роняет триаж', async (t) => {
  const { run } = await fixture(t, {
    archive: {
      chats: async () => [],
      chatIdOf: async () => { throw new Error('архив недоступен'); },
      branch: async () => { throw new Error('архив недоступен'); },
      append: async () => {},
    },
  });

  const prompt = await run();
  assert.equal(prompt.includes(DISCUSSION_SECTION_TITLE), false);
  assert.match(prompt, new RegExp(`\\[Задача #${TASK.id}\\]`));
});

test('упавший разворот не роняет триаж', async (t) => {
  // Декоратор ошибки глотает сам, но Analyzer обязан пережить и того, кто
  // бросил: оценка задачи не зависит от исправности телеграма.
  const { run } = await fixture(t, {
    discussion: async () => { throw new Error('разворот сломан'); },
  });

  const prompt = await run();
  assert.equal(prompt.includes(DISCUSSION_SECTION_TITLE), false);
  assert.match(prompt, new RegExp(`\\[Задача #${TASK.id}\\]`));
});
