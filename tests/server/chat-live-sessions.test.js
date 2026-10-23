// Живые сессии исполнителей: процесс агента переживает свой ход.
//
// Настоящий CLI здесь не нужен и не запускается: протокол `--input-format stream-json`
// эмулирует скрипт-заглушка. Проверяется ровно то, ради чего всё затевалось, — что
// процесс не умирает вместе с ответом, что непрошеный ход доезжает наружу и что «стоп»
// прерывает ход, а не разговор.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import {
  claudeSessionArgs,
  openClaudeStreamSession,
} from '../../server/src/lib/executors/_claudeStream.ts';
import claude, { claudeProviderSettingsArgs } from '../../server/src/lib/executors/claude.ts';
import { ChatBackgroundRuns, visibleExtraDirs } from '../../server/src/lib/chat/backgroundRuns.ts';
import { ChatLiveSessions } from '../../server/src/lib/chat/liveSessions.ts';
import chatModule from '../../server/src/modules/chat/index.ts';

const FAKE_CLI = `
import readline from 'node:readline';

const resumeIndex = process.argv.indexOf('--resume');
const sessionId = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : 'sid-new';
const say = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let pendingInterrupt = false;

const answer = (text, subtype = 'success') => {
  say({
    type: 'assistant',
    session_id: sessionId,
    message: {
      model: 'fake-1',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 11, output_tokens: 3 },
    },
  });
  say({ type: 'result', session_id: sessionId, subtype, result: text, num_turns: 1 });
};

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
    say({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
    if (pendingInterrupt) {
      pendingInterrupt = false;
      say({
        type: 'result', session_id: sessionId,
        subtype: 'error_during_execution', result: '', num_turns: 1,
      });
    }
    return;
  }

  const text = msg.message?.content?.[0]?.text || '';
  if (text.includes('ДОЛГО')) {
    // Ход, который сам не закончится: его закрывает только interrupt.
    pendingInterrupt = true;
    return;
  }
  if (text.includes('ФОН')) {
    answer('запустил');
    // Непрошеный ход: CLI будит модель сам, когда фоновая задача закончилась.
    setTimeout(() => answer('ФОН ЗАВЕРШЁН'), 120);
    return;
  }
  answer('ок:' + text.slice(0, 20));
});
`;

async function fakeBin() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-live-session-'));
  const file = path.join(dir, 'fake-cli.mjs');
  await writeFile(file, FAKE_CLI);
  return { dir, file };
}

function openFake({ file, sessionId = null, hooks = {} }) {
  return openClaudeStreamSession({
    bin: process.execPath,
    args: [file, ...claudeSessionArgs({ permissionMode: 'default', sessionId })],
    cwd: os.tmpdir(),
    env: process.env,
    sessionId,
    hooks,
  });
}

