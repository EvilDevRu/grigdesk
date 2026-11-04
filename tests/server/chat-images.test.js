import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

import { CHAT_IMAGE_MAX_BYTES, isWithinChatImageRoot, readChatImage }
  from '../../server/src/lib/chat/chatImages.ts';
import { CHAT_IMAGE_FIXTURES } from '../fixtures/chatImages.mjs';
import { chatAppFixture, TEST_MODEL_REF } from './helpers/chat-turns.js';
import { config } from '../../server/src/config.ts';
import authPlugin, { SESSION_COOKIE } from '../../server/src/plugins/auth.ts';
import { LEGACY } from '../../shared/runtime/legacyBrand.ts';

/**
 * Временная рабочая область содержит настоящие растры и отдельный внешний каталог.
 * Ни одна проверка не читает историю или рабочие файлы пользователя.
 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-chat-images-'));
  const cwd = path.join(root, 'work');
  const extra = path.join(root, 'extra');
  const outside = path.join(root, 'work-neighbour');

  await Promise.all([cwd, extra, outside].map((directory) => fs.mkdir(directory)));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  return {
    root,
    cwd,
    extra,
    outside,
  };
}

for (const [id, layout, status] of [
  ['GA-01', 'same-link', 200],
  ['GA-02', 'foreign-link', 403],
  ['GA-03', 'directory', 403],
]) {
  test(`${id}: старый корень картинок — ${layout}`, async (t) => {
    const f = await fixture(t);
    const previousHome = process.env.HOME;
    const previousData = config.dataHome;
    const data = path.join(f.root, '.grigdesk');
    const old = path.join(f.root, LEGACY.dataHomeDir);
    const target = layout === 'same-link' ? data : f.outside;

    await fs.mkdir(path.join(data, 'artifacts'), { recursive: true });
    await fs.mkdir(path.join(target, 'artifacts'), { recursive: true });

    if (layout === 'directory') {
      await fs.mkdir(path.join(old, 'artifacts'), { recursive: true });
    } else {
      await fs.symlink(target, old);
    }

    await fs.writeFile(path.join(old, 'artifacts/a.png'), CHAT_IMAGE_FIXTURES.png);
    process.env.HOME = f.root;
    config.dataHome = data;

    try {
      const result = await readChatImage({
        cwd: f.cwd,
        imageRoots: [path.join(data, 'artifacts')],
        requested: path.join(old, 'artifacts/a.png'),
      });

      assert.equal(result.status ?? 200, status);

      if (status === 200) {
        assert.deepEqual(result.bytes, CHAT_IMAGE_FIXTURES.png);
      }
    } finally {
      config.dataHome = previousData;

      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });
}

test('CHAT-IMG-01: absolute/relative, cwd/extraDir и имена файлов сохраняют байты/MIME', async (t) => {
  const f = await fixture(t);

  for (const [extension, bytes] of Object.entries(CHAT_IMAGE_FIXTURES)) {
    const name = `кадр с пробелом %#.${extension}`;

    await fs.writeFile(path.join(f.cwd, name), bytes);
    await fs.writeFile(path.join(f.extra, name), bytes);

    for (const requested of [name, path.join(f.cwd, name), path.join(f.extra, name)]) {
      const result = await readChatImage({
        cwd: f.cwd,
        extraDirs: [f.extra],
        requested,
      });

      assert.equal(result.type, `image/${extension}`);
      assert.equal(result.bytes?.equals(bytes), true);
    }
  }
});

test('CHAT-IMG-02: служебные каталоги и пересекающиеся корни не открывают секреты', async (t) => {
  const f = await fixture(t);
  const locations = [
    '.state/artifacts/frame.png', '.state/secret.png', '.git/frame.png',
    'nested/.state/artifacts/frame.png', '.state/artifacts/nested/.state/frame.png',
  ];

  for (const location of locations) {
    await fs.mkdir(path.dirname(path.join(f.cwd, location)), { recursive: true });
    await fs.writeFile(path.join(f.cwd, location), CHAT_IMAGE_FIXTURES.png);
  }

  assert.equal((await readChatImage({ cwd: f.cwd, requested: locations[0] })).type, 'image/png');

  for (const requested of locations.slice(1)) {
    const result = await readChatImage({
      cwd: f.cwd,
      extraDirs: [path.join(f.cwd, '.state'), path.join(f.cwd, '.git')],
      requested,
    });

    assert.deepEqual(result, { status: 404, error: 'hidden' });
  }

  await fs.symlink(path.join(f.cwd, '.state/secret.png'), path.join(f.cwd, 'alias.png'));
  await fs.symlink(path.join(f.cwd, '.state/artifacts/frame.png'), path.join(f.cwd, '.git/alias.png'));
  assert.deepEqual(await readChatImage({ cwd: f.cwd, requested: 'alias.png' }),
    { status: 404, error: 'hidden' });
  assert.deepEqual(await readChatImage({ cwd: f.cwd, requested: '.git/alias.png' }),
    { status: 404, error: 'hidden' });
  assert.deepEqual(await readChatImage({ cwd: path.join(f.cwd, '.state'), requested: 'secret.png' }),
    { status: 404, error: 'hidden' });
});

test('CHAT-IMG-03: traversal, сосед и symlink наружу запрещены, внутренний alias разрешён', async (t) => {
  const f = await fixture(t);

  await fs.writeFile(path.join(f.cwd, 'frame.png'), CHAT_IMAGE_FIXTURES.png);
  await fs.writeFile(path.join(f.outside, 'frame.png'), CHAT_IMAGE_FIXTURES.png);
  await fs.symlink(path.join(f.outside, 'frame.png'), path.join(f.cwd, 'outside.png'));
  await fs.symlink(path.join(f.cwd, 'frame.png'), path.join(f.cwd, 'inside.png'));

  for (const requested of ['../work-neighbour/frame.png', path.join(f.outside, 'frame.png'), 'outside.png']) {
    assert.deepEqual(await readChatImage({ cwd: f.cwd, requested }),
      { status: 403, error: 'outside_workdir' });
  }

  assert.equal((await readChatImage({ cwd: f.cwd, requested: 'inside.png' })).type, 'image/png');
  assert.equal(isWithinChatImageRoot('/tmp/frame.png', '/'), true);
  assert.equal(isWithinChatImageRoot('/repo-next/a.png', '/repo'), false);
});

test('CHAT-IMG-04: неправильный путь, missing/directory/FIFO/denied и ложные растры', async (t) => {
  const f = await fixture(t);

  for (const requested of [null, {}, '', '\u0000.png', 'a\n.png', 'a'.repeat(4097)]) {
    assert.deepEqual(await readChatImage({ cwd: f.cwd, requested }), { status: 400, error: 'bad_path' });
  }

  await fs.mkdir(path.join(f.cwd, 'directory.png'));
  await promisify(execFile)('mkfifo', [path.join(f.cwd, 'pipe.png')]);

  for (const requested of ['missing.png', 'directory.png', 'pipe.png']) {
    assert.deepEqual(await readChatImage({ cwd: f.cwd, requested }), { status: 404, error: 'no_file' });
  }

  await fs.writeFile(path.join(f.cwd, 'fake.png'), 'not an image');
  await fs.writeFile(path.join(f.cwd, 'frame.svg'), '<svg/>');
  await fs.writeFile(path.join(f.cwd, 'wrong.gif'), CHAT_IMAGE_FIXTURES.png);

  for (const requested of ['fake.png', 'frame.svg', 'wrong.gif']) {
    assert.deepEqual(await readChatImage({ cwd: f.cwd, requested }), { status: 415, error: 'not_image' });
  }

  await fs.writeFile(path.join(f.cwd, 'denied.png'), CHAT_IMAGE_FIXTURES.png);

  const denied = await readChatImage({ cwd: f.cwd, requested: 'denied.png' }, {
    realpath: fs.realpath.bind(fs),
    open: async () => {
      throw Object.assign(new Error('private path must not leak'), { code: 'EACCES' });
    },
  });

  assert.deepEqual(denied, { status: 404, error: 'no_file' });
});

test('CHAT-IMG-05: подмена пути, рост и ошибки чтения не обходят fd/лимит и закрывают файлы', async (t) => {
  const f = await fixture(t);
  const handles = [];
  let closed = 0;

  /**
   * Обёртка использует настоящий open и считает закрытия реальных FileHandle.
   * Барьер изменяет только файловую систему в точке, выбранной сценарием.
   */
  async function trackedOpen(...args) {
    const handle = await fs.open(...args);
    const close = handle.close.bind(handle);

    handle.close = async () => {
      closed += 1;
      await close();
    };
    handles.push(handle);

    return handle;
  }

  const ordinary = path.join(f.cwd, 'frame.png');

  await fs.writeFile(ordinary, CHAT_IMAGE_FIXTURES.png);
  assert.equal((await readChatImage({ cwd: f.cwd, requested: ordinary }, {
    realpath: fs.realpath.bind(fs),
    open: trackedOpen,
  })).type, 'image/png');

  const sub = path.join(f.cwd, 'sub');

  await fs.mkdir(sub);
  await fs.writeFile(path.join(sub, 'frame.png'), CHAT_IMAGE_FIXTURES.png);
  await fs.writeFile(path.join(f.outside, 'frame.png'), CHAT_IMAGE_FIXTURES.png);

  const replaced = await readChatImage({ cwd: f.cwd, requested: 'sub/frame.png' }, {
    realpath: fs.realpath.bind(fs),
    open: async (...args) => {
      await fs.rename(sub, path.join(f.cwd, 'old-sub'));
      await fs.symlink(f.outside, sub);

      return trackedOpen(...args);
    },
  });

  assert.deepEqual(replaced, { status: 403, error: 'outside_workdir' });

  const growing = await readChatImage({ cwd: f.cwd, requested: ordinary }, {
    realpath: fs.realpath.bind(fs),
    open: async (...args) => {
      const handle = await trackedOpen(...args);
      const stat = handle.stat.bind(handle);

      handle.stat = async () => {
        const previous = await stat();

        await fs.truncate(ordinary, CHAT_IMAGE_MAX_BYTES + 1);

        return previous;
      };

      return handle;
    },
  });

  assert.deepEqual(growing, { status: 413, error: 'too_big' });
  assert.deepEqual(await readChatImage({ cwd: f.cwd, requested: ordinary }),
    { status: 413, error: 'too_big' });
  await fs.writeFile(ordinary, CHAT_IMAGE_FIXTURES.png);

  const unconfirmed = await readChatImage({ cwd: f.cwd, requested: ordinary }, {
    realpath: async (name) => {
      if (String(name).startsWith('/proc/self/fd/')) {
        throw Object.assign(new Error('secret proc path'), { code: 'EIO' });
      }

      return fs.realpath(name);
    },
    open: trackedOpen,
  });

  assert.deepEqual(unconfirmed, { status: 500, error: 'image_read_failed' });

  const ioFailure = await readChatImage({ cwd: f.cwd, requested: ordinary }, {
    realpath: fs.realpath.bind(fs),
    open: async (...args) => {
      const handle = await trackedOpen(...args);

      handle.read = async () => {
        throw Object.assign(new Error('secret file path'), { code: 'EIO' });
      };

      return handle;
    },
  });

  assert.deepEqual(ioFailure, { status: 500, error: 'image_read_failed' });

  const vanished = await readChatImage({ cwd: f.cwd, requested: ordinary }, {
    realpath: fs.realpath.bind(fs),
    open: async (...args) => {
      await fs.unlink(ordinary);

      return trackedOpen(...args);
    },
  });

  assert.deepEqual(vanished, { status: 404, error: 'no_file' });
  assert.equal(closed, handles.length);
  assert.equal(handles.every((handle) => handle.fd === -1), true);
});

