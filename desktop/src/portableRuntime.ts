import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';

import { desktopRuntimePath, parseRuntimeDescriptor } from '../../shared/desktop/desktopRuntime.ts';
import type { RuntimeDescriptor } from '../../shared/desktop/desktopRuntime.ts';
import { portableWindowPath } from '../../shared/node/bundleLayout.ts';
import { probeServerBinary, verifyServerBinary } from '../../shared/node/serverBinaryRuntime.ts';
import { dataHome, envFilePath } from '../../shared/runtime/dataHome.ts';
import { resolveRuntimeSettings } from '../../shared/runtime/runtimeSettings.ts';
import {
  assertDataIdle, assertServerBinaryFile, selectSeaServer,
} from '../../server/src/lib/selectSeaServer.ts';
import type { SelectSeaServerInput } from '../../server/src/lib/selectSeaServer.ts';
import type { DesktopProfile, Profiles } from './profiles.ts';
import { desktopText } from './locale.ts';

interface PortableOptions {
  isPackaged: boolean;
  execPath: string;
  env: NodeJS.ProcessEnv;
  home?: string;
  explicitUrl?: string | null;
  profiles: Profiles;
  fs?: typeof fs;
  verifyBinary?(binary: string, env: NodeJS.ProcessEnv): Promise<void>;
  selectServer?(input: SelectSeaServerInput): Promise<string>;
  startServer(binary: string, input?: { signal: AbortSignal }): Promise<void>;
  stopServer(): Promise<void>;
  ownsServer?(): boolean;
  notify(message: string): void | Promise<void>;
  report(state: string): void;
}

/**
 * Серверный вход — бинарник для ELF/R и app.ts для source.
 * Отсутствие именно входа отличает перенос от ошибок Node или зависимостей.
 */
function serverEntry(descriptor: RuntimeDescriptor): string {
  if (descriptor.version === 4) {
    return descriptor.binary;
  }

  return path.join(descriptor.root, descriptor.version === 3
    ? 'server/grigdesk-server' : 'server/src/app.ts');
}

/**
 * Discovery читает только расположение и малые настройки, оставляя verify фоновому запуску.
 * Сохранённый descriptor меняется общей транзакцией лишь при первом выборе или доказанном переносе.
 */
