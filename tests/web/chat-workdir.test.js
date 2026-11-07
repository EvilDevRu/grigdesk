import assert from 'node:assert/strict';
import test from 'node:test';

import { apiHarness, chatStoreFixture, sseOf } from './helpers/chat-store.js';

const FIRST = { kind: 'path', path: '/workspace/first' };
const SECOND = { kind: 'path', path: '/workspace/second' };

test('PD: reconnect очищает default/recent пропущенного удаления и сохраняет папку истории', async () => {
  const { chat, session } = await fixture();
  const choice = {
    kind: 'project',
    projectId: 'demo',
    repoKey: null,
  };

  session.workdir = choice;
  chat.defWorkdir = choice;
  chat.recentWorkdirs = [choice];
  chat._markSent();
  apiHarness.get = async () => ({
    sessions: [{ ...session }],
    archived: [],
    defWorkdir: { kind: 'grigdesk' },
    recentWorkdirs: [],
  });
  await chat._resyncStore();
  assert.deepEqual(chat.defWorkdir, { kind: 'grigdesk' });
  assert.deepEqual(chat.recentWorkdirs, []);
  assert.deepEqual(session.workdir, choice);
});

for (const during of [false, true]) {
  test(`PD: reconnect сохраняет локальный выбор (правка во время GET=${during})`, async () => {
    const { chat } = await fixture();
    let release;

    apiHarness.get = () => new Promise((resolve) => {
      release = resolve;
    });

    if (!during) {
      chat.defWorkdir = SECOND;
      chat.recentWorkdirs = [SECOND];
    }

    const syncing = chat._resyncStore();

    chat.defWorkdir = SECOND;
    chat.recentWorkdirs = [SECOND];
    release({
      sessions: [],
      archived: [],
      defWorkdir: FIRST,
      recentWorkdirs: [FIRST],
    });
    await syncing;
    assert.deepEqual(chat.defWorkdir, SECOND);
    assert.deepEqual(chat.recentWorkdirs, [SECOND]);
  });
}

test('PD: поздний GET до удаления не возвращает default/recent', async () => {
  const { chat } = await fixture();
  const choice = {
    kind: 'project',
    projectId: 'demo',
    repoKey: null,
  };
  const emit = sseOf(chat);
  let release;

  chat.defWorkdir = choice;
  chat.recentWorkdirs = [choice];
  chat._markSent();
  apiHarness.get = () => new Promise((resolve) => {
    release = resolve;
  });

  const syncing = chat._resyncStore();

  emit('projects-changed', {
    kind: 'deleted',
    id: 'demo',
    revision: 3,
  });
  release({
    sessions: [],
    archived: [],
    defWorkdir: choice,
    recentWorkdirs: [choice],
  });
  await syncing;
  assert.deepEqual(chat.defWorkdir, { kind: 'grigdesk' });
  assert.deepEqual(chat.recentWorkdirs, []);
});

test('PD: новый reconnect имеет приоритет над поздним старым GET', async () => {
  const { chat } = await fixture();
  const responses = [];

  apiHarness.get = () => new Promise((resolve) => {
    responses.push(resolve);
  });

  const old = chat._resyncStore();
  const fresh = chat._resyncStore();

  responses[1]({
    sessions: [],
    archived: [],
    defWorkdir: SECOND,
    recentWorkdirs: [SECOND],
  });
  await fresh;
  responses[0]({
      sessions: [],
      archived: [],
      defWorkdir: FIRST,
      recentWorkdirs: [FIRST],
    });
  await old;
  assert.deepEqual(chat.defWorkdir, SECOND);
  assert.deepEqual(chat.recentWorkdirs, [SECOND]);
});

test('PD: полученный по SSE выбор не считается локальной правкой при следующем reconnect', async () => {
  const { chat } = await fixture();
  const emit = sseOf(chat);

  emit('chat-store-meta', {
    origin: 'other-window',
    meta: { defWorkdir: FIRST, recentWorkdirs: [FIRST] },
  });
  apiHarness.get = async () => ({
    sessions: [],
    archived: [],
    defWorkdir: SECOND,
    recentWorkdirs: [SECOND],
  });
  await chat._resyncStore();
  assert.deepEqual(chat.defWorkdir, SECOND);
  assert.deepEqual(chat.recentWorkdirs, [SECOND]);
});