/**
 * Сохраняет synthetic чат штатным PUT, чтобы маршрут читал текущую durable область.
 * Папки проекта принадлежат временной fixture, а исполнитель не запускается.
 */
async function saveImageChat(f, workdir, id = 'image-chat', headers = {}) {
  const response = await f.app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    headers,
    payload: {
      chat: {
        id,
        modelRef: TEST_MODEL_REF,
        workdir,
        messages: [],
        createdAt: Date.now(),
      },
    },
  });

  assert.equal(response.statusCode, 200, response.body);
}

/**
 * Настоящий модуль чата получает проект с двумя реальными временными корнями.
 * Auth проверяется отдельным сценарием через настоящий общий guard; `adapter` дополняет
 * тестового исполнителя объявленными возможностями.
 */
async function httpFixture(t, adapter = {}) {
  const f = await fixture(t);
  const executor = {
    id: 'test-provider',
    workdir: { switch: 'resume', roots: 'multi' },
    run: async () => {
      throw new Error('Чтение картинки не должно запускать модель');
    },
    ...adapter,
  };
  const http = await chatAppFixture(t, {
    root: f.root,
    executor,
    prefs: {
      projects: {
        'image-project': {
          defaultRepoKey: 'main',
          repos: [{ key: 'main', dir: f.cwd }, { key: 'extra', dir: f.extra }],
        },
      },
    },
  });

  return { ...f, ...http };
}

