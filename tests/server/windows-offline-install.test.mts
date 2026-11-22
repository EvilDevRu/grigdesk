import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertWindowsMachine, verifyWindowsPackage } from '../../tools/ci/windowsNative.mts';
import { resolveStablePlatformRelease, stablePlatforms } from '../../tools/stablePlatformRelease.mts';
import { sha256 } from '../../shared/node/hash.ts';

const plan = {
  format: 1 as const,
  runId: '42',
  runNumber: '12',
  ...resolveStablePlatformRelease({
    platforms: [...stablePlatforms],
    publish: false,
    testMode: 'full',
    reason: '',
    validationRun: '',
    attempt: '1',
    runNumber: '12',
    version: '1.2.3',
    commit: 'c'.repeat(40),
  }),
};

/**
 * Минимальный PE позволяет проверить признак машины и расположение PE-заголовка.
 * Файл теста никогда не запускается как Windows-программа.
 */
function pe(machine: number): Buffer {
  const raw = Buffer.alloc(70);

  raw.writeUInt16LE(0x5a4d, 0);
  raw.writeUInt32LE(64, 0x3c);
  raw.writeUInt32LE(0x4550, 64);
  raw.writeUInt16LE(machine, 68);

  return raw;
}

/**
 * Сборочная опись подписывает исходные байты, проверка восстанавливает файлы
 * по их реальным SHA и сопоставляет документ с планом.
 */
test('Windows offline package verifies the plan, architecture and signed files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-windows-package-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const component = new Map([
    ['grigdesk-maintenance.exe', pe(0x8664)],
    ['desktop.exe', Buffer.from('desktop-fixture')],
    ['server.zip', Buffer.from('server-fixture')],
  ]);
  const files = [];

  for (const [name, bytes] of component) {
    await fs.writeFile(path.join(root, name), bytes);
    files.push({
      name,
      size: bytes.length,
      sha256: sha256(bytes),
    });
  }

  const payload = Buffer.from(JSON.stringify({
    format: 1,
    platform: 'windows-x64',
    ...plan.current,
    runId: plan.runId,
    files,
  }));
  const bootstrap = Buffer.from('powershell-fixture\n');

  await Promise.all([
    fs.writeFile(path.join(root, 'release.json'), JSON.stringify({
      payload: payload.toString('base64'),
      signature: sign(null, payload, privateKey).toString('base64'),
    })),
    fs.writeFile(path.join(root, 'grigdesk-install.ps1'), bootstrap),
    fs.writeFile(path.join(root, 'grigdesk-install.ps1.sha256'),
      `${sha256(bootstrap)}  grigdesk-install.ps1\n`),
    fs.writeFile(path.join(root, 'grigdesk-install.ps1.sig'),
      sign(null, bootstrap, privateKey).toString('base64') + '\n'),
  ]);

  const record = await verifyWindowsPackage(root, 'windows-x64', plan, publicKey);

  assert.equal(record.files.length, 7);
  await assert.rejects(assertWindowsMachine(path.join(root, 'grigdesk-maintenance.exe'),
    'windows-arm64'), /windows_executable_arch_invalid/u);
  await assert.rejects(verifyWindowsPackage(root, 'windows-arm64', plan, publicKey),
    /windows_release_package_mismatch/u);
  await fs.writeFile(path.join(root, 'desktop.exe'), 'DESKTOP-FIXTURE');
  await assert.rejects(verifyWindowsPackage(root, 'windows-x64', plan, publicKey),
    /windows_release_package_mismatch/u);
});
