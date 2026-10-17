import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DownloadError, downloadToFile } from '../../server/src/lib/studio3d/download.ts';
import { startFakeTripo } from './helpers/fakeTripo.js';

const BYTES = Buffer.alloc(256 * 1024, 7).fill(9, 1000, 2000);
const SHA = createHash('sha256').update(BYTES).digest('hex');

/**
 * Поддельный CDN с одним файлом и временная папка. Паузы между попытками
 * мгновенные: сценарии считают попытки, а не секунды.
 */
async function fixture(t) {
  const fake = await startFakeTripo();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-studio-download-'));

  fake.setFile('model.glb', BYTES);
  t.after(async () => {
    await fake.close();
    await fs.rm(dir, {
      recursive: true,
      force: true
    });
  });

  return {
    fake,
    dest: path.join(dir, 'model.glb'),
    sleep: async () => {}
  };
}

test('DL-01 целый файл: размер, sha256 и никакого .part после', async (t) => {
  const { fake, dest, sleep } = await fixture(t);
  const result = await downloadToFile({
    fetchImpl: fetch,
    url: fake.cdnUrl('model.glb'),
    dest,
    sleep
  });

  assert.deepEqual(result, {
    size: BYTES.length,
    sha256: SHA
  });
  assert.deepEqual(await fs.readFile(dest), BYTES);
  await assert.rejects(fs.stat(`${dest}.part`));
});

test('DL-02 обрыв посреди файла докачивается с места обрыва', async (t) => {
  const { fake, dest, sleep } = await fixture(t);

  fake.cdnFault('model.glb', {
    kind: 'drop',
    after: 100000
  });

  const result = await downloadToFile({
    fetchImpl: fetch,
    url: fake.cdnUrl('model.glb'),
    dest,
    sleep
  });

  assert.equal(result.sha256, SHA);
});

test('DL-03 сервер не понял Range — файл начинается заново и всё равно цел', async (t) => {
  const { fake, dest, sleep } = await fixture(t);

  fake.cdnFault('model.glb', {
    kind: 'drop',
    after: 50000
  });
  fake.cdnFault('model.glb', { kind: 'ignore-range' });

  assert.equal((await downloadToFile({
    fetchImpl: fetch,
    url: fake.cdnUrl('model.glb'),
    dest,
    sleep
  })).sha256, SHA);
});

test('DL-04 протухшая ссылка обновляется перечитыванием задачи', async (t) => {
  const { fake, dest, sleep } = await fixture(t);
  let refreshed = 0;

  fake.cdnFault('model.glb', { kind: '403' });

  const result = await downloadToFile({
    fetchImpl: fetch,
    url: fake.cdnUrl('model.glb'),
    dest,
    sleep,
    refresh: async () => {
      refreshed += 1;

      return fake.cdnUrl('model.glb');
    },
  });

  assert.equal(refreshed, 1);
  assert.equal(result.size, BYTES.length);
});

test('DL-05 без обновления ссылки и при вечных обрывах — понятный отказ', async (t) => {
  const { fake, dest, sleep } = await fixture(t);

  fake.cdnFault('model.glb', { kind: '403' });
  await assert.rejects(downloadToFile({
    fetchImpl: fetch,
    url: fake.cdnUrl('model.glb'),
    dest,
    sleep
  }), (error) => error instanceof DownloadError && error.code === 'expired');

  for (let index = 0; index < 3; index += 1) {
    fake.cdnFault('model.glb', {
      kind: 'drop',
      after: 0
    });
  }

  await assert.rejects(downloadToFile({
    fetchImpl: fetch,
    url: fake.cdnUrl('model.glb'),
    dest,
    sleep,
    attempts: 3
  }), (error) => error.code === 'gave-up');
});

test('DL-06 файл больше предела не дописывается', async (t) => {
  const { fake, dest, sleep } = await fixture(t);

  await assert.rejects(downloadToFile({
    fetchImpl: fetch,
    url: fake.cdnUrl('model.glb'),
    dest,
    sleep,
    maxBytes: 1000
  }), (error) => error.code === 'too-large');
});

/**
 * Частичный файл с доказательством identity предыдущего ответа CDN.
 * Это тест устойчивого состояния, которое остаётся после обрыва/рестарта.
 */
async function partialFixture(dest, url, bytes, validator, total) {
  await fs.writeFile(`${dest}.part`, bytes);
  await fs.writeFile(`${dest}.part.meta.json`, JSON.stringify({
    url,
    validator,
    total
  }));
}

test('FIX-03 chunked 200 без Content-Length целиком публикуется по корректному EOF', async (t) => {
  const { fake, dest, sleep } = await fixture(t);
  const result = await downloadToFile({
    url: fake.cdnUrl('model.glb'),
    dest,
    sleep,
    attempts: 1,
    fetchImpl: async () => new Response(BYTES),
  });

  assert.equal(result.size, BYTES.length);
  assert.equal(result.sha256, SHA);
});

test('FIX-03 неправильный Content-Range не дописывается и не публикуется', async (t) => {
  const { fake, dest, sleep } = await fixture(t);
  const url = fake.cdnUrl('model.glb');

  await partialFixture(dest, url, Buffer.from('AAAAAAAAAA'), '"v1"', 20);
  await assert.rejects(downloadToFile({
    url,
    dest,
    sleep,
    attempts: 1,
    fetchImpl: async () => new Response(Buffer.from('BBBBBBBBBB'), {
      status: 206,
      headers: {
        ETag: '"v1"',
        'Content-Range': 'bytes 5-14/20',
        'Content-Length': '10'
      }
    }),
  }));
  await assert.rejects(fs.stat(dest));
});

