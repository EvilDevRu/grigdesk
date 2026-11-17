import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { QWEN_IDLE_EXTENSION, QWEN_IDLE_PRELOAD } from './idleBridgeRuntime.ts';

const SUPPORTED_ACP_SHA256 = '2cabd1ccef9a1aa5bf036439934fa4fa0fd1dd475369a627e8f004dbcd5982c7';

/**
 * Мост меняет только загруженный модуль проверенного npm CLI, не его установку.
 * Физический выбранный entry и хеш ACP закрепляются до запуска под reader lease.
 */
export async function prepareQwenIdleBridge(executable: string, directory: string) {
  const entry = await fs.realpath(executable);
  const root = path.dirname(entry);
  const metadata = await fs.readFile(path.join(root, 'package.json'), 'utf8')
    .then((source) => JSON.parse(source)).catch(() => null);

  if (metadata?.name !== '@qwen-code/qwen-code' || metadata.version !== '0.27.3') {
    return null;
  }

  const chunks = await fs.readdir(path.join(root, 'chunks'));
  const candidates = chunks.filter((name) => /^acpAgent-[A-Z0-9]+\.js$/.test(name));

  if (candidates.length !== 1) {
    return null;
  }

  const modulePath = await fs.realpath(path.join(root, 'chunks', candidates[0]!));

  if (path.dirname(modulePath) !== path.join(root, 'chunks')) {
    return null;
  }

  const source = await fs.readFile(modulePath, 'utf8');
  const sha256 = createHash('sha256').update(source).digest('hex');

  if (sha256 !== SUPPORTED_ACP_SHA256) {
    return null;
  }

  const markers = [
    'async extMethodInternal(method,params){', 'collectActiveWorkHolds(){',
    'var Session=class', 'async closeStoredSession(sessionId,opts){',
  ];

  if (markers.some((marker) => source.split(marker).length !== 2)) {
    return null;
  }

  // Компиляция не исполняет дополнение и ловит ошибку шаблона до запуска CLI.
  new Function('Session', QWEN_IDLE_EXTENSION);

  const preload = path.join(directory, 'idle-preload.mjs');
  const extension = path.join(directory, 'idle-extension.mjs');
  const configuration = path.join(directory, 'idle-bridge.json');

  await fs.writeFile(preload, QWEN_IDLE_PRELOAD, { mode: 0o400 });
  await fs.writeFile(extension, QWEN_IDLE_EXTENSION, { mode: 0o400 });
  await fs.writeFile(configuration, JSON.stringify({
    entry,
    cli: path.join(root, 'cli.js'),
    moduleUrl: pathToFileURL(modulePath).href,
    sha256,
    extension,
  }), { mode: 0o400 });

  return {
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    GRIGDESK_QWEN_IDLE_BRIDGE: configuration,
  };
}
