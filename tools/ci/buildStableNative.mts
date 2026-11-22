import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildUnixNative, unixStableInputs } from './linuxNative.mts';
import { buildWindowsNative, productionWindowsKey, windowsStableInputs } from './windowsNative.mts';

const [target, planFile, output, ...extra] = process.argv.slice(2);

if (!output || extra.length) {
  throw new Error('stable_native_build_arguments_invalid');
}

/**
 * Ключ подписи Unix-комплекта передаётся сборщику файлом с режимом 0600.
 * CI хранит ключ в секрете; здесь он материализуется только на время сборки.
 */
async function unixKeyFile(): Promise<string> {
  const value = process.env.RELEASE_SIGNING_KEY?.trim() ?? '';

  if (!value) {
    throw new Error('unix_release_signing_key_missing');
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-unix-key-'));
  const file = path.join(directory, 'release-signing.pem');
  const pem = value.startsWith('-----BEGIN ') ? value : Buffer.from(value, 'base64').toString('utf8');

  await fs.writeFile(file, pem, { mode: 0o600 });

  return file;
}

if (target === 'windows-x64' || target === 'windows-arm64') {
  const input = await windowsStableInputs(target, planFile);

  await buildWindowsNative(input.target, input.plan, path.resolve(output), productionWindowsKey());
} else if (target === 'linux-arm64' || target === 'darwin-arm64') {
  const input = await unixStableInputs(target, planFile);
  const keyFile = await unixKeyFile();

  try {
    await buildUnixNative(input.target, input.plan, path.resolve(output), keyFile);
  } finally {
    await fs.rm(path.dirname(keyFile), { recursive: true, force: true });
  }
} else {
  throw new Error(`stable_native_adapter_missing (${target})`);
}