test('FIX-03 сменившийся ETag исключает склейку объектов, повтор начинается с нуля', async (t) => {
  const { fake, dest, sleep } = await fixture(t);
  const url = fake.cdnUrl('model.glb');
  const next = Buffer.from('BBBBBBBBBBBBBBBBBBBB');
  const headersSeen = [];

  await partialFixture(dest, url, Buffer.from('AAAAAAAAAA'), '"v1"', 20);

  const result = await downloadToFile({
    url,
    dest,
    sleep,
    fetchImpl: async (_url, options) => {
      headersSeen.push(new Headers(options.headers));

      return headersSeen.length === 1 ? new Response(next.subarray(10), {
        status: 206,
        headers: {
          ETag: '"v2"',
          'Content-Range': 'bytes 10-19/20',
          'Content-Length': '10'
        }
      }) : new Response(next, { headers: { ETag: '"v2"', 'Content-Length': '20' } });
    },
  });

  assert.equal(headersSeen[0].get('If-Range'), '"v1"');
  assert.equal(headersSeen[1]?.get('Range'), null);
  assert.deepEqual(await fs.readFile(dest), next);
  assert.equal(result.sha256, createHash('sha256').update(next).digest('hex'));
});

test('FIX-03 без validator частичный файл не является основанием Range', async (t) => {
  const { fake, dest, sleep } = await fixture(t);
  let headers;

  await fs.writeFile(`${dest}.part`, Buffer.from('старый объект'));
  await downloadToFile({
    url: fake.cdnUrl('model.glb'),
    dest,
    sleep,
    fetchImpl: async (_url, options) => {
      headers = new Headers(options.headers);

      return new Response(BYTES, { headers: { 'Content-Length': String(BYTES.length) } });
    },
  });

  assert.equal(headers.get('Range'), null);
  assert.equal(createHash('sha256').update(await fs.readFile(dest)).digest('hex'), SHA);
});

test('FIX-03 timeout охватывает ожидание headers', async (t) => {
  const { fake, dest, sleep } = await fixture(t);
  let aborted = false;
  const pending = downloadToFile({
    url: fake.cdnUrl('model.glb'),
    dest,
    sleep,
    attempts: 1,
    idleTimeoutMs: 20,
    fetchImpl: async (_url, options) => {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('fixture aborted'));
        });
      });
    },
  });

  await assert.rejects(Promise.race([
    pending,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('headers зависли')), 200)),
  ]), (error) => error instanceof DownloadError);
  assert.equal(aborted, true);
  await assert.rejects(fs.stat(dest));
});

test('FIX-03 chunked превышение лимита не публикует файл', async (t) => {
  const { fake, dest, sleep } = await fixture(t);

  await assert.rejects(downloadToFile({
    url: fake.cdnUrl('model.glb'),
    dest,
    sleep,
    maxBytes: 1000,
    fetchImpl: async () => new Response(BYTES)
  }), (error) => error instanceof DownloadError && error.code === 'too-large');
  await assert.rejects(fs.stat(dest));
});

test('FIX-03 длина тела 206 должна совпасть с диапазоном, короткий файл не публикуется', async (t) => {
  const { fake, dest, sleep } = await fixture(t);
  const url = fake.cdnUrl('model.glb');

  await partialFixture(dest, url, Buffer.from('AAAAAAAAAA'), '"v1"', 20);
  await assert.rejects(downloadToFile({
    url,
    dest,
    sleep,
    attempts: 1,
    fetchImpl: async () => new Response(Buffer.from('BBBBB'), {
      status: 206,
      headers: {
        ETag: '"v1"',
        'Content-Range': 'bytes 10-19/20',
        'Content-Length': '10'
      }
    })
  }));
  await assert.rejects(fs.stat(dest));
});

test('FIX-03 новая ссылка после refresh не наследует неподтверждённую докачку', async (t) => {
  const { fake, dest, sleep } = await fixture(t);
  const url = fake.cdnUrl('model.glb');
  const nextUrl = fake.cdnUrl('new-object.glb');
  const calls = [];

  await partialFixture(dest, url, Buffer.from('AAAAAAAAAA'), '"v1"', BYTES.length);

  const result = await downloadToFile({
    url,
    dest,
    sleep,
    refresh: async () => nextUrl,
    fetchImpl: async (requested, options) => {
      calls.push({ url: requested, headers: new Headers(options.headers) });

      return calls.length === 1 ? new Response(null, { status: 403 }) : new Response(BYTES, {
        headers: { ETag: '"v2"', 'Content-Length': String(BYTES.length) }
      });
    }
  });

  assert.equal(calls[1].url, nextUrl);
  assert.equal(calls[1].headers.get('Range'), null);
  assert.equal(result.sha256, SHA);
});

test('FIX-03 ENOSPC немедленно останавливает скачивание без сетевого повтора', async (t) => {
  const { fake, dest, sleep } = await fixture(t);
  let calls = 0;

  await assert.rejects(downloadToFile({
    url: fake.cdnUrl('model.glb'),
    dest,
    sleep,
    fetchImpl: async () => {
      calls += 1;

      return new Response(BYTES);
    },
    createWriter: () => {
      const error = new Error('fixture disk full');

      error.code = 'ENOSPC';

      throw error;
    }
  }), (error) => error instanceof DownloadError && error.code === 'disk');
  assert.equal(calls, 1);
  await assert.rejects(fs.stat(dest));
});