const imageUrl = (requested, id = 'image-chat') =>
  `/api/chat/${id}/image?path=${encodeURIComponent(requested)}`;

test('CHAT-IMG-06: HTTP отдаёт bytes/MIME/headers и читает текущие cwd/extraDirs', async (t) => {
  const f = await httpFixture(t);

  await saveImageChat(f, {
    kind: 'project',
    projectId: 'image-project',
    repoKey: null,
  });
  await fs.writeFile(path.join(f.cwd, 'frame.png'), CHAT_IMAGE_FIXTURES.png);
  await fs.writeFile(path.join(f.extra, 'extra.png'), CHAT_IMAGE_FIXTURES.png);

  for (const requested of ['frame.png', path.join(f.extra, 'extra.png')]) {
    const response = await f.app.inject(imageUrl(requested));

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.rawPayload.equals(CHAT_IMAGE_FIXTURES.png), true);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
  }

  assert.equal((await f.app.inject(imageUrl('frame.png', 'missing-chat'))).json().error, 'no_chat');
  await saveImageChat(f, { kind: 'path', path: path.join(f.root, 'missing-dir') }, 'bad-workdir');
  assert.equal((await f.app.inject(imageUrl('frame.png', 'bad-workdir'))).json().error, 'no_workdir');

  for (const query of ['path=a.png&path=b.png', 'path[x]=a.png', '']) {
    const response = await f.app.inject(`/api/chat/image-chat/image?${query}`);

    assert.equal(response.statusCode, 400);
    assert.match(response.headers['cache-control'], /no-store/);
  }
});