/**
 * Стор использует управляемый HTTP-транспорт: проверяем подтверждение и видимый выбор.
 * Ни файловая система, ни настоящая модель для межоконной синхронизации не нужны.
 */
async function fixture() {
  const chat = await chatStoreFixture({
    sessions: [{
      id: 'chat',
      revision: 1,
      modelRef: { provider: 'test-provider', model: 'test-model' },
      taskId: null,
      workdir: FIRST,
      messages: [],
      draft: '',
      createdAt: 1,
    }]
  });

  chat.workdirProtocol = 1;

  return { chat, session: chat.sessions[0] };
}

test('кандидат reseed живёт в диалоге, фактическая папка не меняется до commit', async () => {
  const { chat, session } = await fixture();

  session.workdirPreview = { target: { cwd: FIRST.path } };
  apiHarness.post = async () => ({
    transfer: 'reseed',
    target: { cwd: SECOND.path },
    revision: 1,
    workspaceKey: 'next',
    summaryAvailable: true,
  });
  assert.equal(await chat.proposeWorkdir('chat', { taskId: null, workdir: SECOND }, true), false);
  assert.deepEqual(session.workdir, FIRST);
  assert.equal(session.workdirPreview.target.cwd, FIRST.path);
  assert.equal(session.workdirProposal.preview.target.cwd, SECOND.path);
  assert.deepEqual(chat.defWorkdir, { kind: 'grigdesk' });
});

test('повтор после потери ACK использует то же тело; draft и defaults переживают commit', async () => {
  const { chat, session } = await fixture();

  session.workdirProposal = {
    candidate: { taskId: null, workdir: SECOND },
    remember: true,
    preview: { revision: 1, workspaceKey: 'next' },
    operationId: 'stable-operation',
  };

  const requests = [];

  apiHarness.post = async (_url, body) => {
    requests.push(body);

    if (requests.length === 1) {
      throw new Error('Сеть оборвана');
    }

    session.draft = 'Набран во время операции';

    return {
      chat: {
        ...session,
        draft: '',
        workdir: SECOND,
        revision: 2,
        workdirState: { transition: { id: 'stable-operation', phase: 'done' } },
      }
    };
  };
  assert.equal(await chat.commitWorkdir('chat', 'summary'), false);
  assert.equal(await chat.commitWorkdir('chat', 'reset'), true);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(session.draft, 'Набран во время операции');
  assert.deepEqual(chat.defWorkdir, SECOND);
  assert.deepEqual(chat.recentWorkdirs, [SECOND]);
});

test('dirty SSE обновляет папку, но не даёт старой модели свежую revision', async () => {
  const { chat, session } = await fixture();

  session.draft = 'Локальный текст';
  apiHarness.get = async () => ({
    chat: {
      ...session,
      draft: 'Серверный текст',
      revision: 2,
      modelRef: { provider: 'other', model: 'other-model' },
      workdir: SECOND,
    }
  });
  await chat._pullChat('chat', false);
  assert.equal(session.draft, 'Локальный текст');
  assert.equal(session.revision, 1);
  assert.deepEqual(session.workdir, SECOND);
});

test('implicit default: подтверждённое отсутствие даёт grigdesk, ошибка сети сохраняет выбор', async () => {
  const { chat, session } = await fixture();

  session.workdirInitializing = true;
  session.workdirImplicit = true;
  apiHarness.post = async () => {
    throw Object.assign(new Error('missing'), {
      status: 409, data: { error: 'workdir_missing' },
    });
  };
  await chat._initializeWorkdir(session);
  assert.deepEqual(session.workdir, { kind: 'grigdesk' });
  session.workdir = FIRST;
  session.workdirInitializing = true;
  apiHarness.post = async () => {
    throw new Error('network');
  };
  await assert.rejects(chat._initializeWorkdir(session), /network/u);
  assert.deepEqual(session.workdir, FIRST);
});