export function createPortableRuntime(options: PortableOptions) {
  const files = options.fs ?? fs;
  const home = options.home ?? os.homedir();
  const runtimePath = desktopRuntimePath({ env: options.env, home });
  const lifetime = new AbortController();
  let snapshot: string | null = null;
  let binary: string | null = null;
  let windowPath: string | null = null;
  let address = resolveRuntimeSettings({
    env: options.env,
    file: {},
    home,
  }).origin;
  let selectedHome = dataHome({ env: options.env, home });
  let blocked: unknown = null;
  let savedMissing = false;
  let relocated = false;
  let notified = false;
  let prepared: string | null = null;
  let queue = Promise.resolve();

  /**
   * Полная проверка выполняется без API и с общей отменой до публикации выбора.
   * Пользовательский порт используется тестами; production закрепляет packageId между пробами.
   */
  async function verify(target: string, signal: AbortSignal): Promise<void> {
    await assertServerBinaryFile(target);
    signal.throwIfAborted();

    if (options.verifyBinary) {
      await options.verifyBinary(target, { ...options.env, GRIGDESK_HOME: selectedHome });
    } else {
      const info = await probeServerBinary(target, { signal });

      await verifyServerBinary(target, {
        home: selectedHome,
        expectPackageId: info.packageId,
        timeoutMs: 120000,
        signal,
      });
    }

    signal.throwIfAborted();
  }

  /**
   * Малое описание перечитывается перед каждой подготовкой: внешний выбор мог измениться после discovery.
   * Только отсутствие серверного входа, а не расхождение с профилем, разрешает автоматический перенос.
   */
  async function inspectSelection() {
    const previous = snapshot;

    snapshot = await files.readFile(runtimePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null;
      }

      throw error;
    });

    const descriptor = snapshot === null ? null : parseRuntimeDescriptor(snapshot);

    if (snapshot !== null && !descriptor) {
      throw new Error(desktopText('desktop.invalidRuntime'));
    }

    if (snapshot !== previous) {
      prepared = null;
    }

    selectedHome = descriptor && descriptor.version !== 1
      ? descriptor.home : dataHome({ env: options.env, home });

    const env = { ...options.env, GRIGDESK_HOME: selectedHome };
    const text = await files.readFile(envFilePath({ env, home }), 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return '';
        }

        throw error;
      },
    );

    address = resolveRuntimeSettings({
      env,
      home,
      file: parseEnv(text),
    }).origin;
    savedMissing = false;

    if (descriptor) {
      await files.stat(serverEntry(descriptor)).catch((error: NodeJS.ErrnoException) => {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code ?? '')) {
          throw error;
        }

        savedMissing = true;
      });
    }

    relocated = savedMissing && binary !== null;

    return descriptor;
  }

  /**
   * Кандидат добавляется в прежний список без смены selected и без проверки payload.
   * Предварительный адрес позволяет открыть remote даже при ошибке местного descriptor.
   * Только отсутствие серверного входа разрешает перенести привязку прежнего local.
   */
  async function discover() {
    windowPath = await portableWindowPath(options);

    if (windowPath) {
      const candidate = path.join(path.dirname(windowPath), 'bin/grigdesk-server');

      try {
        await assertServerBinaryFile(candidate);
        binary = candidate;
      } catch {
        binary = null;
      }
    }

    try {
      const descriptor = await inspectSelection();

      if (descriptor) {
        if (binary && !savedMissing && !options.profiles.settings.selected
          && !options.profiles.settings.profiles.some((profile) => profile.kind === 'local')) {
          await options.profiles.add({
            kind: 'local',
            name: 'Этот компьютер',
            address,
            fp: null,
            ...(descriptor.version === 4 ? { serverBinary: descriptor.binary } : {}),
          });
        }

        if (binary) {
          for (const profile of options.profiles.settings.profiles) {
            if (profile.kind === 'local' && !profile.serverBinary && descriptor.version === 4) {
              await options.profiles.bind(profile.id, relocated ? binary : descriptor.binary);
            } else if (relocated && profile.kind === 'local'
              && profile.id === options.profiles.settings.selected) {
              await options.profiles.bind(profile.id, binary);
            }
          }
        }
      }
    } catch (error) {
      blocked = error;
    }

    if (binary && !options.profiles.settings.profiles.some((item) => item.serverBinary === binary)) {
      await options.profiles.add({
        kind: 'local',
        name: desktopText('desktop.portableMachine'),
        address,
        fp: null,
        serverBinary: binary,
        portable: true,
      });
    }

    return {
      localAvailable: binary !== null,
      address,
      windowPath,
      home: selectedHome,
    };
  }

  /**
   * Подготовка сериализуется, а смена профиля и выход отменяют поздний commit или spawn.
   * Ручной переход проверяет новый ELF до остановки только собственного supervisor.
   */
  async function prepare(profile: DesktopProfile, manual: boolean, signal?: AbortSignal) {
    if (profile.kind !== 'local' || options.explicitUrl) {
      return;
    }

    if (blocked) {
      throw blocked;
    }

    const current = await inspectSelection();
    const savedEntry = current ? serverEntry(current) : null;
    const automaticSaved = !manual && current !== null && !savedMissing;
    const target = manual ? profile.serverBinary : automaticSaved ? savedEntry : binary;

    if (!target) {
      return;
    }

    const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
    const selected = options.profiles.settings.selected;
    const check = () => {
      combined.throwIfAborted();

      if (options.profiles.settings.selected !== selected) {
        throw new Error(desktopText('desktop.selectionChanged'));
      }
    };

    check();

    if (prepared === target) {
      return;
    }

    options.report(desktopText('desktop.preparingServer'));

    if (automaticSaved || current?.version === 4 && current.binary === target) {
      await options.startServer(target, { signal: combined });

      if (automaticSaved && profile.address !== address) {
        await options.profiles.add({ ...profile, address });
      }

      prepared = target;

      return;
    }

    await verify(target, combined);
    check();

    if (manual) {
      if (!options.ownsServer?.()) {
        await assertDataIdle(selectedHome);
      }

      prepared = null;
      await options.stopServer();
      check();
    }

    await (options.selectServer ?? selectSeaServer)({
      root: target,
      home,
      env: { ...options.env, GRIGDESK_HOME: selectedHome },
      windowVersion: 4,
      expectedPrevious: snapshot,
      signal: combined,
      verifyBinary: async () => check(),
    });
    snapshot = await files.readFile(runtimePath, 'utf8');
    check();
    await options.startServer(target, { signal: combined });
    prepared = target;

    if (relocated && !notified) {
      notified = true;
      void Promise.resolve().then(() => options.notify(desktopText('desktop.portableRelocated')))
        .catch(() => {});
    }
  }

  const enqueue = (profile: DesktopProfile, manual: boolean, signal?: AbortSignal) => {
    const operation = queue.then(() => prepare(profile, manual, signal));

    queue = operation.catch(() => {});

    return operation;
  };

  return {
    discover,
    prepareLocal: (profile: DesktopProfile, input?: { signal?: AbortSignal }) =>
      enqueue(profile, false, input?.signal),
    activate: (profile: DesktopProfile) => enqueue(profile, true),
    close() {
      lifetime.abort();
    },
  };
}
