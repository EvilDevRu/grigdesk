import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveStablePlatformRelease, stablePlatforms } from '../stablePlatformRelease.mts';
import { buildWindowsNative, verifyWindowsNative } from './windowsNative.mts';

const target = process.arch === 'arm64' ? 'windows-arm64' : 'windows-x64';
if (process.platform !== 'win32' || target !== process.env.WINDOWS_SMOKE_TARGET) {
  throw new Error('windows_smoke_runner_mismatch');
}
const version = (await fs.readFile('VERSION', 'utf8')).trim();
const runId = process.env.GITHUB_RUN_ID!;
const runNumber = process.env.GITHUB_RUN_NUMBER!;
const plan = {
  format: 1 as const, runId, runNumber,
  ...resolveStablePlatformRelease({
    platforms: [...stablePlatforms], publish: false, testMode: 'full',
    reason: '', validationRun: '', attempt: '1', runNumber, version,
    commit: process.env.GITHUB_SHA!,
  }),
};
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const output = path.resolve('windows-build');
await buildWindowsNative(target, plan, output, privateKey);
await verifyWindowsNative(target, plan, '0'.repeat(64), output, path.resolve('windows-proof'), publicKey);
console.log('Windows installer, window login, server shutdown and uninstall passed.');