test('явный проект с цифрой в projectId сохраняется без подмены на grigdesk', async () => {
  const { chat } = await fixture();

  apiHarness.post = async (_url, body) => {
    assert.equal(body.candidate.workdir.projectId, '2gis');

    return {};
  };

  const id = chat.newSession({
    workdir: {
      kind: 'project',
      projectId: '2gis',
      repoKey: null
    }
  });

  await chat._saveChatNow(chat.sessions.find((entry) => entry.id === id));
  assert.equal(chat.sessions.find((entry) => entry.id === id).workdir.projectId, '2gis');
});

test('compact проверяет перенос и посылает ключ проверенного workspace', async () => {
  const { chat, session } = await fixture();
  const requests = [];
  let transfer = 'reseed';

  session.sessionId = 'old-session';
  apiHarness.post = async (url, body) => {
    requests.push({ url, body });

    return url.endsWith('/preview')
      ? { transfer, workspaceKey: 'checked-workspace' }
      : { compact: { kind: 'native', contextTokens: 10 } };
  };
  await chat.compact(session.id);
  assert.equal(requests.length, 1, 'без подтверждения не отправляется compact');
  assert.match(session.error, /подтвердите перенос/u);
  assert.equal(session.sessionId, 'old-session');
  transfer = 'resume';
  await chat.compact(session.id);
  assert.equal(requests.at(-1).url, '/api/chat/compact');
  assert.equal(requests.at(-1).body.workspaceKey, 'checked-workspace');
  assert.deepEqual(requests.at(-1).body.workdir, FIRST);
});

/**
 * Ответ предпросмотра сервера: способ переноса, ревизия для CAS и фактическая папка.
 * Ревизия совпадает с записью фикстуры, поэтому переход проходит проверку CAS.
 */
function preview(transfer, workspaceKey, cwd) {
  return {
    transfer,
    revision: 1,
    workspaceKey,
    target: { cwd },
  };
}

/**
 * Сервер подтверждает переход: запись чата с новой задачей/папкой и завершённым журналом.
 * Копия снимается через JSON, чтобы ответ не делил реактивные объекты с состоянием окна.
 */
function committed(session, body, extra = {}) {
  return {
    chat: {
      ...JSON.parse(JSON.stringify(session)),
      taskId: body.taskId,
      workdir: body.workdir,
      revision: 2,
      workdirState: { transition: { id: body.operationId, phase: 'done' } },
      ...extra,
    },
  };
}

test('resume-переход идёт без окна выбора, а задача даёт чату своё название', async () => {
  const { chat, session } = await fixture();
  const dialogDuringChange = [];

  apiHarness.post = async (url, body) => {
    if (url.endsWith('/preview')) {
      return preview('resume', 'task', '/workspace/task');
    }

    dialogDuringChange.push(Boolean(session.workdirProposal));

    return committed(session, body);
  };

  assert.equal(await chat.setTask('chat', '1234', 'Заголовок задачи'), true);
  assert.deepEqual(dialogDuringChange, [false], 'resume и чат без памяти не открывают окно выбора');
  assert.equal(session.taskId, '1234');
  assert.equal(session.title, 'Заголовок задачи');
});

test('задача через окно выбора получает название только после подтверждения', async () => {
  const { chat, session } = await fixture();

  apiHarness.post = async (url, body) => (url.endsWith('/preview')
    ? preview('reseed', 'task', '/workspace/task')
    : committed(session, body));

  assert.equal(await chat.setTask('chat', '1234', 'Заголовок задачи'), false);
  assert.ok(session.workdirProposal, 'reseed ждёт решения человека');
  assert.notEqual(session.title, 'Заголовок задачи');
  assert.equal(await chat.commitWorkdir('chat', 'summary'), true);
  assert.equal(session.taskId, '1234');
  assert.equal(session.title, 'Заголовок задачи');
});

test('обрыв связи на resume-переходе открывает повтор того же запроса', async () => {
  const { chat, session } = await fixture();
  const changes = [];

  apiHarness.post = async (url, body) => {
    if (url.endsWith('/preview')) {
      return preview('resume', 'next', SECOND.path);
    }

    changes.push(body);

    if (changes.length === 1) {
      throw new Error('Failed to fetch');
    }

    return committed(session, body);
  };

  assert.equal(await chat.proposeWorkdir('chat', { taskId: null, workdir: SECOND }, true), false);
  assert.equal(session.workdirProposal?.transfer, 'resume', 'исход неизвестен — окно предлагает повтор');
  assert.deepEqual(session.workdir, FIRST);
  assert.equal(await chat.commitWorkdir('chat', 'reset'), true);
  assert.deepEqual(changes[1], changes[0], 'повтор несёт то же тело и тот же operationId');
  assert.deepEqual(session.workdir, SECOND);
  assert.equal(session.workdirProposal, null);
});