test('CHAT-IMG-06b: каталог картинок исполнителя читается вне рабочей папки', async (t) => {
  // Codex сохраняет сгенерированную картинку в своём каталоге, а не в рабочей папке.
  // Каталог объявляет адаптер; отсутствующий каталог не ломает чтение из самой папки.
  let generated = '';
  const f = await httpFixture(t, {
    imageRoots: () => [generated, path.join(generated, 'missing')],
  });

  generated = path.join(f.root, 'generated');

  await saveImageChat(f, { kind: 'path', path: f.cwd });
  await fs.mkdir(generated, { recursive: true });
  await fs.writeFile(path.join(generated, 'gen.png'), CHAT_IMAGE_FIXTURES.png);
  await fs.writeFile(path.join(f.cwd, 'frame.png'), CHAT_IMAGE_FIXTURES.png);

  for (const requested of [path.join(generated, 'gen.png'), 'frame.png']) {
    const response = await f.app.inject(imageUrl(requested));

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.rawPayload.equals(CHAT_IMAGE_FIXTURES.png), true);
  }

  const outside = await f.app.inject(imageUrl(path.join(f.outside, 'frame.png')));

  assert.equal(outside.statusCode, 403);
});

test('CHAT-IMG-06c: общая папка артефактов читается из любого разговора', async (t) => {
  // Снимки агенты кладут в папку артефактов вне дерева кода; сервер добавляет её к корням.
  const f = await httpFixture(t);
  const shots = path.join(f.root, 'artifacts', 'shots');

  await saveImageChat(f, { kind: 'path', path: f.cwd });
  await fs.mkdir(shots, { recursive: true });
  await fs.writeFile(path.join(shots, 'shot.png'), CHAT_IMAGE_FIXTURES.png);

  const response = await f.app.inject(imageUrl(path.join(shots, 'shot.png')));

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.rawPayload.equals(CHAT_IMAGE_FIXTURES.png), true);
  assert.equal((await f.app.inject(imageUrl(path.join(f.outside, 'frame.png')))).statusCode, 403);
});

