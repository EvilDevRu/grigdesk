import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { chatAppFixture, controlledExecutor, TEST_MODEL_REF } from './helpers/chat-turns.js';

import { registerMediaRoutes } from '../../server/src/lib/mobile/facade/media.ts';
import { mobileFacadeFixture } from './helpers/mobile-facade.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAF' +
    'gAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);

test('MC-31/32: ETag, один encode, raster bytes и принадлежность вложения чату', async (t) => {
  const calls = [];
  let contentType = 'image/png';
  const deps = {
    chat: {
      read: async (id) =>
        id === 'chat-one'
          ? {
              messages: [
                {
                  role: 'user',
                  attachments: [{ file: 'mine.png' }],
                },
              ],
            }
          : null,
    },
    callRaw: async (_method, path) => {
      calls.push(path);

      return {
        statusCode: 200,
        payload: png,
        headers: { 'content-type': contentType },
      };
    },
  };
  const { app } = await mobileFacadeFixture(t, (mobile) => registerMediaRoutes(mobile, deps));
  const reference = `w:${Buffer.from('screens/a b%25.png').toString('base64url')}`;
  const response = await app.inject(`/api/mobile/v1/chats/chat-one/media/${reference}`);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.rawPayload, png);
  assert.equal(calls[0], '/api/chat/chat-one/image?path=screens%2Fa%20b%2525.png');

  const etag = `"${createHash('sha256').update(png).digest('hex')}"`;

  assert.equal(response.headers.etag, etag);
  assert.equal(
    (
      await app.inject({
        url: `/api/mobile/v1/chats/chat-one/media/${reference}`,
        headers: { 'if-none-match': etag },
      })
    ).statusCode,
    304,
  );
  assert.equal(
    (await app.inject('/api/mobile/v1/chats/chat-one/media/u:other.png')).statusCode,
    404,
  );
  assert.equal(
    (await app.inject('/api/mobile/v1/chats/chat-one/media/u:mine.png')).statusCode,
    200,
  );

  const before = calls.length;

  assert.equal((await app.inject('/api/mobile/v1/chats/chat-one/media/w:_bad=')).statusCode, 400);
  assert.equal(calls.length, before);
  contentType = 'image/svg+xml';
  assert.equal(
    (await app.inject('/api/mobile/v1/chats/chat-one/media/u:mine.png')).statusCode,
    415,
  );
});

test('MC-37: устройство держит не больше двух одновременных чтений картинок', async (t) => {
  let release;
  let entered = 0;
  let notify;
  const holding = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    notify = resolve;
  });
  const { app } = await mobileFacadeFixture(t, (mobile) =>
    registerMediaRoutes(mobile, {
      chat: { read: async () => ({ messages: [] }) },
      callRaw: async () => {
        entered += 1;

        if (entered === 2) {
          notify();
        }

        await holding;

        return {
          statusCode: 200,
          payload: png,
          headers: { 'content-type': 'image/png' },
        };
      },
    }),
  );
  const reference = `w:${Buffer.from('test.png').toString('base64url')}`;
  const url = `/api/mobile/v1/chats/chat-one/media/${reference}`;
  const first = app.inject(url);
  const second = app.inject(url);

  await ready;

  const third = app.inject(url);
  const rejected = await Promise.race([
    third,
    new Promise((resolve) => setTimeout(() => resolve(null), 50)),
  ]);

  release();
  await Promise.all([first, second, third]);
  assert.equal(entered, 2);
  assert.equal(rejected?.statusCode, 503);
  assert.equal((await app.inject(url)).statusCode, 200);
});

test('MC-07/31/37: upstream auth/500, byte limit и signature не занимают слот после отказа', async (t) => {
  let statusCode = 401;
  let payload = png;
  const { app } = await mobileFacadeFixture(t, (mobile) =>
    registerMediaRoutes(mobile, {
      chat: { read: async () => ({ messages: [] }) },
      callRaw: async () => ({
        statusCode,
        payload,
        headers: { 'content-type': 'image/png' },
      }),
    }),
  );
  const reference = `w:${Buffer.from('test.png').toString('base64url')}`;
  const url = `/api/mobile/v1/chats/chat-one/media/${reference}`;
  const auth = await app.inject(url);

  assert.equal(auth.statusCode, 502);
  assert.equal(auth.json().error, 'upstream_auth');
  statusCode = 500;
  assert.equal((await app.inject(url)).json().error, 'upstream_500');
  statusCode = 200;
  payload = Buffer.alloc(10000001);
  png.subarray(0, 8).copy(payload);
  assert.equal((await app.inject(url)).statusCode, 415);
  payload = Buffer.from('<svg></svg>');
  assert.equal((await app.inject(url)).statusCode, 415);
  payload = png;
  assert.equal((await app.inject(url)).statusCode, 200);
});

test('MC-37: реальные image маршруты, symlink, SVG, размер и ETag', async (t) => {
  const controlled = controlledExecutor();
  const core = await chatAppFixture(t, { executor: controlled.executor });
  const cwd = path.join(core.root, 'pictures');

  await fs.mkdir(cwd);

  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');

  await fs.writeFile(path.join(cwd, 'ok.png'), png);
  await fs.writeFile(path.join(cwd, 'bad.svg'), '<svg/>');
  await fs.writeFile(path.join(core.root, 'outside.png'), png);
  await fs.symlink(path.join(core.root, 'outside.png'), path.join(cwd, 'link.png'));

  const huge = await fs.open(path.join(cwd, 'huge.png'), 'w');

  await huge.write(png);
  await huge.truncate(10000001);
  await huge.close();

  const saved = await core.app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        id: 'real-media',
        modelRef: TEST_MODEL_REF,
        workdir: {
          kind: 'path',
          path: cwd,
        },
        messages: [],
        createdAt: Date.now(),
      },
    },
  });

  assert.equal(saved.statusCode, 200, saved.body);

  const { app } = await mobileFacadeFixture(t, (mobile) =>
    registerMediaRoutes(mobile, {
      chat: core.app.mobileChat,
      callRaw: async (method, url) => {
        const response = await core.app.inject({
          method,
          url,
        });

        return {
          statusCode: response.statusCode,
          payload: response.rawPayload,
          headers: response.headers,
        };
      },
    }),
  );
  const url = (file) =>
    '/api/mobile/v1/chats/real-media/media/' +
    encodeURIComponent('w:' + Buffer.from(file).toString('base64url'));
  const valid = await app.inject(url('ok.png'));

  assert.equal(valid.statusCode, 200, valid.body);
  assert.deepEqual(valid.rawPayload, png);
  assert.equal(
    (
      await app.inject({
        url: url('ok.png'),
        headers: {
          'if-none-match': valid.headers.etag,
        },
      })
    ).statusCode,
    304,
  );

  for (const file of ['bad.svg', 'huge.png']) {
    const response = await app.inject(url(file));

    assert.equal(response.statusCode, 415, response.body);
    assert.equal(response.json().error, 'media_type');
  }
  for (const file of ['../outside.png', 'link.png']) {
    assert.equal((await app.inject(url(file))).statusCode, 502);
  }

  assert.equal(
    (await app.inject('/api/mobile/v1/chats/real-media/media/u:foreign.png')).statusCode,
    404,
  );
});