test('процесс переживает свой ход и обслуживает следующий', async () => {
  const { dir, file } = await fakeBin();
  const session = openFake({ file });
  try {
    const first = await session.send({ message: 'привет' });
    assert.equal(first.reply, 'ок:привет');
    assert.equal(session.alive, true);

    const pid = session.pid;
    const second = await session.send({ message: 'ещё' });
    assert.equal(second.reply, 'ок:ещё');
    assert.equal(session.pid, pid);
  } finally {
    await session.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('непрошеный ход доезжает наружу отдельным событием', async () => {
  const { dir, file } = await fakeBin();
  const background = [];
  let startSeen = 0;
  const session = openFake({
    file,
    hooks: {
      onBackgroundStart: () => { startSeen += 1; },
      onBackground: (result) => background.push(result),
    },
  });
  try {
    const answered = await session.send({ message: 'ФОН: запусти и закончи ход' });
    assert.equal(answered.reply, 'запустил');
    assert.equal(background.length, 0, 'до завершения фоновой задачи непрошеного хода нет');

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(background.length, 1);
    assert.equal(background[0].reply, 'ФОН ЗАВЕРШЁН');
    assert.equal(startSeen, 1);
  } finally {
    await session.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('стоп прерывает ход, а сессия остаётся живой', async () => {
  const { dir, file } = await fakeBin();
  const session = openFake({ file });
  try {
    const running = session.send({ message: 'ДОЛГО думай' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await session.interrupt();

    const error = await running.then(() => null, (err) => err);
    assert.ok(error, 'прерванный ход возвращает ошибку остановки');
    assert.equal(error.stopped, true);
    assert.equal(session.alive, true, 'процесс после стопа жив');

    const next = await session.send({ message: 'продолжаем' });
    assert.equal(next.reply, 'ок:продолжаем');
  } finally {
    await session.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Пул: время жизни, потолок и переоткрытие ────────────────────────────────────

function fakeExecutor({ opened = [], restartOn } = {}) {
  return {
    id: 'fake',
    session: {
      mode: 'persistent',
      unsolicited: true,
      ...(restartOn ? { restartOn } : {}),
      open(spec) {
        const handle = {
          spec,
          alive: true,
          pid: opened.length + 1,
          interrupted: 0,
          sends: 0,
          closed: false,
          async send({ message }) {
            handle.sends += 1;

            return { reply: `ответ:${message}`, sessionId: spec.sessionId || 'sid-1', steps: [] };
          },
          async interrupt() { handle.interrupted += 1; },
          async close() { handle.closed = true; handle.alive = false; },
        };
        opened.push(handle);
        return handle;
      },
    },
  };
}

test('пул переиспользует одну сессию и переоткрывает её при смене модели', async () => {
  const opened = [];
  const executor = fakeExecutor({ opened });
  const pool = new ChatLiveSessions({ maxSessions: 4 });

  await pool.run({ chatKey: 'c1', executor, model: 'a' }, { message: 'раз' });
  await pool.run({ chatKey: 'c1', executor, model: 'a' }, { message: 'два' });
  assert.equal(opened.length, 1, 'та же модель — тот же процесс');

  await pool.run({ chatKey: 'c1', executor, model: 'b' }, { message: 'три' });
  assert.equal(opened.length, 2, 'смена модели переоткрывает сессию');
  assert.equal(opened[0].closed, true);
  // Разговор не теряется: новый процесс поднимается с прежним id сессии.
  assert.equal(opened[1].spec.sessionId, 'sid-1');

  await pool.closeAll();
});

test('пул переоткрывает high → ultracode → high с прежним sessionId и новым argv', async (t) => {
  const opened = [];
  const executor = fakeExecutor({ opened, restartOn: claude.session.restartOn });
  const pool = new ChatLiveSessions({ maxSessions: 4 });

  t.after(() => pool.closeAll());

  for (const effort of ['high', 'ultracode', 'ultracode', 'high']) {
    await pool.run({
      chatKey: 'effort-switch',
      executor,
      effort,
    }, { message: 'ход' });
  }

  assert.deepEqual(opened.map((handle) => handle.spec.effort), ['high', 'ultracode', 'high']);
  assert.deepEqual(opened.map((handle) => handle.closed), [true, true, false]);
  assert.equal(opened[1].sends, 2, 'тот же effort переиспользует процесс');

  for (const handle of opened.slice(1)) {
    const args = claudeSessionArgs(handle.spec);

    assert.equal(handle.spec.sessionId, 'sid-1');
    assert.equal(args[args.indexOf('--resume') + 1], 'sid-1');
    assert.equal(args[args.indexOf('--effort') + 1], handle.spec.effort);
  }
});

test('смена blockDirectSsh переоткрывает процесс, равное значение не переоткрывает', async () => {
  const opened = [];
  const executor = fakeExecutor({ opened, restartOn: ['providerSettings'] });
  const pool = new ChatLiveSessions({ maxSessions: 4 });

  await pool.run({
    chatKey: 'c1', executor, providerSettings: { blockDirectSsh: true },
  }, { message: 'раз' });
  await pool.run({
    chatKey: 'c1', executor, providerSettings: { blockDirectSsh: true },
  }, { message: 'два' });
  const afterSame = opened.length;
  await pool.run({
    chatKey: 'c1', executor, providerSettings: { blockDirectSsh: false },
  }, { message: 'три' });

  assert.deepEqual({ afterSame, afterChange: opened.length, oldClosed: opened[0].closed }, {
    afterSame: 1,
    afterChange: 2,
    oldClosed: true,
  });
  await pool.closeAll();
});

test('смена исполнителя не переносит id сессии в новый процесс', async () => {
  // Id сессии принадлежит вендору: thread claude для codex — чужой id, и resume по нему
  // падает «no rollout found». После смены ИИ новый процесс обязан стартовать без id.
  const opened = [];
  const claude = { ...fakeExecutor({ opened }), id: 'claude' };
  const codex = { ...fakeExecutor({ opened }), id: 'codex' };
  const pool = new ChatLiveSessions({ maxSessions: 4 });

  await pool.run({ chatKey: 'c1', executor: claude, model: 'a' }, { message: 'раз' });
  assert.equal(pool.stats()[0].sessionId, 'sid-1', 'первый исполнитель завёл сессию');

  await pool.run({ chatKey: 'c1', executor: codex, model: 'a', sessionId: null }, { message: 'два' });
  assert.equal(opened.length, 2, 'смена исполнителя переоткрывает процесс');
  assert.equal(opened[0].closed, true);
  assert.equal(opened[1].spec.sessionId, null, 'чужой id сессии новому исполнителю не достаётся');
  assert.equal(pool.stats()[0].executor, 'codex');

  await pool.closeAll();
});

test('умерший процесс заменяется новым с прежним id сессии', async () => {
  const opened = [];
  const executor = fakeExecutor({ opened });
  const pool = new ChatLiveSessions();

  await pool.run({ chatKey: 'c1', executor, model: 'a' }, { message: 'раз' });
  opened[0].alive = false;

  await pool.run({ chatKey: 'c1', executor, model: 'a' }, { message: 'два' });
  assert.equal(opened.length, 2);
  assert.equal(opened[1].spec.sessionId, 'sid-1');

  await pool.closeAll();
});

test('пустой id сессии живую сессию не рвёт, чужой — рвёт', async () => {
  const opened = [];
  const executor = fakeExecutor({ opened });
  const pool = new ChatLiveSessions();

  await pool.run({ chatKey: 'c1', executor, model: 'a', sessionId: null }, { message: 'раз' });
  // Отставшее окно не знает id и присылает пустое поле — это не повод начинать заново.
  await pool.run({ chatKey: 'c1', executor, model: 'a', sessionId: null }, { message: 'два' });
  assert.equal(opened.length, 1);

  await pool.run({ chatKey: 'c1', executor, model: 'a', sessionId: 'sid-other' }, { message: 'три' });
  assert.equal(opened.length, 2, 'явно другой id означает другой разговор');

  await pool.closeAll();
});

test('потолок вытесняет самую давнюю свободную сессию', async () => {
  const opened = [];
  const executor = fakeExecutor({ opened });
  const pool = new ChatLiveSessions({ maxSessions: 2 });

  await pool.run({ chatKey: 'c1', executor, model: 'a' }, { message: 'раз' });
  await pool.run({ chatKey: 'c2', executor, model: 'a' }, { message: 'два' });
  await pool.run({ chatKey: 'c3', executor, model: 'a' }, { message: 'три' });

  assert.equal(pool.has('c1'), false, 'самая давняя закрыта');
  assert.equal(pool.has('c3'), true);
  assert.equal(opened[0].closed, true);

  await pool.closeAll();
});

test('простой закрывает сессию, стоп доезжает до исполнителя', async () => {
  const opened = [];
  const executor = fakeExecutor({ opened });
  const pool = new ChatLiveSessions({ idleMs: 60_000 });

  await pool.run({ chatKey: 'c1', executor, model: 'a' }, { message: 'раз' });
  assert.equal(await pool.interrupt('c1'), true);
  assert.equal(opened[0].interrupted, 1);

  await pool.close('c1', 'тест');
  assert.equal(pool.has('c1'), false);
  assert.equal(opened[0].closed, true);

  await pool.closeAll();
});

// ── Контракт исполнителей и гейт настройки ─────────────────────────────────────

test('claude и codex объявляют живую сессию, а самопробуждение — только claude', async () => {
  const claude = (await import('../../server/src/lib/executors/claude.ts')).default;
  const codex = (await import('../../server/src/lib/executors/codex.ts')).default;

  assert.equal(claude.session?.mode, 'persistent');
  // Фоновые задачи и субагенты отчитываются сами — это проверено живым замером CLI.
  assert.equal(claude.session?.unsolicited, true);
  assert.equal(typeof claude.session?.open, 'function');

  assert.equal(codex.session?.mode, 'persistent');
  // У Codex фоновых агентов нет: сессия живёт, но ходов без запроса он не выдаёт.
  assert.equal(codex.session?.unsolicited, false);
  assert.equal(typeof codex.session?.open, 'function');

  // Модель и рабочие каталоги — флаги запуска: сменить их без переоткрытия нечем.
  assert.equal(claude.session.restartOn.includes('model'), true);
  assert.equal(codex.session.restartOn.includes('cwd'), true);
  assert.equal(claude.session.restartOn.includes('providerSettings'), true);
  assert.equal(codex.session.restartOn.includes('providerSettings'), true);
});

test('долгоживущий Claude получает те же default-on SSH-слои, что разовый ход', () => {
  const snapshot = [undefined, true, false].map((blockDirectSsh) => {
    const providerSettings = blockDirectSsh === undefined ? {} : { blockDirectSsh };
    const args = claudeSessionArgs({
      permissionMode: 'bypassPermissions',
      providerSettingsArgs: claudeProviderSettingsArgs(providerSettings),
    });
    const settingsIndex = args.indexOf('--settings');
    const settings = settingsIndex >= 0 ? JSON.parse(args[settingsIndex + 1]) : {};
    return {
      nativeDeny: args.includes('--disallowedTools'),
      hook: JSON.stringify(settings.hooks || {}).includes('_direct-ssh-policy-hook.js'),
    };
  });

  assert.deepEqual(snapshot, [
    { nativeDeny: true, hook: true },
    { nativeDeny: true, hook: true },
    { nativeDeny: false, hook: false },
  ]);
});

test('модуль чата гейтит живую сессию настройкой и не убивает процесс стопом', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../../server/src/modules/chat/index.ts', import.meta.url),
    'utf8',
  );

  // Тумблер отката: выключенная настройка обязана возвращать прежний разовый запуск.
  assert.equal(source.includes("currentPrefs.chatLiveSessions !== false"), true);
  // Стоп остаётся прежней ручкой, но для живой сессии превращается в прерывание хода.
  assert.equal(source.includes('liveSessions.interrupt(chatKey)'), true);
  // Непрошеный ход обязан уезжать в историю: без этого он виден только в логе.
  assert.equal(source.includes('onBackgroundTurn'), true);
  assert.equal(source.includes("fastify.sse.broadcast('chat-orphan'"), true);

  const prefs = await readFile(
    new URL('../../server/src/lib/prefsStore.ts', import.meta.url),
    'utf8',
  );
  // Неизвестные ключи PrefsStore.write отбрасывает — без дефолта тумблер не сохранится.
  assert.equal(prefs.includes('chatLiveSessions: true'), true);
});

// ── Список живых процессов и их гашение человеком ─────────────────────────────
// Свободная сессия в `ps` неотличима от разового запуска, поэтому увидеть её и
// погасить можно только из GrigDesk. Проверяем сквозняком: ход поднимает процесс,
// список его показывает, кнопка гасит, а идущий ход не гасится без подтверждения.

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

/**
 * Поднимает модуль чата с синтетической живой сессией во временном каталоге.
 * Необязательный sink проверяет передачу аккаунтных квот после завершения runId.
 */
async function apiFixture(t, {
  liveEnabled = true,
  providerUsageSink = null,
  taskId = null,
  root: givenRoot = '',
} = {}) {
  const root = givenRoot || await mkdtemp(path.join(os.tmpdir(), 'grigdesk-live-api-'));

  if (!givenRoot) {
    t.after(() => rm(root, { recursive: true, force: true }));
  }

  const events = [];
  const handles = [];
  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast(event, data) { events.push({ event, data }); } });

  if (providerUsageSink) {
    app.decorate('providerUsageSink', providerUsageSink);
  }


  // Фейковая живая сессия: настоящий CLI здесь не нужен, проверяется владение
  // временем жизни процесса, а не его протокол.
  const executor = {
    id: 'claude',
    async modes() { return [{ id: 'default' }, { id: 'plan' }]; },
    async run() { throw new Error('разовый запуск не ожидается: сессия живая'); },
    session: {
      mode: 'persistent',
      unsolicited: true,
      restartOn: ['model', 'effort', 'permissionMode', 'cwd', 'extraDirs'],
      open(spec) {
        const handle = {
          spec,
          pid: 4242 + handles.length,
          alive: true,
          busy: false,
          sessionId: 'sid-live',
          // С каким id процесс подняли: пустой — новый разговор, иначе resume прежнего.
          openedWith: spec.sessionId || null,
          hold: null,
          interrupted: 0,
          sends: 0,
          closed: false,
          async send() {
            if (handle.hold) await handle.hold;
            return { reply: 'ок', steps: [], sessionId: 'sid-live', cost: 0 };
          },
          async interrupt() { handle.interrupted += 1; },
          async close() {
            handle.alive = false;
            handle.closed = true;
            spec.hooks?.onExit?.({ reason: 'закрыт' });
          },
        };
        handles.push(handle);
        return handle;
      },
    },
  };

  await app.register(chatModule, {
    config: {
      chatsDir: path.join(root, 'chats'),
      chatStoreLegacyPath: path.join(root, 'legacy.json'),
      chatBindingsDir: path.join(root, 'bindings'),
      rootDir: root,
      factoryHome: root,
      port: 18140,
    },
    factoryState: {
      async readEnv() {
        return {
          REPO_COUNT: '1',
          REPO_0_NAME: 'grigdesk',
          REPO_0_SOURCE: root,
          REPO_0_WT: root,
          REPO_0_BRANCH: 'test-sleep',
          WORKSPACE_MODE: 'shared',
        };
      },
    },
    prefs: {
      read() {
        return {
          speech: {},
          providerSettings: {},
          chatAutoCompactWindow: 0,
          chatLiveSessions: liveEnabled,
        };
      },
    },
    modelsRegistry: async () => ({ claude: [{ id: 'claude-test', efforts: [] }] }),
    executorResolver: async (provider) => (provider === 'claude' ? executor : null),
    taskExists: async (id) => taskId !== null && String(id) === taskId,
  });
  await app.ready();
  t.after(() => app.close());

  async function chat(id = 'live-chat') {
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/chat/store/chat',
      payload: {
        chat: {
          id,
          title: 'Разговор про сборку',
          ...(taskId ? { taskId } : {}),
          model: 'claude-test',
          modelRef: { provider: 'claude', model: 'claude-test' },
          messages: [],
          createdAt: Date.UTC(2026, 7, 19),
          updatedAt: Date.UTC(2026, 7, 19),
        },
      },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    return id;
  }

  function turn(chatKey, extra = {}) {
    return app.inject({
      method: 'POST',
      url: taskId ? `/api/tasks/${taskId}/chat` : '/api/chat',
      payload: {
        chatKey,
        modelRef: { provider: 'claude', model: 'claude-test' },
        model: 'claude-test',
        message: 'запусти сборку',
        mode: 'plan',
        ...extra,
      },
    });
  }

  return {
    app,
    root,
    events,
    handles,
    chat,
    turn,
  };
}

test('список живых процессов показывает, что именно держит память', async (t) => {
  const fixture = await apiFixture(t);
  const chatKey = await fixture.chat();

  const empty = await fixture.app.inject({ method: 'GET', url: '/api/chat/sessions' });
  assert.equal(empty.statusCode, 200, empty.body);
  assert.deepEqual(empty.json().sessions, [], 'до первого хода живых процессов нет');
  assert.equal(empty.json().enabled, true);
  assert.ok(empty.json().maxSessions >= 1, 'потолок объявлен, чтобы окно не повторяло его у себя');

  const done = await fixture.turn(chatKey);
  assert.equal(done.statusCode, 200, done.body);

  const list = (await fixture.app.inject({ method: 'GET', url: '/api/chat/sessions' })).json();
  assert.equal(list.sessions.length, 1);
  const [session] = list.sessions;
  assert.equal(session.chatKey, chatKey);
  assert.equal(session.executor, 'claude');
  assert.equal(session.pid, fixture.handles[0].pid, 'pid отдаётся, чтобы процесс можно было сверить с ps');
  assert.equal(session.model, 'claude-test');
  assert.equal(session.permissionMode, 'plan');
  assert.equal(session.chatTitle, 'Разговор про сборку');
  assert.equal(session.running, false, 'ход закончился, а процесс остался жив');
  assert.equal(session.unsolicited, true);
  assert.ok(session.idleAtMs > Date.now(), 'свободная сессия сама погаснет — время видно человеку');

  // Открытие сессии обязано будить окна: список не опрашивается по таймеру.
  assert.ok(fixture.events.some((e) => e.event === 'chat-sessions'));
});

test('погашение процесса не трогает разговор, а идущий ход требует подтверждения', async (t) => {
  const fixture = await apiFixture(t);
  const chatKey = await fixture.chat();
  await fixture.turn(chatKey);

  const closed = await fixture.app.inject({
    method: 'DELETE',
    url: `/api/chat/sessions/${chatKey}`,
  });
  assert.equal(closed.statusCode, 200, closed.body);
  assert.equal(closed.json().forced, false);
  assert.equal(fixture.handles[0].closed, true, 'процесс действительно закрыт');

  const gone = await fixture.app.inject({ method: 'DELETE', url: `/api/chat/sessions/${chatKey}` });
  assert.equal(gone.statusCode, 404, 'погашенной сессии больше нет');

  const chat = await fixture.app.inject({ method: 'GET', url: `/api/chat/store/chat/${chatKey}` });
  assert.equal(chat.statusCode, 200, 'разговор гашение процесса не удаляет');

  // Идущий ход: держим send незавершённым и пробуем погасить процесс под ним.
  const second = fixture.turn(chatKey);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const live = fixture.handles[1];
  assert.ok(live, 'следующий ход поднял процесс заново');
  let release = null;
  live.hold = new Promise((resolve) => { release = resolve; });

  const third = fixture.turn(chatKey);
  await second;
  await new Promise((resolve) => setTimeout(resolve, 30));

  const busy = await fixture.app.inject({ method: 'DELETE', url: `/api/chat/sessions/${chatKey}` });
  assert.equal(busy.statusCode, 409, busy.body);
  assert.equal(busy.json().error, 'chat_busy');
  assert.equal(live.closed, false, 'без подтверждения работа агента не теряется');

  const forced = await fixture.app.inject({
    method: 'DELETE',
    url: `/api/chat/sessions/${chatKey}?force=1`,
  });
  assert.equal(forced.statusCode, 200, forced.body);
  assert.equal(forced.json().forced, true);
  assert.equal(live.interrupted, 1, 'ход сначала прерывается, чтобы окно увидело «Ход остановлен»');
  assert.equal(live.closed, true);

  release();
  await third;
});

test('массовое гашение не обрывает работу молча', async (t) => {
  const fixture = await apiFixture(t);
  const free = await fixture.chat('free-chat');
  const working = await fixture.chat('working-chat');
  await fixture.turn(free);
  await fixture.turn(working);

  const busyHandle = fixture.handles.find((h) => h.alive && !h.closed && h.pid === fixture.handles[1].pid);
  let release = null;
  busyHandle.hold = new Promise((resolve) => { release = resolve; });
  const running = fixture.turn(working);
  await new Promise((resolve) => setTimeout(resolve, 30));

  const result = await fixture.app.inject({ method: 'DELETE', url: '/api/chat/sessions' });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().closed, 1);
  assert.equal(result.json().skipped, 1, 'занятая ходом сессия гасится только по одной и осознанно');
  assert.equal(busyHandle.closed, false);

  release();
  await running;
});

test('id сессии сообщается с первого события хода, а не по его итогу', async () => {
  const { dir, file } = await fakeBin();
  const session = openFake({ file });
  const order = [];
  try {
    const result = await session.send({
      message: 'привет',
      onSessionCreated: (id) => { order.push(`session:${id}`); },
    });
    order.push('result');
    // Перезапуск сервера посреди первого хода раньше оставлял чат без сессии:
    // id доезжал только с result, которого у оборванного хода нет.
    assert.equal(result.sessionId, 'sid-new');
    assert.deepEqual(order, ['session:sid-new', 'result']);
    assert.equal(session.sessionId, 'sid-new');
  } finally {
    await session.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('пул записывает ранний id сессии до внешнего колбэка', async () => {
  const opened = [];
  const executor = fakeExecutor({ opened });
  // Ход, который сообщает id заранее, как настоящий поток CLI.
  opened.announce = true;
  executor.session.open = (spec) => {
    const handle = {
      spec,
      alive: true,
      pid: 1,
      async send({ message, onSessionCreated }) {
        await onSessionCreated?.('sid-early');
        return { reply: `ответ:${message}`, sessionId: 'sid-early', steps: [] };
      },
      async interrupt() {},
      async close() { handle.alive = false; },
    };
    opened.push(handle);
    return handle;
  };
  const pool = new ChatLiveSessions({ maxSessions: 4 });
  let seenInPool = null;

  await pool.run({ chatKey: 'c1', executor, model: 'a' }, {
    message: 'раз',
    onSessionCreated: () => { seenInPool = pool.stats()[0]?.sessionId ?? null; },
  });
  assert.equal(seenInPool, 'sid-early', 'пул знает id ещё до конца хода');

  await pool.closeAll();
});

test('сжатие выжимкой гасит живую сессию, и следующий ход начинается с чистой', async (t) => {
  const fixture = await apiFixture(t);
  const chatKey = await fixture.chat();
  const first = await fixture.turn(chatKey);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().sessionId, 'sid-live');

  // Исполнитель без родного компакта: сервер просит выжимку у той же живой сессии.
  const compacted = await fixture.app.inject({
    method: 'POST',
    url: '/api/chat/compact',
    payload: {
      chatKey,
      modelRef: { provider: 'claude', model: 'claude-test' },
      model: 'claude-test',
      mode: 'plan',
      sessionId: 'sid-live',
    },
  });
  assert.equal(compacted.statusCode, 200, compacted.body);
  assert.equal(compacted.json().compact.kind, 'summary');
  assert.equal(compacted.json().compact.seed, 'ок', 'выжимка — это ответ исполнителя на запрос сжатия');
  assert.equal(compacted.json().sessionId, null, 'id старого разговора наружу не уходит');
  assert.equal(fixture.handles.length, 1, 'выжимку писал тот же процесс, что вёл разговор');
  assert.equal(fixture.handles[0].closed, true, 'процесс со старым разговором погашен вместе с ним');

  // Окно после выжимки шлёт пустой sessionId — это «начни заново», а не «окно ещё не
  // знает id»: пул не должен поднять прежний разговор с полным контекстом под выжимку.
  const next = await fixture.turn(chatKey, { sessionId: null, message: '[Выжимка…]\n\nпродолжай' });
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(fixture.handles.length, 2, 'следующий ход поднял новый процесс');
  assert.equal(fixture.handles[1].openedWith, null, 'новый процесс стартует без прежнего id сессии');
  assert.equal(fixture.handles[1].closed, false);
});

test('сброс памяти гасит живую сессию исполнителя без binding, следующий ход чистый', async (t) => {
  const fixture = await apiFixture(t);
  const chatKey = await fixture.chat();
  const first = await fixture.turn(chatKey);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(fixture.handles[0].alive, true, 'после хода процесс живёт и помнит разговор');

  // Окно обнулило sessionId у себя, но память лежит в процессе на сервере: без этого
  // вызова следующий ход поднял бы тот же процесс, и «сброс» ничего бы не сбросил.
  const reset = await fixture.app.inject({
    method: 'POST',
    url: '/api/chat/session/reset',
    payload: { chatKey, modelRef: { provider: 'claude', model: 'claude-test' } },
  });
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal(reset.json().reset, true, 'сервер подтверждает, что гасить было что');
  assert.equal(fixture.handles[0].closed, true, 'процесс со старым разговором погашен');

  const next = await fixture.turn(chatKey, { sessionId: null, message: 'с чистого листа' });
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(fixture.handles.length, 2, 'следующий ход поднял новый процесс');
  assert.equal(fixture.handles[1].openedWith, null, 'новый процесс стартует без прежнего id');
});

/**
 * Реестр с записываемыми событиями и управляемым временем.
 * Предсказуемые id позволяют различать публикацию соседних фоновых циклов.
 */
function registry({ managed = new Set(), hidden = ['/data/chats/attachments'] } = {}) {
  const events = [];
  let clock = 1000;
  let seq = 0;
  const runs = new ChatBackgroundRuns({
    broadcast: (event, data) => events.push({ event, data }),
    hiddenDirs: hidden,
    managedActive: (key) => managed.has(key),
    queuedCount: () => 0,
    now: () => clock,
    newRunId: () => `run-bg${++seq}`,
  });

  return {
    runs,
    events,
    managed,
    tick: (ms) => {
      clock += ms;
    },
  };
}

/**
 * Тест сам управляет моментом завершения или сбоя записи pending.
 * Внешние resolve и reject позволяют проверить барьер публикации без тайминга.
 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

const ID_A = {
  chatKey: 'c1',
  sessionToken: 'live-a',
  backgroundId: 'bg-1',
};
const ID_B = {
  chatKey: 'c1',
  sessionToken: 'live-a',
  backgroundId: 'bg-2',
};
const SESSION = {
  executorId: 'claude',
  model: 'm1',
  cwd: '/w',
  extraDirs: ['/w/extra', '/data/chats/attachments'],
};
const pause = () => new Promise((resolve) => setImmediate(resolve));

test('реестр: фоновый ход получает runId и снимок процесса без папки вложений', () => {
  const { runs, events } = registry();

  assert.equal(runs.start(ID_A, SESSION), 'run-bg1');
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'chat-turn-start');
  assert.equal(events[0].data.source, 'background');
  assert.equal(events[0].data.runId, 'run-bg1');
  assert.deepEqual(events[0].data.snapshot.extraDirs, ['/w/extra']);
  assert.equal(events[0].data.snapshot.requestedModelId, 'm1');
  assert.equal(runs.start(ID_A, SESSION), 'run-bg1');
  assert.equal(events.length, 1);

  for (const field of ['executorId', 'model', 'cwd']) {
    const next = registry();

    next.runs.start(ID_A, { ...SESSION, [field]: '' });
    assert.equal(next.events[0].data.snapshot, null);
  }
});

test('реестр: шаги и метрики несут runId и source, list отдаёт последние метрики', () => {
  const { runs, events, tick } = registry();

  runs.start(ID_A, SESSION);
  runs.step(ID_A, {
    k: 'tool',
    id: 's1',
    at: 1,
  });
  runs.progress(ID_A, 7, {
    tokensIsEstimate: true,
    contextTokens: 900,
    contextMetric: 'active-input-v1',
  });
  runs.progress(ID_A, 8, { tokensIsEstimate: false });
  tick(500);
  assert.equal(events.length, 4);

  for (const event of events.slice(1)) {
    assert.equal(event.data.runId, 'run-bg1');
    assert.equal(event.data.source, 'background');
  }

  const live = runs.list()[0];

  assert.equal(live.tokens, 8);
  assert.equal(live.tokensIsEstimate, false);
  assert.equal(live.contextTokens, 900);
  assert.equal(live.steps.length, 1);
  assert.equal(live.elapsedMs, 500);
  assert.equal(live.compact, false);
  live.steps.push({ k: 'tool' });
  assert.equal(runs.list()[0].steps.length, 1);
  runs.step({ ...ID_A, backgroundId: 'absent' }, { k: 'tool' });
  assert.equal(events.length, 4);
});

test('реестр: публикация A не закрывает фон B, дубли не рассылают событий', async () => {
  const { runs, events } = registry();

  runs.start(ID_A, SESSION);

  const release = deferred();
  const pA = runs.publish(ID_A, () => release.promise);

  assert.equal(runs.start(ID_B, SESSION), 'run-bg2');

  let duplicateCalls = 0;

  await runs.publish(ID_A, () => {
    duplicateCalls += 1;
  });
  assert.equal(duplicateCalls, 0);
  release.resolve();
  await pA;

  const done = events.filter((e) => e.event === 'chat-done');

  assert.equal(done.length, 1);
  assert.equal(done[0].data.runId, 'run-bg1');
  assert.equal(runs.has('c1'), true);
  assert.equal(runs.runningIdentity('c1').runId, 'run-bg2');
});

test('реестр: закрытие процесса во время публикации ждёт её конца, сбой записи не изображает доставку',
  async () => {
    const { runs, events } = registry();

    runs.start(ID_A, SESSION);

    const release = deferred();
    const pA = runs.publish(ID_A, () => release.promise);

    runs.closeSession('live-a');
    assert.equal(events.filter((e) => e.event === 'chat-done').length, 0);
    release.reject(new Error('диск'));
    await pA;
    assert.equal(events.filter((e) => e.event === 'chat-done').length, 1);
    assert.equal(events.some((e) => e.event === 'chat-orphan'), false);
    assert.equal(runs.has('c1'), false);
    runs.start(ID_B, SESSION);
    runs.closeSession('live-a');
    assert.equal(events.at(-1).data.runId, 'run-bg2');

    const count = events.length;

    runs.closeSession('live-a');
    assert.equal(events.length, count);
  });

test('реестр: ожидание учитывает публикацию, hide и reveal возвращают тот же runId', async () => {
  const { runs, events, managed, tick } = registry();

  managed.add('c1');
  runs.start(ID_A, SESSION);
  assert.equal(events.length, 0);
  managed.delete('c1');
  runs.step(ID_A, {
    k: 'tool',
    id: 's1',
    at: 1,
  });
  tick(1000);
  runs.reveal('c1');
  assert.equal(events.length, 1);
  assert.equal(events[0].data.restored, true);
  assert.equal(events[0].data.runId, 'run-bg1');
  assert.equal(events[0].data.elapsedMs, 1000);
  assert.equal(events[0].data.steps.length, 1);
  runs.reveal('c1');
  assert.equal(events.length, 1);
  runs.hide('c1');
  runs.step(ID_A, {
    k: 'tool',
    id: 's2',
    at: 2,
  });
  assert.equal(events.length, 1);

  let idle = false;
  const waiting = runs.waitUntilIdle('c1').then(() => {
    idle = true;
  });
  const release = deferred();
  const publishing = runs.publish(ID_A, () => release.promise);

  await pause();
  assert.equal(idle, false);
  release.resolve();
  await publishing;
  await waiting;
  assert.equal(idle, true);
  runs.reveal('c1');
  assert.equal(events.filter((e) => e.event === 'chat-turn-start').length, 1);
});

test('реестр: visibleExtraDirs сравнивает по resolve и не мутирует вход', () => {
  const dirs = ['/a/b/../c', '/x'];

  assert.deepEqual(visibleExtraDirs(dirs, ['/a/c']), ['/x']);
  assert.deepEqual(dirs, ['/a/b/../c', '/x']);
});

// Поддельный CLI ведёт себя как настоящий в той части, что важна для фона: пока идёт ход
// (в том числе фоновый), новые user-строки он ставит в очередь и берёт после result.
// SIGUSR1 открывает фон, SIGUSR2 закрывает его result-ом «ФОН ГОТОВ», interrupt при
// открытом фоне закрывает его result-ом error_during_execution с пустым текстом.
// Каждая принятая user-строка пишется в trace-файл в момент приёма.
const BG_SIGNAL_CLI = `
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const trace = process.env.PROBE_TRACE;
const sid = 'sid-signal';
const say = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
const queue = [];
let busy = false;

function answer(text) {
  say({
    type: 'assistant',
    session_id: sid,
    message: { id: 'm-' + text, content: [{ type: 'text', text }] },
  });
  say({ type: 'result', subtype: 'success', session_id: sid, result: text, num_turns: 1 });
}

function take(text) {
  if (text === 'СЛУЖЕБНОЕ') {
    answer('ок');
    say({ type: 'system', subtype: 'status', session_id: sid });
    say({ type: 'rate_limit_event', session_id: sid });
    return;
  }
  if (text === 'ВЛОЖЕННОЕ') {
    answer('ок');
    say({
      type: 'assistant',
      session_id: sid,
      parent_tool_use_id: 'tool-1',
      message: { id: 'm-child', content: [{ type: 'text', text: 'дочерний' }] },
    });
    return;
  }
  answer('ок:' + text);
}

function drain() {
  while (!busy && queue.length) take(queue.shift());
}

process.on('SIGUSR1', () => {
  busy = true;
  say({
    type: 'assistant',
    session_id: sid,
    message: { id: 'm-bg', content: [{ type: 'text', text: 'фон: работаю' }] },
  });
});

process.on('SIGUSR2', () => {
  say({ type: 'result', subtype: 'success', session_id: sid, result: 'ФОН ГОТОВ', num_turns: 1 });
  busy = false;
  drain();
});

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === 'control_request') {
    say({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
    if (msg.request?.subtype === 'interrupt' && busy) {
      say({ type: 'result', subtype: 'error_during_execution', session_id: sid, result: '', num_turns: 1 });
      busy = false;
      drain();
    }
    return;
  }
  const text = msg.message?.content?.[0]?.text || '';
  appendFileSync(trace, JSON.stringify({ user: text }) + '\\n');
  if (busy) {
    queue.push(text);
    return;
  }
  take(text);
});
`;

/**
 * Поднимает поддельный CLI на сигналах во временном каталоге и прибирает его после теста.
 * Возвращает сессию транспорта, журналы hooks и путь trace для users().
 */
async function openSignalFake(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-bg-signal-'));
  const file = path.join(dir, 'cli.mjs');
  const trace = path.join(dir, 'trace.jsonl');
  const background = [];
  const backgroundStarts = [];
  const exits = [];
  let started = () => {};
  const firstStart = new Promise((resolve) => {
    started = resolve;
  });

  await writeFile(file, BG_SIGNAL_CLI);

  const session = openClaudeStreamSession({
    bin: process.execPath,
    args: [file],
    cwd: os.tmpdir(),
    env: { ...process.env, PROBE_TRACE: trace },
    hooks: {
      onBackgroundStart: () => {
        backgroundStarts.push(Date.now());
        started();
      },
      onBackground: (result) => {
        background.push(result);
      },
      onExit: (event) => {
        exits.push(event);
      },
    },
  });

  t.after(async () => {
    await session.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  return {
    session,
    trace,
    background,
    backgroundStarts,
    exits,
    firstStart,
  };
}

/** Какие user-строки поддельный CLI уже принял, в порядке приёма. */
/**
 * Читает только trace поддельного CLI, созданного этим тестом.
 * До первой записи отсутствие файла означает, что ввод ещё не принят.
 */
async function users(trace) {
  try {
    return (await readFile(trace, 'utf8')).split('\n').filter(Boolean)
      .map((line) => JSON.parse(line).user);
  } catch {
    return [];
  }
}

/** Ждёт условия не дольше deadline: провал зависшего теста, а не доказательство порядка. */
/**
 * Ограниченно ждёт событие тестового процесса без вечного зависания.
 * Пауза служит ожиданием готовности, а порядок доказывают отдельные assert.
 */
async function waitUntil(check, deadlineMs = 2000) {
  const started = Date.now();

  while (!check()) {
    if (Date.now() - started > deadlineMs) {
      throw new Error('условие не наступило за отведённое время');
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

test('фон не отдаёт свой result следующему send и не получает выдуманный итог', async (t) => {
  const f = await openSignalFake(t);

  await f.session.send({ message: 'первый' });
  process.kill(f.session.pid, 'SIGUSR1');
  await f.firstStart;

  const second = f.session.send({ message: 'второй' });

  await new Promise((resolve) => setTimeout(resolve, 100));

  const received = await users(f.trace);
  // Сначала снимаем блокировку, чтобы RED тоже завершил свой CLI.
  process.kill(f.session.pid, 'SIGUSR2');

  const result = await second;

  assert.deepEqual(received, ['первый']);
  assert.equal(result.reply, 'ок:второй');
  assert.deepEqual(f.background.map((r) => r.reply), ['ФОН ГОТОВ']);
});

test('стоп во время ожидания send прерывает фон и не пишет отменённый ввод', async (t) => {
  const f = await openSignalFake(t);

  await f.session.send({ message: 'первый' });
  process.kill(f.session.pid, 'SIGUSR1');
  await f.firstStart;

  const second = f.session.send({ message: 'второй' });
  const outcome = second.then(() => null, (e) => e);

  await f.session.interrupt();
  assert.equal((await outcome)?.stopped, true);
  await waitUntil(() => f.background.length === 1);
  assert.equal(f.background[0].stopped, true);
  assert.equal(f.background[0].reply, '⏹ Ход остановлен.');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await users(f.trace), ['первый']);
  assert.equal(f.session.alive, true);
});

test('смерть процесса во время фона разблокирует send без выдуманного ответа', async (t) => {
  const f = await openSignalFake(t);

  await f.session.send({ message: 'первый' });
  process.kill(f.session.pid, 'SIGUSR1');
  await f.firstStart;

  const second = f.session.send({ message: 'второй' });
  const outcome = second.then(() => null, (e) => e);

  process.kill(f.session.pid, 'SIGTERM');
  assert.ok(await outcome);
  assert.equal(f.background.length, 0);
  await waitUntil(() => f.exits.length === 1);
});

for (const [name, input] of [
  ['служебные события вне хода не открывают фон и не задерживают send', 'СЛУЖЕБНОЕ'],
  ['вложенное событие субагента вне хода не открывает фон', 'ВЛОЖЕННОЕ'],
]) {
  test(name, async (t) => {
    const f = await openSignalFake(t);

    assert.equal((await f.session.send({ message: input })).reply, 'ок');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(f.backgroundStarts.length, 0);
    assert.equal((await f.session.send({ message: 'после' })).reply, 'ок:после');
    assert.equal(f.background.length, 0);
  });
}

test('конкурентный send во время ожидания фона отклоняется', async (t) => {
  const f = await openSignalFake(t);

  await f.session.send({ message: 'первый' });
  process.kill(f.session.pid, 'SIGUSR1');
  await f.firstStart;

  const second = f.session.send({ message: 'второй' });

  await assert.rejects(f.session.send({ message: 'третий' }), /уже идёт ход/);
  process.kill(f.session.pid, 'SIGUSR2');
  assert.equal((await second).reply, 'ок:второй');
});

/**
 * Изолирует пул и его события без настоящего исполнителя.
 * Каждый тест закрывает созданные им процессы через lifecycle теста.
 */
function poolFixture(t, options = {}) {
  const opened = [];
  const starts = [];
  const closed = [];
  const changes = [];
  const executor = fakeExecutor({ opened });
  const pool = new ChatLiveSessions({
    ...options,
    onBackgroundStart: (event) => starts.push(event),
    onSessionClosed: (event) => closed.push(event),
    onChange: (event) => changes.push(event),
  });

  t.after(() => pool.closeAll());

  return {
    opened,
    starts,
    closed,
    changes,
    executor,
    pool,
  };
}

test('пул сообщает старт фона с поколением и параметрами процесса', async (t) => {
  const f = poolFixture(t);

  await f.pool.run({
    chatKey: 'c1',
    executor: f.executor,
    model: 'a',
    cwd: '/w',
    extraDirs: ['/d'],
  }, {});

  const hooks = f.opened[0].spec.hooks;

  hooks.onBackgroundStart();
  hooks.onBackgroundStart();
  assert.equal(f.starts.length, 1);
  assert.match(f.starts[0].identity.sessionToken, /^live-/);
  assert.match(f.starts[0].identity.backgroundId, /^bg-/);
  assert.deepEqual(f.starts[0].session, {
    executorId: 'fake',
    model: 'a',
    cwd: '/w',
    extraDirs: ['/d'],
  });
  await hooks.onBackground({ reply: 'ф', steps: [] });
  hooks.onBackgroundStart();
  assert.notEqual(f.starts[0].identity.backgroundId, f.starts[1].identity.backgroundId);
  assert.equal(f.changes.filter((e) => e.event === 'busy').length, 3);
});

test('фон держит процесс занятым: простой, вытеснение и массовое гашение его не трогают', async (t) => {
  const f = poolFixture(t, { maxSessions: 2 });

  await f.pool.run({ chatKey: 'c1', executor: f.executor }, {});
  f.opened[0].spec.hooks.onBackgroundStart();
  assert.equal(f.pool.stats()[0].busy, true);
  assert.equal(f.pool.stats()[0].idleAtMs, null);
  await f.pool.run({ chatKey: 'c2', executor: f.executor }, {});
  await f.pool.run({ chatKey: 'c3', executor: f.executor }, {});
  assert.equal(f.opened[1].closed, true);
  assert.equal(f.opened[0].alive, true);
  await f.opened[0].spec.hooks.onBackground({ reply: 'ф', steps: [] });
  assert.equal(f.pool.stats().find((e) => e.chatKey === 'c1').busy, false);
  assert.equal(typeof f.pool.stats().find((e) => e.chatKey === 'c1').idleAtMs, 'number');
});

test('managed result и старт фона одним буфером: finally пула не снимает занятость фона', async (t) => {
  const f = poolFixture(t);
  const open = f.executor.session.open;

  f.executor.session.open = (spec) => {
    const handle = open(spec);

    handle.send = async () => {
      spec.hooks.onBackgroundStart();

      return { reply: 'ответ' };
    };

    return handle;
  };
  await f.pool.run({ chatKey: 'c1', executor: f.executor }, {});
  assert.equal(f.pool.stats()[0].busy, true);
});

test('смена параметров ждёт конца фона, а не убивает его', async (t) => {
  const f = poolFixture(t);

  await f.pool.run({
    chatKey: 'c1',
    executor: f.executor,
    model: 'a',
  }, {});
  f.opened[0].spec.hooks.onBackgroundStart();

  const next = f.pool.run({
    chatKey: 'c1',
    executor: f.executor,
    model: 'b',
  }, {});

  await pause();
  await pause();
  await pause();

  const before = { closed: f.opened[0].closed, count: f.opened.length };

  await f.opened[0].spec.hooks.onBackground({ reply: 'ф', steps: [] });
  await next;
  assert.deepEqual(before, { closed: false, count: 1 });
  assert.equal(f.opened[0].closed, true);
  assert.equal(f.opened.length, 2);
});

test('поздний exit старой entry не трогает фон новой', async (t) => {
  const f = poolFixture(t);

  await f.pool.run({
    chatKey: 'c1',
    executor: f.executor,
    model: 'a',
  }, {});
  f.opened[0].spec.hooks.onBackgroundStart();
  await f.opened[0].spec.hooks.onBackground({ reply: 'ф' });
  await f.pool.run({
    chatKey: 'c1',
    executor: f.executor,
    model: 'b',
  }, {});
  f.opened[1].spec.hooks.onBackgroundStart();
  f.opened[0].spec.hooks.onExit({ reason: 'поздний' });
  assert.equal(f.closed.length, 1);
  assert.equal(f.starts.length, 2);
  assert.equal(f.closed[0].sessionToken, f.starts[0].identity.sessionToken);
  assert.equal(f.pool.stats()[0].busy, true);
});

test('close и closeAll сообщают о закрытии ровно один раз даже без exit hook', async (t) => {
  const f = poolFixture(t);

  await f.pool.run({ chatKey: 'c1', executor: f.executor }, {});
  await f.pool.run({ chatKey: 'c2', executor: f.executor }, {});
  f.opened[0].spec.hooks.onBackgroundStart();
  await f.pool.close('c1');
  assert.equal(f.closed.length, 1);
  await f.pool.closeAll();
  assert.equal(f.closed.length, 2);
  assert.equal(new Set(f.closed.map((e) => e.sessionToken)).size, 2);
});

test('стоп управляемого хода во время ожидания фона не отправляет ход', async (t) => {
  const f = poolFixture(t);

  await f.pool.run({
    chatKey: 'c1',
    executor: f.executor,
    model: 'a',
  }, { message: 'раз' });

  const before = f.opened[0].sends;

  f.opened[0].spec.hooks.onBackgroundStart();

  const ac = new AbortController();
  const pending = f.pool.run({
    chatKey: 'c1',
    executor: f.executor,
    model: 'a',
    signal: ac.signal,
  }, {});
  const outcome = pending.then(() => null, (e) => e);

  ac.abort();
  await f.opened[0].spec.hooks.onBackground({ reply: 'фон' });
  assert.equal((await outcome)?.stopped, true);
  assert.equal(f.opened[0].sends, before);
});

test('interruptBackground прерывает только своё поколение', async (t) => {
  const f = poolFixture(t);

  await f.pool.run({
    chatKey: 'c1',
    executor: f.executor,
    model: 'a',
  }, {});
  f.opened[0].spec.hooks.onBackgroundStart();
  await f.opened[0].spec.hooks.onBackground({ reply: 'ф' });
  await f.pool.run({
    chatKey: 'c1',
    executor: f.executor,
    model: 'b',
  }, {});
  f.opened[1].spec.hooks.onBackgroundStart();
  assert.equal(typeof f.pool.interruptBackground, 'function');
  assert.equal(f.pool.interruptBackground(f.starts[0].identity), false);
  assert.equal(f.opened[1].interrupted, 0);
  assert.equal(f.pool.interruptBackground(f.starts[1].identity), true);
  assert.equal(f.opened[1].interrupted, 1);
});

// Поддельный CLI с протоколом настоящего: lifecycle queued/started по command_uuid, повтор
// реплики с её uuid и result с user_message_uuid. Ввод во время чужого хода CLI ставит в
// очередь. SIGUSR1 будит модель так, как это делает CLI после фоновой задачи: сначала
// служебные события (с system/init или без него — WAKE_INIT), а содержательные приходят
// позже; SIGUSR2 — ответ и result проснувшегося хода.
const WAKE_CLI = `
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const trace = process.env.PROBE_TRACE;
const sid = 'sid-wake';
const say = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
const queue = [];
let busy = false;

function take({ text, uuid }) {
  const reply = [{ type: 'text', text: 'ок:' + text }];
  say({ type: 'command_lifecycle', state: 'started', command_uuid: uuid });
  say({ type: 'system', subtype: 'init', session_id: sid });
  say({ type: 'user', isReplay: true, uuid, message: { role: 'user', content: [{ type: 'text', text }] } });
  say({ type: 'assistant', session_id: sid, message: { id: 'm-' + text, content: reply } });
  say({ type: 'result', subtype: 'success', session_id: sid, result: 'ок:' + text, num_turns: 1,
    user_message_uuid: uuid });
  say({ type: 'command_lifecycle', state: 'completed', command_uuid: uuid });
}

function drain() {
  while (!busy && queue.length) take(queue.shift());
}

process.on('SIGUSR1', () => {
  busy = true;
  say({ type: 'system', subtype: 'task_notification', status: 'completed', session_id: sid });
  if (process.env.WAKE_INIT === '1') say({ type: 'system', subtype: 'init', session_id: sid });
  say({ type: 'system', subtype: 'thinking_tokens', session_id: sid });
});

process.on('SIGUSR2', () => {
  const content = [{ type: 'text', text: 'ФОН ГОТОВ' }];
  say({ type: 'assistant', session_id: sid, message: { id: 'm-bg', content } });
  say({ type: 'result', subtype: 'success', session_id: sid, result: 'ФОН ГОТОВ', num_turns: 1 });
  busy = false;
  drain();
});

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === 'control_request') {
    say({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
    return;
  }
  const text = msg.message?.content?.[0]?.text || '';
  appendFileSync(trace, JSON.stringify({ user: text, busy }) + '\\n');
  say({ type: 'command_lifecycle', state: 'queued', command_uuid: msg.uuid });
  if (busy) {
    queue.push({ text, uuid: msg.uuid });
    return;
  }
  take({ text, uuid: msg.uuid });
});
`;

/**
 * Поднимает CLI с протоколом lifecycle во временном каталоге и прибирает его после теста.
 * `wakeInit` решает, начинается ли пробуждение с system/init.
 */
async function openWakeFake(t, { wakeInit }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-bg-wake-'));
  const file = path.join(dir, 'cli.mjs');
  const trace = path.join(dir, 'trace.jsonl');
  const background = [];
  const backgroundStarts = [];

  await writeFile(file, WAKE_CLI);

  const session = openClaudeStreamSession({
    bin: process.execPath,
    args: [file],
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      PROBE_TRACE: trace,
      WAKE_INIT: wakeInit ? '1' : '0',
    },
    hooks: {
      onBackgroundStart: () => {
        backgroundStarts.push(Date.now());
      },
      onBackground: (result) => {
        background.push(result);
      },
    },
  });

  t.after(async () => {
    await session.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  return {
    session,
    trace,
    background,
    backgroundStarts,
  };
}

test('пробуждение с system/init сразу занимает процесс: ввод ждёт итога фона', async (t) => {
  const f = await openWakeFake(t, { wakeInit: true });

  assert.equal((await f.session.send({ message: 'первый' })).reply, 'ок:первый');
  process.kill(f.session.pid, 'SIGUSR1');
  await waitUntil(() => f.backgroundStarts.length === 1);

  const second = f.session.send({ message: 'второй' });

  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });
  assert.deepEqual(await users(f.trace), ['первый'], 'ввод не ушёл в CLI, пока идёт фон');
  process.kill(f.session.pid, 'SIGUSR2');
  assert.equal((await second).reply, 'ок:второй');
  assert.deepEqual(f.background.map((result) => result.reply), ['ФОН ГОТОВ']);
});

test('ввод, принятый CLI в очередь посреди пробуждения, не получает чужой ответ', async (t) => {
  const f = await openWakeFake(t, { wakeInit: false });

  assert.equal((await f.session.send({ message: 'первый' })).reply, 'ок:первый');
  process.kill(f.session.pid, 'SIGUSR1');
  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });

  // Служебные события без system/init фон не открывают: ввод уходит в CLI и ждёт там.
  const second = f.session.send({ message: 'второй' });

  await waitUntil(() => f.backgroundStarts.length === 0);
  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });
  process.kill(f.session.pid, 'SIGUSR2');
  assert.equal((await second).reply, 'ок:второй');
  await waitUntil(() => f.background.length === 1);
  assert.deepEqual(f.background.map((result) => result.reply), ['ФОН ГОТОВ']);
});

test('новый процесс чата поднимается только после закрытия прежнего', async (t) => {
  const f = poolFixture(t);
  let finishClose = () => {};

  await f.pool.run({
    chatKey: 'c1',
    executor: f.executor,
    model: 'a',
  }, {});
  f.opened[0].close = () => new Promise((resolve) => {
    finishClose = () => {
      f.opened[0].alive = false;
      resolve();
    };
  });

  const closing = f.pool.close('c1', 'фоновый ход не ответил на стоп');
  const next = f.pool.run({
    chatKey: 'c1',
    executor: f.executor,
    model: 'a',
  }, {});

  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }

  assert.equal(f.opened.length, 1, 'второй CLI не стартует, пока первый жив');
  finishClose();
  await closing;
  await next;
  assert.equal(f.opened.length, 2);
});

test('фоновый ход виден как обычный запуск с собственным runId', async (t) => {
  const f = await apiFixture(t);
  const key = await f.chat();

  await f.turn(key);

  const hooks = f.handles[0].spec.hooks;

  hooks.onBackgroundStart();
  hooks.onBackgroundStep({
    k: 'text',
    text: 'фон',
    at: 1,
  });
  hooks.onBackgroundProgress(7, {
    tokensIsEstimate: false,
    contextTokens: 900,
    contextMetric: 'active-input-v1',
  });

  const events = f.events.filter((e) => e.data.source === 'background');

  assert.deepEqual(events.map((e) => e.event), ['chat-turn-start', 'chat-step', 'chat-progress']);

  const runId = events[0].data.runId;

  assert.match(runId, /^run-/);
  assert.ok(events.every((e) => e.data.runId === runId));
  assert.equal(events[0].data.snapshot.requestedModelId, 'claude-test');
  assert.equal(events[0].data.snapshot.cwd, f.handles[0].spec.cwd);

  const active = (await f.app.inject('/api/chat/active')).json().active;

  assert.equal(active.length, 1);
  assert.equal(active[0].source, 'background');
  assert.equal(active[0].tokens, 7);
  assert.equal(active[0].contextTokens, 900);
  assert.equal(active[0].steps.length, 1);
  assert.equal(Object.hasOwn(active[0], 'turnId'), false);
  assert.equal(Object.hasOwn(active[0], 'inTurn'), false);
});

test('итог фона пишется в pending с runId и source раньше chat-done', async (t) => {
  const f = await apiFixture(t);
  const key = await f.chat();

  await f.turn(key);

  const hooks = f.handles[0].spec.hooks;

  hooks.onBackgroundStart();
  await hooks.onBackground({ reply: 'фон готов', steps: [] });

  const bg = f.events.filter((e) => e.data.source === 'background');

  assert.deepEqual(bg.map((e) => e.event), ['chat-turn-start', 'chat-orphan', 'chat-done']);
  assert.ok(bg.every((e) => e.data.runId === bg[0].data.runId));

  const pending = (await f.app.inject('/api/chat/pending')).json().pending;

  assert.equal(pending.length, 1);
  assert.equal(pending[0].reply, 'фон готов');
  assert.equal(pending[0].runId, bg[0].data.runId);
  assert.equal(pending[0].source, 'background');
  assert.equal(pending[0].unsolicited, true);
  assert.equal(pending[0].role, 'assistant');
  assert.deepEqual((await f.app.inject('/api/chat/active')).json().active, []);
});

test('сбой записи итога фона не изображает доставку', async (t) => {
  const f = await apiFixture(t);
  const key = await f.chat();

  await f.turn(key);
  f.handles[0].spec.hooks.onBackgroundStart();
  await writeFile(path.join(f.root, 'chats', 'pending'), 'x');
  await f.handles[0].spec.hooks.onBackground({ reply: 'фон готов', steps: [] });
  assert.equal(f.events.some((e) => e.event === 'chat-orphan'), false);
  assert.equal(f.events.filter((e) => e.event === 'chat-done' && e.data.source === 'background').length, 1);
  assert.deepEqual((await f.app.inject('/api/chat/active')).json().active, []);
});


test('пул держит один обработчик квот на процесс, включая простой и ошибку обработчика', async (t) => {
  const opened = [];
  const executor = fakeExecutor({ opened });
  const pool = new ChatLiveSessions();
  const first = [];
  const next = [];
  const patch = { bars: [{
    key: 'session',
    pct: 8,
    resetsAt: null
  }] };
  const spec = {
    chatKey: 'usage-process',
    executor,
    model: 'a',
    onProviderUsage: (value) => {
      first.push(value);

      return true;
    },
  };

  t.after(() => pool.closeAll());
  await pool.run(spec, { message: 'один' });
  await pool.run({
    ...spec,
    onProviderUsage: (value) => {
      next.push(value);

      return true;
    },
  }, { message: 'два' });
  assert.equal(opened.length, 1);
  assert.equal(typeof opened[0].spec.hooks.onProviderUsage, 'function');
  assert.equal(opened[0].spec.hooks.onProviderUsage(patch), true);
  assert.deepEqual(first, [patch], 'в простое используется обработчик первого spec');
  assert.deepEqual(next, []);

  await pool.run({
    ...spec,
    model: 'b',
    onProviderUsage: () => {
      throw new Error('fixture-sink-error');
    },
  }, { message: 'три' });
  assert.equal(opened.length, 2);
  assert.doesNotThrow(() => opened[1].spec.hooks.onProviderUsage(patch));
  assert.equal(opened[1].alive, true);
  assert.equal((await pool.run({ ...spec, model: 'b' }, { message: 'четыре' })).reply, 'ответ:четыре');
});


test('модуль чата передаёт обработчик аккаунта в spec без привязки к завершённому runId', async (t) => {
  const calls = [];
  let factories = 0;
  const f = await apiFixture(t, {
    providerUsageSink: (id) => {
      const number = ++factories;

      return (patch) => {
        calls.push({
          id,
          number,
          patch
        });

        return true;
      };
    },
  });
  const chatKey = await f.chat('usage-module');

  await f.turn(chatKey);
  await f.turn(chatKey);

  const patch = { bars: [{
    key: 'session',
    pct: 8,
    resetsAt: null
  }] };

  assert.equal(f.handles.length, 1);
  assert.equal(f.handles[0].spec.hooks.onProviderUsage(patch), true);
  assert.deepEqual(calls, [{
    id: 'claude',
    number: 1,
    patch
  }]);
});


test('partial-флаг включён у живой сессии Claude', () => {
  assert.equal(claudeSessionArgs({ permissionMode: 'default' }).includes('--include-partial-messages'), true);
});

// AC3–5, AC13–14: сон остаётся состоянием процесса, отдельно от занятости ходом.
const sleepingTasks = [
  {
    id: 'agent-1',
    kind: 'subagent',
    description: 'Проверяет документ',
  },
];

/**
 * Сигнал идёт через тот же process hook, который получит нейтральный список адаптера.
 * На исходнике отсутствие hook оставляет наблюдаемое состояние неизменным, без TypeError.
 */
function reportTasks(handle, tasks = sleepingTasks) {
  handle.spec.hooks.onBackgroundTasks?.(structuredClone(tasks));
}

/**
 * Снимок читается через публичный API, как в независимом окне после F5.
 * Проверка HTTP отделяет ошибку фикстуры от отсутствующего поля сна.
 */
async function sleepSessions(app) {
  const response = await app.inject({ method: 'GET', url: '/api/chat/sessions' });

  assert.equal(response.statusCode, 200, response.body);

  return response.json().sessions;
}

test('SLEEP-BASE-01: пустая сессия закрывается настоящим таймером простоя', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const f = poolFixture(t, { idleMs: 60_000 });

  await f.pool.run({ chatKey: 'idle', executor: f.executor }, {});
  assert.equal(f.pool.has('idle'), true);
  t.mock.timers.tick(60_001);
  await Promise.resolve();

  assert.equal(f.pool.has('idle'), false);
  assert.equal(f.opened[0].closed, true);
  assert.equal(f.closed.length, 1);
});

test('SLEEP-01: снимок переживает result, сон скрыт внутри managed и фонового хода', async (t) => {
  const f = poolFixture(t);
  const spec = { chatKey: 'sleep', executor: f.executor };

  await f.pool.run(spec, {});

  const handle = f.opened[0];
  const during = [];

  handle.send = async () => {
    reportTasks(handle);
    during.push(f.pool.stats()[0]);

    return { reply: 'Жду результаты' };
  };
  await f.pool.run(spec, {});

  assert.equal(during[0].sleeping, false, 'заказанный ход ещё идёт');
  assert.deepEqual(during[0].backgroundTasks, sleepingTasks);
  assert.equal(f.pool.stats()[0].sleeping, true, 'result не удаляет фоновые задачи');
  assert.equal(f.pool.stats()[0].busy, false, 'сон не становится busy');

  during.length = 0;
  await f.pool.run(spec, {});

  assert.equal(during[0].sleeping, false, 'следующий managed send скрывает сон до пустого снимка');
  handle.spec.hooks.onBackgroundStart();
  assert.equal(f.pool.stats()[0].sleeping, false, 'самопробуждение скрывает сон до []');
  assert.equal(f.pool.stats()[0].busy, true);
  await handle.spec.hooks.onBackground({ reply: 'Готово' });
  assert.equal(f.pool.stats()[0].sleeping, true, 'непустой снимок сохраняется до явного обновления');
  reportTasks(handle, []);
  assert.equal(f.pool.stats()[0].sleeping, false);
  assert.deepEqual(f.pool.stats()[0].backgroundTasks, []);
});

test('SLEEP-02: сон защищён от простоя и LRU, снятие задач возвращает полный idle', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });

  const f = poolFixture(t, { idleMs: 60_000, maxSessions: 2 });
  const run = (chatKey) => f.pool.run({ chatKey, executor: f.executor }, {});

  await run('sleep-a');
  reportTasks(f.opened[0]);
  t.mock.timers.tick(60_001);
  await Promise.resolve();

  assert.equal(f.pool.has('sleep-a'), true, 'сон не гасится настоящим idle timer');
  assert.equal(f.pool.stats()[0].idleAtMs, null);
  await run('ordinary');
  await run('sleep-b');
  reportTasks(f.opened[2]);
  assert.equal(f.opened[1].closed, true, 'обычный свободный процесс вытеснен раньше спящего');
  assert.equal(f.opened[0].closed, false);
  await run('extra');
  assert.equal(f.pool.has('sleep-a'), true);
  assert.equal(f.pool.has('sleep-b'), true);
  assert.equal(f.pool.has('extra'), true, 'при всех защищённых мягкий потолок разрешает новый процесс');

  reportTasks(f.opened[0], []);

  const awake = f.pool.stats().find((entry) => entry.chatKey === 'sleep-a');

  assert.equal(awake.sleeping, false);
  assert.equal(awake.idleAtMs, Date.now() + 60_000, 'после [] начинается полный интервал');
  t.mock.timers.tick(30_000);
  reportTasks(f.opened[0], []);
  assert.equal(f.pool.stats().find((entry) => entry.chatKey === 'sleep-a').idleAtMs, awake.idleAtMs,
    'повторное [] не продлевает жизнь обычной сессии');
  t.mock.timers.tick(30_001);
  await Promise.resolve();
  assert.equal(f.pool.has('sleep-a'), false);
  assert.equal(f.pool.has('sleep-b'), true);

  reportTasks(f.opened[2], []);
  await run('replacement');
  await run('replacement-2');
  assert.equal(f.opened[2].closed, true, 'после [] процесс вновь участвует в LRU');
});

test('SLEEP-03: close, exit, новое поколение и новый пул очищают сон и старые callbacks', async (t) => {
  const f = poolFixture(t);
  const spec = {
    chatKey: 'sleep',
    executor: f.executor,
    model: 'a',
  };
  const open = f.executor.session.open;

  f.executor.session.open = (given) => {
    const handle = open(given);

    reportTasks(handle);

    return handle;
  };
  await f.pool.run(spec, {});
  assert.equal(f.pool.stats()[0].sleeping, true, 'синхронный снимок во время open не потерян');

  const old = f.opened[0];

  f.executor.session.open = open;
  await f.pool.run({ ...spec, model: 'b' }, {});
  assert.equal(old.closed, true);
  assert.equal(f.pool.stats()[0].sleeping, false);
  assert.deepEqual(f.pool.stats()[0].backgroundTasks, []);

  const changes = f.changes.length;

  reportTasks(old);
  assert.equal(f.changes.length, changes, 'поздний hook прежнего поколения не рассылает сон');
  assert.equal(f.pool.stats()[0].sleeping, false);
  reportTasks(f.opened[1]);
  await f.pool.close('sleep');
  reportTasks(f.opened[1]);
  assert.deepEqual(f.pool.stats(), []);
  await f.pool.run(spec, {});
  reportTasks(f.opened[2]);
  f.opened[2].alive = false;
  f.opened[2].spec.hooks.onExit({ reason: 'процесс умер' });
  assert.deepEqual(f.pool.stats(), []);
  reportTasks(f.opened[2]);
  assert.deepEqual(f.pool.stats(), []);
  await f.pool.run(spec, {});
  reportTasks(f.opened[3]);
  await f.pool.closeAll();
  reportTasks(f.opened[3]);
  assert.deepEqual(f.pool.stats(), []);

  const restarted = poolFixture(t);

  assert.deepEqual(restarted.pool.stats(), [], 'перезапуск сервера не восстанавливает процесс или сон');
});

for (const taskId of [null, '81234']) {
  test(`SLEEP-API-01: два окна видят сон и уведомления, taskId=${taskId}`, async (t) => {
    const f = await apiFixture(t, { taskId });
    const chatKey = await f.chat(`sleep-chat-${taskId || 'ordinary'}`);

    assert.notEqual(chatKey, taskId);

    const turn = await f.turn(chatKey);

    assert.equal(turn.statusCode, 200, turn.body);

    const before = f.events.filter((event) => event.event === 'chat-sessions').length;

    reportTasks(f.handles[0]);

    const first = (await sleepSessions(f.app))[0];
    const second = (await sleepSessions(f.app))[0];

    assert.equal(first.sleeping, true);
    assert.deepEqual(first.backgroundTasks, sleepingTasks);
    assert.equal(first.chatKey, chatKey);
    assert.equal(first.taskId, taskId);
    assert.deepEqual(first, second, 'проекция не принадлежит единственному окну');
    assert.ok(f.events.filter((event) => event.event === 'chat-sessions').length > before);

    const during = [];
    const handle = f.handles[0];

    handle.send = async () => {
      during.push((await sleepSessions(f.app))[0]);

      return {
        reply: 'Снова жду',
        sessionId: 'sid-live',
        steps: [],
      };
    };

    const beforeWake = f.events.filter((event) => event.event === 'chat-sessions').length;

    assert.equal((await f.turn(chatKey)).statusCode, 200);
    assert.equal(during[0].sleeping, false);
    assert.equal((await sleepSessions(f.app))[0].sleeping, true);
    assert.ok(f.events.filter((event) => event.event === 'chat-sessions').length >= beforeWake + 2,
      'окна узнают вход и выход из сна при managed send');
    reportTasks(handle, []);
    assert.equal((await sleepSessions(f.app))[0].sleeping, false);
  });
}

test('SLEEP-API-02: ручное гашение сохраняет разговор, рестарт не восстанавливает сон', async (t) => {
  const f = await apiFixture(t);
  const chatKey = await f.chat('sleep-manual');

  await f.turn(chatKey);
  reportTasks(f.handles[0]);
  assert.equal((await sleepSessions(f.app))[0].sleeping, true);

  const closed = await f.app.inject({ method: 'DELETE', url: `/api/chat/sessions/${chatKey}` });

  assert.equal(closed.statusCode, 200, closed.body);
  assert.equal(closed.json().forced, false);
  assert.equal(f.handles[0].closed, true);
  assert.deepEqual(await sleepSessions(f.app), []);
  assert.equal((await f.app.inject({ url: `/api/chat/store/chat/${chatKey}` })).statusCode, 200);
  await f.turn(chatKey);
  reportTasks(f.handles[1]);

  const all = await f.app.inject({ method: 'DELETE', url: '/api/chat/sessions' });

  assert.equal(all.statusCode, 200, all.body);
  assert.equal(all.json().closed, 1);
  assert.equal(f.handles[1].closed, true);
  assert.deepEqual(await sleepSessions(f.app), []);
  await f.turn(chatKey);
  reportTasks(f.handles[2]);
  assert.equal((await sleepSessions(f.app))[0].sleeping, true);
  await f.app.close();

  const restarted = await apiFixture(t, { root: f.root });

  assert.deepEqual(await sleepSessions(restarted.app), []);
  assert.equal((await restarted.app.inject({ url: `/api/chat/store/chat/${chatKey}` })).statusCode, 200);
});

test('SLEEP-API-03: одинаковый нейтральный снимок не рассылает изменений', async (t) => {
  const f = poolFixture(t);

  await f.pool.run({ chatKey: 'sleep', executor: f.executor }, {});
  reportTasks(f.opened[0]);
  reportTasks(f.opened[0]);
  assert.equal(f.changes.filter((event) => event.event === 'tasks').length, 1,
    'равные по содержимому снимки дают одно событие');
  reportTasks(f.opened[0], [{ ...sleepingTasks[0], description: 'Проверяет другой документ' }]);
  assert.equal(f.changes.filter((event) => event.event === 'tasks').length, 2);
});