test('CHAT-IMG-06d: миниатюра читает вложение вне workdir, сохраняя границы каталога', async (t) => {
  const f = await httpFixture(t);
  const attachments = path.join(f.root, 'chats', 'attachments');
  const neighbour = `${attachments}-neighbour`;
  const image = path.join(attachments, 'uploaded.png');
  const privateImage = path.join(f.root, 'chats', 'private.png');

  await saveImageChat(f, { kind: 'path', path: f.cwd });
  await fs.mkdir(attachments, { recursive: true });
  await fs.mkdir(neighbour);
  await fs.writeFile(image, CHAT_IMAGE_FIXTURES.png);
  await fs.writeFile(privateImage, CHAT_IMAGE_FIXTURES.png);
  await fs.writeFile(path.join(neighbour, 'frame.png'), CHAT_IMAGE_FIXTURES.png);
  await fs.symlink(privateImage, path.join(attachments, 'alias.png'));

  const response = await f.app.inject(imageUrl(image));

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.rawPayload.equals(CHAT_IMAGE_FIXTURES.png), true);
  assert.equal(response.headers['content-type'], 'image/png');
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');

  for (const requested of [
    privateImage,
    path.join(neighbour, 'frame.png'),
    `${attachments}/../private.png`,
    path.join(attachments, 'alias.png'),
  ]) {
    const denied = await f.app.inject(imageUrl(requested));

    assert.equal(denied.statusCode, 403, requested);
    assert.deepEqual(denied.json(), { error: 'outside_workdir' });
  }
});

test('CHAT-IMG-07: HTTP отказы не кэшируются и смена workdir снимает старый доступ', async (t) => {
  const f = await httpFixture(t);

  await saveImageChat(f, { kind: 'path', path: f.cwd });
  await fs.mkdir(path.join(f.cwd, '.state'), { recursive: true });
  await fs.writeFile(path.join(f.cwd, '.state/secret.png'), CHAT_IMAGE_FIXTURES.png);
  await fs.writeFile(path.join(f.cwd, 'frame.png'), CHAT_IMAGE_FIXTURES.png);
  await fs.writeFile(path.join(f.extra, 'frame.png'), CHAT_IMAGE_FIXTURES.gif);
  await fs.writeFile(path.join(f.cwd, 'fake.png'), 'not raster');
  await fs.writeFile(path.join(f.cwd, 'big.png'), CHAT_IMAGE_FIXTURES.png);
  await fs.truncate(path.join(f.cwd, 'big.png'), CHAT_IMAGE_MAX_BYTES + 1);

  for (const [requested, status, error] of [
    [path.join(f.outside, 'frame.png'), 403, 'outside_workdir'],
    ['.state/secret.png', 404, 'hidden'], ['missing.png', 404, 'no_file'],
    ['big.png', 413, 'too_big'], ['fake.png', 415, 'not_image'],
  ]) {
    const response = await f.app.inject(imageUrl(requested));

    assert.equal(response.statusCode, status);
    assert.deepEqual(response.json(), { error });
    assert.match(response.headers['cache-control'], /no-store/);
    assert.equal(response.body.includes(f.root), false);
  }

  const candidate = { taskId: null, workdir: { kind: 'path', path: f.extra } };
  const preview = await f.app.inject({
    method: 'POST',
    url: '/api/chat/workdir/preview',
    payload: { chatKey: 'image-chat', candidate },
  });

  assert.equal(preview.statusCode, 200, preview.body);

  const change = await f.app.inject({
    method: 'POST',
    url: '/api/chat/workdir/change',
    payload: {
      chatKey: 'image-chat',
      ...candidate,
      operationId: 'image-workdir-change',
      transfer: 'reset',
      expectedRevision: preview.json().revision,
      expectedWorkspaceKey: preview.json().workspaceKey,
    },
  });

  assert.equal(change.statusCode, 200, change.body);
  assert.equal((await f.app.inject(imageUrl(path.join(f.cwd, 'frame.png')))).statusCode, 403);
  assert.equal((await f.app.inject(imageUrl('frame.png'))).statusCode, 415);
});