test('определённый отказ перехода по задаче виден в разговоре и не оставляет окна', async () => {
  const { chat, session } = await fixture();

  apiHarness.post = async (url) => {
    if (url.endsWith('/preview')) {
      throw Object.assign(new Error('Каталог не найден: /workspace/task'), {
        status: 409,
        data: { error: 'workdir_missing' },
      });
    }

    throw new Error('change не должен вызываться');
  };

  assert.equal(await chat.setTask('chat', '1234', 'Заголовок задачи'), false);
  assert.equal(session.taskId, null);
  assert.equal(session.workdirProposal ?? null, null);
  assert.match(session.messages.at(-1)?.text || '', /Каталог не найден/u);
  assert.equal(session.messages.at(-1)?.role, 'error');
});

test('предпросмотр не отправляет на сервер чистый чат целиком', async () => {
  const { chat, session } = await fixture();
  let puts = 0;

  apiHarness.put = async () => {
    puts += 1;

    return {
      ok: true,
      revision: session.revision,
      stale: false
    };
  };
  apiHarness.post = async () => preview('none', 'first', FIRST.path);

  await chat.previewWorkdir('chat');
  assert.equal(puts, 0, 'чистый чат уже совпадает с сервером');
  session.draft = 'Несохранённый черновик';
  await chat.previewWorkdir('chat');
  assert.equal(puts, 1, 'несохранённая правка уходит до чтения записи сервером');
});

test('выбор текущей папки без переноса памяти не создаёт перехода', async () => {
  const { chat, session } = await fixture();
  const urls = [];

  apiHarness.post = async (url) => {
    urls.push(url);

    return preview('none', 'first', FIRST.path);
  };

  assert.equal(await chat.proposeWorkdir('chat', { taskId: null, workdir: { ...FIRST } }, true), true);
  assert.deepEqual(urls, ['/api/chat/workdir/preview']);
  assert.deepEqual(chat.defWorkdir, FIRST, 'явный выбор всё равно становится умолчанием');
  assert.equal(session.workdirProposal ?? null, null);
});

test('подтверждение сервера с полем вне снимка не делает чат вечно несохранённым', async () => {
  const { chat, session } = await fixture();
  let puts = 0;

  apiHarness.put = async () => {
    puts += 1;

    return {
      ok: true,
      revision: session.revision + 1,
      stale: false,
      // Поле ответа, которого нет в снимке чата: раньше из-за него отпечатки не совпадали.
      modelRefState: { state: 'resolved' },
    };
  };
  session.draft = 'Черновик';
  await chat._writeChat('chat');
  assert.equal(puts, 1);
  await chat._writeChat('chat');
  assert.equal(puts, 1, 'неизменённый чат повторно целиком не отправляется');
});

test('PD-chat-catalog: deleted очищает default/recent, поздняя мета не возвращает выбор', async () => {
  const { chat, session } = await fixture();
  const choice = {
    kind: 'project',
    projectId: 'demo',
    repoKey: null
  };

  session.workdir = choice;
  chat.defWorkdir = choice;
  chat.recentWorkdirs = [choice, FIRST];
  chat.initPerms();
  globalThis.__chatSse('projects-changed', {
    id: 'demo',
    revision: 4,
    kind: 'deleted'
  });
  assert.deepEqual(chat.defWorkdir, { kind: 'grigdesk' });
  assert.deepEqual(chat.recentWorkdirs, [FIRST]);
  assert.deepEqual(session.workdir, choice, 'папка старого разговора сохраняется');
  globalThis.__chatSse('chat-store-meta', {
    origin: 'other-window', meta: { defWorkdir: choice, recentWorkdirs: [choice, FIRST] },
  });
  assert.deepEqual(chat.defWorkdir, { kind: 'grigdesk' });
  assert.deepEqual(chat.recentWorkdirs, [FIRST]);
});
