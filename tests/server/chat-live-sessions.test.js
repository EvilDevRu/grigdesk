// Живые сессии исполнителей: процесс агента переживает свой ход.
//
// Настоящий CLI здесь не нужен и не запускается: протокол `--input-format stream-json`
// эмулирует скрипт-заглушка. Проверяется ровно то, ради чего всё затевалось, — что
// процесс не умирает вместе с ответом, что непрошеный ход доезжает наружу и что «стоп»
// прерывает ход, а не разговор.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import {
  claudeSessionArgs,
  openClaudeStreamSession,
} from '../../server/src/lib/executors/_claude-stream.js';
import { ChatLiveSessions } from '../../server/src/lib/chat/live-sessions.js';
import chatModule from '../../server/src/modules/chat/index.js';

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-live-session-'));
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
          closed: false,
          async send({ message }) {
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
  const claude = (await import('../../server/src/lib/executors/claude.js')).default;
  const codex = (await import('../../server/src/lib/executors/codex.js')).default;

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
});

test('модуль чата гейтит живую сессию настройкой и не убивает процесс стопом', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../../server/src/modules/chat/index.js', import.meta.url),
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
    new URL('../../server/src/lib/prefs-store.js', import.meta.url),
    'utf8',
  );
  // Неизвестные ключи PrefsStore.write отбрасывает — без дефолта тумблер не сохранится.
  assert.equal(prefs.includes('chatLiveSessions: true'), true);
});

// ── Список живых процессов и их гашение человеком ─────────────────────────────
// Свободная сессия в `ps` неотличима от разового запуска, поэтому увидеть её и
// погасить можно только из кокпита. Проверяем сквозняком: ход поднимает процесс,
// список его показывает, кнопка гасит, а идущий ход не гасится без подтверждения.

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function apiFixture(t, { liveEnabled = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-live-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const events = [];
  const handles = [];
  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast(event, data) { events.push({ event, data }); } });

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
          pid: 4242 + handles.length,
          alive: true,
          busy: false,
          sessionId: 'sid-live',
          hold: null,
          interrupted: 0,
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
    factoryState: {},
    prefs: {
      read() {
        return {
          speech: {},
          trustedDirectories: [],
          providerSettings: {},
          chatAutoCompactWindow: 0,
          chatLiveSessions: liveEnabled,
        };
      },
    },
    modelsRegistry: async () => ({ claude: [{ id: 'claude-test', efforts: [] }] }),
    executorResolver: async (provider) => (provider === 'claude' ? executor : null),
    taskExists: async () => false,
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
      url: '/api/chat',
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

  return { app, events, handles, chat, turn };
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