test('CHAT-IMG-08: настоящий auth guard закрывает чтение, валидная сессия проходит', async (t) => {
  const f = await httpFixture(t);

  await f.app.register(authPlugin, {
    authStore: {
      isConfigured: () => true,
      isValidSession: (id) => id === 'image-test-session',
    },
  });

  const headers = { cookie: `${SESSION_COOKIE}=image-test-session` };

  await saveImageChat(f, { kind: 'path', path: f.cwd }, 'image-chat', headers);
  await fs.writeFile(path.join(f.cwd, 'frame.png'), CHAT_IMAGE_FIXTURES.png);

  const anonymous = await f.app.inject(imageUrl('frame.png'));

  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().error, 'unauthorized');
  assert.match(anonymous.headers['cache-control'], /no-store/);

  const authorized = await f.app.inject({ url: imageUrl('frame.png'), headers });

  assert.equal(authorized.statusCode, 200);
  assert.equal(authorized.rawPayload.equals(CHAT_IMAGE_FIXTURES.png), true);
});

test('CHAT-IMG-09: память чтения пропорциональна файлу, а не лимиту', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.cwd, 'small.png');
  const original = Buffer.alloc;
  const sizes = [];

  await fs.writeFile(file, CHAT_IMAGE_FIXTURES.png);

  let result;

  // Подмена живёт ровно один вызов: остальной процесс видит настоящий Buffer.alloc.
  Buffer.alloc = (size, ...rest) => {
    sizes.push(size);

    return original.call(Buffer, size, ...rest);
  };

  try {
    result = await readChatImage({ cwd: f.cwd, requested: file });
  } finally {
    Buffer.alloc = original;
  }

  assert.equal(result.type, 'image/png');
  assert.deepEqual(result.bytes, CHAT_IMAGE_FIXTURES.png);
  assert.ok(Math.max(0, ...sizes) < 64 * 1024, `выделено ${Math.max(0, ...sizes)} байт`);
});


test('CI-DH состояние и мобильные ключи скрыты даже в разрешённой рабочей области', async (t) => {
  const f = await fixture(t);
  const saved = { dataStateDir: config.dataStateDir, mobileDir: config.mobileDir };

  config.dataStateDir = path.join(f.cwd, 'state');
  config.mobileDir = path.join(f.cwd, 'mobile');

  try {
    for (const dir of [config.dataStateDir, config.mobileDir]) {
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, 'secret.png'), CHAT_IMAGE_FIXTURES.png);
      assert.deepEqual(await readChatImage({ cwd: f.cwd, requested: path.join(dir, 'secret.png') }),
        { status: 404, error: 'hidden' });
    }
  } finally {
    Object.assign(config, saved);
  }
});
