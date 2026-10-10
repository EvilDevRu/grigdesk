import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { registerAppRoutes } from '../../server/src/lib/mobile/facade/app.ts';
import { mobileFacadeFixture } from './helpers/mobile-facade.js';

test('MC-26/27: APK выдаётся только после сверки size/sha256 с manifest', async (t) => {
  const { app, directory } = await mobileFacadeFixture(t, (mobile, apkDirectory) =>
    registerAppRoutes(mobile, { apkDirectory }),
  );

  assert.equal((await app.inject('/api/mobile/v1/app')).json().error, 'no_apk');

  const bytes = Buffer.from('PK synthetic APK');
  const manifest = {
    version: '0.1.0',
    versionCode: 100,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };

  await fs.writeFile(path.join(directory, 'cockpit-mobile.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(directory, 'cockpit-mobile.apk'), bytes);
  assert.deepEqual((await app.inject('/api/mobile/v1/app')).json(), manifest);

  const download = await app.inject('/api/mobile/v1/app/apk');

  assert.equal(download.headers['content-type'], 'application/vnd.android.package-archive');
  assert.equal(Number(download.headers['content-length']), bytes.length);
  assert.deepEqual(download.rawPayload, bytes);
  await fs.writeFile(path.join(directory, 'cockpit-mobile.apk'), 'Другой APK');
  assert.equal((await app.inject('/api/mobile/v1/app/apk')).json().error, 'apk_mismatch');
  assert.equal((await app.inject('/api/mobile/v1/app')).statusCode, 409);
});
