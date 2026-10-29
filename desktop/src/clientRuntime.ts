import { desktopText } from './locale.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { API_VERSION } from '../../shared/client/apiVersion.ts';
import type { ApiVersion } from '../../shared/client/clientShell.ts';
import type { IdentityStore } from '../../shared/desktop/deviceIdentity.ts';
import type { DesktopSettings } from './settings.ts';
import type { DesktopExitPreference } from './desktopExitPreference.ts';
import type { DesktopProfile } from './profiles.ts';
import { Profiles } from './profiles.ts';
import { createPairing, pinnedJson } from './pairing.ts';
import { createShellApi } from './pipe/shellApi.ts';
import type { NativeWindows } from './pipe/shellApi.ts';
import type { WindowControls } from './windowControls.ts';
import { json, startPipe } from './pipe/pipeServer.ts';
import { createUpstream } from './pipe/upstream.ts';

interface RuntimeOptions {
  selectDirectory?(origin: string): Promise<string | null>;
  windowControls?: WindowControls;
  desktopExit?: DesktopExitPreference;
  nativeWindows?: NativeWindows;
  settings: DesktopSettings;
  save(): Promise<void>;
  systemLanguage?: string;
  onLocale?(preference: string): void;
  uiDir: string;
  secret: string;
  appApi?: ApiVersion;
  identity: IdentityStore;
  identityDirectory: string;
  localAvailable(): boolean;
  localAddress(): string;
  windowKey(profile: DesktopProfile): Promise<string>;
  prepareLocal?(profile: DesktopProfile, options?: { signal: AbortSignal }): void | Promise<void>;
  beforeSelect?(profile: DesktopProfile): Promise<void>;
  onOrigin(origin: string, resetStorage: boolean): void | Promise<void>;
  onOriginRemoved?(origin: string): void;
  navigate(origin: string): Promise<void>;
}

/**
 * Профиль, ключ и транспорт живут в main; renderer видит только публичный shell API.
 * Каждая машина сохраняет свой origin, а старт интерфейса не ждёт пробного hello.
 */
