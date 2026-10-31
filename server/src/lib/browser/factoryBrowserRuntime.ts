import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import type { FactoryRuntimeSelection } from '../factoryRuntimePins.ts';
import { helperCommandFor, readHelperCatalog } from '../runtimePaths.ts';

/**
 * Один data home задаёт один приватный listener независимо от поколения engine.
 * Длинный data home получает короткий UID-private hashed путь без смены identity.
 */
export function browserRelaySocket(dataHome: string): string {
  const file = path.join(dataHome, 'browser', 'relay.sock');

  if (!path.isAbsolute(dataHome) || /[\r\n\0]/u.test(file)) {
    throw new Error('browser_socket_invalid');
  }

  if (Buffer.byteLength(file) <= 100) {
    return file;
  }

  const key = createHash('sha256').update(dataHome).digest('hex').slice(0, 24);
  const uid = process.getuid?.() ?? process.pid;

  return path.join('/tmp', `grigdesk-browser-${uid}-${key}`, 'relay.sock');
}

/**
 * Пустые host-owned поля подавляют подстановку browser helper через extraEnv.
 * Старый runtime без browser entry сохраняет прежний запуск без нового инструмента.
 */
export function factoryBrowserRuntimeEnv(runtime: FactoryRuntimeSelection, socket: string) {
  const empty = {
    GRIGDESK_BROWSER_NODE: '',
    GRIGDESK_BROWSER_HELPER: '',
    GRIGDESK_BROWSER_RELAY_SOCKET: '',
  };
  const packaged = runtime.packageId !== null;
  const helperDirectory = path.join(runtime.runtimeRoot, 'server/runtime/helpers');
  const manifest = packaged ? path.join(helperDirectory, 'helpers.json')
    : path.join(runtime.runtimeRoot, 'server/build/helpers.json');

  if (!packaged && !existsSync(manifest)) {
    return empty;
  }

  const catalog = readHelperCatalog(manifest);

  if (!catalog.helpers.some((entry) => entry.id === 'factory-browser')) {
    return empty;
  }

  const helper = helperCommandFor({
    mode: packaged ? 'helper' : 'source',
    kind: packaged ? 'packaged' : 'source',
    root: runtime.runtimeRoot,
    node: runtime.node,
    execPath: runtime.node,
    helperDirectory,
    installationRoot: runtime.runtimeRoot,
    installationBin: path.join(runtime.runtimeRoot, 'bin'),
  }, catalog, 'factory-browser', []);
  const file = helper.args[0]!;

  if (!path.isAbsolute(socket) || !statSync(file).isFile()) {
    throw new Error('browser_runtime_invalid');
  }

  return {
    GRIGDESK_BROWSER_NODE: helper.command,
    GRIGDESK_BROWSER_HELPER: file,
    GRIGDESK_BROWSER_RELAY_SOCKET: socket,
  };
}
