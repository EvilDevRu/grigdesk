import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import { validateDriverPackage } from '../../server/src/lib/trackers/driverPackage.ts';
import { png, expectedPackage } from '../helpers/pluginV1.js';
import { trackerFixture, writeTracker } from './helpers/trackerFixture.js';

/**
 * CRC вычисляется для настоящих PNG chunks, включая отрицательные размерные границы.
 * Иначе отказ мог бы объясняться повреждением картинки вместо проверяемого лимита.
 */
function crc32(bytes) {
  let value = 0xffffffff;

  for (const byte of bytes) {
    value ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
  }

  return (value ^ 0xffffffff) >>> 0;
}

/**
 * Полноценный chunk вставляется перед IEND, сохраняя длину и контрольную сумму.
 * Это позволяет отдельно проверять APNG и размер файла без испорченного контейнера.
 */
function chunk(name, payload) {
  const body = Buffer.concat([Buffer.from(name), payload]);
  const result = Buffer.alloc(payload.length + 12);

  result.writeUInt32BE(payload.length, 0);
  body.copy(result, 4);
  result.writeUInt32BE(crc32(body), result.length - 4);

  return result;
}

const insertChunk = (bytes, extra) => Buffer.concat([bytes.subarray(0, -12), extra, bytes.subarray(-12)]);

/**
 * Размерная граница использует настоящий растр RGB, сжатый IDAT и CRC каждого chunk.
 * Отказ проверяет предел стороны, а не несогласованность IHDR с содержимым пикселей.
 */
function dimensions(width, height) {
  const header = Buffer.alloc(13);

  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;

  return Buffer.concat([
    png.subarray(0, 8),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Полезная нагрузка tEXt имеет допустимый непустой keyword и один разделитель.
 * Предел байтов проверяется на валидном изображении, а не на дописанном мусоре.
 */
function sizedPng(size) {
  return insertChunk(png, chunk('tEXt', Buffer.concat([
    Buffer.from('Padding\0'),
    Buffer.alloc(size - png.length - 12 - 8, 0x61),
  ])));
}

const maxBytes = sizedPng(256 * 1024);
const invalid = [
  ['URL', 'https://foreign.fixture/logo.png', png],
  ['absolute', '/tmp/logo.png', png],
  ['parent', '../logo.png', png],
  ['SVG', 'logo.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ['APNG', 'logo.png', insertChunk(png, chunk('acTL', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0])))],
  ['oversize', 'logo.png', sizedPng(256 * 1024 + 1)],
  ['width', 'logo.png', dimensions(513, 1)],
  ['height', 'logo.png', dimensions(1, 513)],
  ['zero', 'logo.png', dimensions(0, 1)],
  ['truncated', 'logo.png', png.subarray(0, -8)],
];

for (const [name, logo, bytes] of invalid) {
  test(`MD-LOGO-VALIDATION: ${name} отклоняется scan/prepared до import`, async (t) => {
    const fixture = await trackerFixture(t, {
      setup: async (config) => {
        const directory = await writeTracker(config, 'fixture-logo', { manifest: { logo } });

        await writeFile(path.join(directory, 'logo.png'), bytes);
      },
    });
    const directory = path.join(fixture.config.driversDir, 'fixture-logo');

    for (const prepared of [false, true]) {
      await assert.rejects(validateDriverPackage(directory, {
        ...expectedPackage,
        reservedIds: new Set(['own']),
      }, prepared), { code: 'manifest_invalid' });
    }

    assert.equal(existsSync(path.join(directory, 'imported')), false);
    assert.equal(fixture.runtime.catalog().drivers.find((entry) => entry.id === 'fixture-logo')
      .status, 'unavailable');
  });
}

test('MD-LOGO-VALIDATION: PNG на границах 256 КиБ и 512 px принимается', async (t) => {
  const fixture = await trackerFixture(t, {
    setup: async (config) => {
      const directory = await writeTracker(config, 'fixture-logo', { manifest: { logo: 'logo.png' } });

      await writeFile(path.join(directory, 'logo.png'), maxBytes);
    },
  });
  const directory = path.join(fixture.config.driversDir, 'fixture-logo');

  assert.equal((await validateDriverPackage(directory, expectedPackage)).id, 'fixture-logo');
  await writeFile(path.join(directory, 'logo.png'), dimensions(512, 512));
  assert.equal((await validateDriverPackage(directory, expectedPackage)).id, 'fixture-logo');
});

test('MD-LOGO-HTTP: выключенный PNG защищён auth/digest и не допускает подмену', async (t) => {
  const fixture = await trackerFixture(t, {
    setup: async (config) => {
      const directory = await writeTracker(config, 'fixture-logo', { manifest: { logo: 'assets/logo.png' } });

      await mkdir(path.join(directory, 'assets'));
      await writeFile(path.join(directory, 'assets/logo.png'), png);
    },
  });
  const descriptor = fixture.runtime.catalog().drivers.find((entry) => entry.id === 'fixture-logo');

  assert.equal(typeof descriptor.logoUrl, 'string', 'Каталог должен публиковать URL логотипа');
  assert.match(descriptor.logoUrl, /^\/api\/trackers\/fixture-logo\/logo\/[a-f0-9]+$/u);
  assert.equal((await fixture.app.inject(descriptor.logoUrl)).statusCode, 401);

  const response = await fixture.request('GET', descriptor.logoUrl);

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.rawPayload, png);
  assert.match(response.headers['content-type'], /^image\/png/u);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.match(response.headers['cache-control'], /no-store/u);
  assert.equal(existsSync(path.join(fixture.config.driversDir, 'fixture-logo/imported')), false);

  const file = path.join(fixture.config.driversDir, 'fixture-logo/assets/logo.png');

  await writeFile(file, dimensions(2, 2));
  assert.equal((await fixture.request('GET', descriptor.logoUrl)).statusCode, 404);
  await rm(file);
  assert.equal((await fixture.request('GET', descriptor.logoUrl)).statusCode, 404);
  await writeFile(path.join(fixture.root, 'outside.png'), png);
  await symlink(path.join(fixture.root, 'outside.png'), file);
  assert.equal((await fixture.request('GET', descriptor.logoUrl)).statusCode, 404);
});