export function createClientRuntime(options: RuntimeOptions) {
  const profiles = new Profiles({ settings: options.settings, save: options.save });
  const pipes = new Map<string | null, Awaited<ReturnType<typeof startPipe>>>();
  const pending = new Map<string | null, Promise<string>>();
  const originalPorts = new Map(options.settings.profiles.map((profile) => [profile.id, profile.port]));
  const appApi = options.appApi || API_VERSION;
  const pairing = createPairing({
    profiles,
    identity: options.identity,
    directory: options.identityDirectory,
  });
  const shell = createShellApi({
    selectDirectory: options.selectDirectory,
    windowControls: options.windowControls,
    desktopExit: options.desktopExit,
    nativeWindows: options.nativeWindows,
    profiles,
    pairing,
    beforeSelect: options.beforeSelect,
    systemLanguage: options.systemLanguage,
    saveLocale: options.save,
    onLocale: options.onLocale,
    appApi,
    localAvailable: options.localAvailable,
    localAddress: options.localAddress,
    navigate: async (id) => options.navigate(await origin(id)),
    /**
     * Удалённая машина освобождает слушатель до повторного использования её порта.
     * Прежний origin сразу исключается из разрешённой навигации приложения.
     */
    async removed(id) {
      const pipe = pipes.get(id);

      if (pipe) {
        pipes.delete(id);
        options.onOriginRemoved?.(pipe.origin);
        await pipe.close();
      }
    },
    /**
     * Новый адрес подтверждается сертификатом и hello той же машины.
     * Успешный ответ другого pin не может заменить доверие старого профиля.
     */
    async verifyAddress(profile) {
      if (profile.kind === 'remote') {
        const hello = await pinnedJson({
          address: profile.address,
          fp: profile.fp!,
          identity: await options.identity.load(options.identityDirectory),
        }, '/api/client/hello');

        if (hello.fp !== profile.fp) {
          throw new Error(desktopText('desktop.wrongServer'));
        }
      }
    },
    /**
     * Личность загружается до создания удалённого транспорта.
     * Отмена во время чтения ключа запрещает поздний запуск сокета.
     */
    upstream(profile, report) {
      let transport: ReturnType<typeof createUpstream> | null = null;
      let cancelled = false;
      const controller = new AbortController();
      const ready = (async () => {
        const identity = profile.kind === 'remote'
          ? await options.identity.load(options.identityDirectory) : undefined;

        if (cancelled) {
          return;
        }

        if (profile.kind === 'local') {
          await options.prepareLocal?.(profile, { signal: controller.signal });
        }

        if (cancelled) {
          return;
        }

        transport = createUpstream({
          address: profile.address,
          fp: profile.fp || undefined,
          identity,
          appApi,
          windowKey: () => options.windowKey(profile),
          onState: report,
        });
      })();

      return {
        state: () => transport?.state(),
        /**
         * Недоступность личности показывается как требование новой привязки.
         * Ошибка загрузки ключа не раскрывается в журнале renderer.
         */
        async probe() {
          try {
            await ready;
            await transport?.probe();
          } catch (error) {
            const local = profile.kind === 'local';

            report({
              status: local ? 'offline' : 'unpaired',
              detail: local ? {
                code: 'server_start_failed',
                message: error instanceof Error ? error.message : desktopText('desktop.serverNotPrepared'),
              } : { code: 'identity_unavailable' },
              serverApi: null,
            });
          }
        },
        /**
         * Запрос не опережает async-подготовку местного сервера или личности remote.
         * Отказ подготовки возвращается через ту же трубу без создания раннего транспорта.
         */
        async request(req, res) {
          await ready.catch(() => {});

          if (transport) {
            await transport.request(req, res);
          } else {
            json(res, 503, {
              error: profile.kind === 'local' ? 'server_start_failed' : 'identity_unavailable',
            });
          }
        },
        upgrade(req, socket, head) {
          void ready.then(() => {
            if (transport) {
              transport.upgrade(req, socket, head);
            } else {
              socket.destroy();
            }
          }).catch(() => socket.destroy());
        },
        close() {
          cancelled = true;
          controller.abort();
          transport?.close();
        },
      };
    },
  });

  /**
   * Одна активная подготовка на профиль исключает два listen одного порта.
   * При гонке занятого порта выбор повторяется и сохраняется перед навигацией.
   */
  async function origin(id: string | null): Promise<string> {
    const running = pipes.get(id);

    if (running) {
      return running.origin;
    }

    if (pending.has(id)) {
      return pending.get(id)!;
    }

    const starting = (async () => {
      const upstream = id ? {
        state: () => shell.state(),
        request(req: IncomingMessage, res: ServerResponse) {
          const target = shell.upstream(id);

          if (target) {
            return target.request(req, res);
          }

          json(res, 503, { error: 'disconnected' });
        },
        upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
          const target = shell.upstream(id);

          if (target) {
            target.upgrade(req, socket, head);
          } else {
            socket.end('HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n');
          }
        },
      } : null;

      for (let attempt = 0; attempt < 99; attempt += 1) {
        const port = id ? await profiles.claimPort(id) : 47100;

        try {
          const pipe = await startPipe({
            port,
            uiDir: options.uiDir,
            secret: options.secret,
            appApi,
            upstream,
            shell,
          });

          pipes.set(id, pipe);
          await options.onOrigin(pipe.origin, id !== null && originalPorts.get(id) !== port);

          if (id !== null) {
            originalPorts.set(id, port);
          }

          return pipe.origin;
        } catch (error) {
          if (!id || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
            throw error;
          }
        }
      }

      throw new Error(desktopText('desktop.localPortFailure'));
    })().finally(() => pending.delete(id));

    pending.set(id, starting);

    return starting;
  }

  return {
    shell,
    profiles,
    origin,
    /**
     * Сохранённый выбор приоритетнее локальной установки; первый местный запуск не требует выбора машины.
     * Документ открывается до готовности сервера, который подготавливается в фоне.
     */
    async start() {
      if (!options.settings.selected && options.localAvailable()) {
        const local = options.settings.profiles.find((profile) => profile.kind === 'local')
          || await profiles.add({
            name: 'Этот компьютер',
            kind: 'local',
            address: options.localAddress(),
            fp: null,
          });

        await profiles.select(local.id);
      }

      const id = options.settings.selected;
      const address = await origin(id);

      if (id) {
        void shell.connect(id);
      }

      return address;
    },
    async close() {
      shell.close();
      await Promise.all([...pipes.values()].map((pipe) => pipe.close()));
    },
  };
}
