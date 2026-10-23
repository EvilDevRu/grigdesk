import { locales, localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { resolveLocale } from '../../../shared/i18n/core.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { API_VERSION } from '../../../shared/client/apiVersion.ts';
import type { ApiVersion, MachineProfile, ShellState } from '../../../shared/client/clientShell.ts';
import { localOrigin } from '../connection.ts';
import { normalizeProfile } from '../profiles.ts';
import type { DesktopProfile, Profiles } from '../profiles.ts';
import type { PipeUpstream } from './pipeServer.ts';
import { json } from './pipeServer.ts';
import type { UpstreamState } from './upstream.ts';
import { parseSurfaceTarget, parseMainRequest } from '../../../shared/desktop/surfaceContract.ts';
import type { MainRequest, SurfaceTarget } from '../../../shared/desktop/surfaceContract.ts';

interface ProbeUpstream extends PipeUpstream {
  probe(): Promise<void>;
}

export interface NativeWindows {
  open(origin: string, target: SurfaceTarget): Promise<boolean>;
  main(origin: string, request: MainRequest): Promise<boolean>;
}

interface ShellOptions {
  beforeSelect?(profile: DesktopProfile): Promise<void>;
  nativeWindows?: NativeWindows;
  profiles: Profiles;
  systemLanguage?: string;
  saveLocale?(): Promise<void>;
  onLocale?(preference: string): void;
  pairing: { addByPairing(text: string): Promise<DesktopProfile> };
  appApi?: ApiVersion;
  localAvailable(): boolean;
  localAddress(): string;
  navigate(id: string | null): Promise<void>;
  removed?(id: string): void | Promise<void>;
  upstream(profile: DesktopProfile, report: (state: UpstreamState) => void): ProbeUpstream;
  verifyAddress?(profile: DesktopProfile): Promise<void>;
  random?: () => number;
  schedule?: (callback: () => void, delay: number) => () => void;
}

/**
 * JSON управления ограничен отдельно от прикладных потоков и загрузок файлов.
 * Ошибка не включает строку привязки или другое содержимое запроса.
 */
async function readBody(req: IncomingMessage, locale: string): Promise<Record<string, unknown>> {
  const t = localeTranslator(locale);
  let text = '';

  for await (const chunk of req) {
    text += String(chunk);

    if (text.length > 65536) {
      throw new Error(t('desktop.shellRequestTooLarge'));
    }
  }

  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

/**
 * Оболочка владеет публичным состоянием, long-poll и жизнью транспорта профиля.
 * Повторяется только offline; ручное отключение и терминальные причины гасят таймеры.
 */
export function createShellApi(options: ShellOptions) {
  const appApi = options.appApi || API_VERSION;
  const transports = new Map<string, ProbeUpstream>();
  const states = new Map<string, UpstreamState>();
  const retries = new Map<string, () => void>();
  const attempts = new Map<string, number>();
  const generations = new Map<string, number>();
  const disabled = new Set<string>();
  const waiters = new Set<() => void>();
  const schedule = options.schedule || ((callback: () => void, delay: number) => {
    const timer = setTimeout(callback, delay);

    timer.unref();

    return () => clearTimeout(timer);
  });
  let rev = 0;
  let localeQueue = Promise.resolve();
  let closed = false;
  let selectionQueue = Promise.resolve();

  const changed = () => {
    rev += 1;

    for (const wake of [...waiters]) {
      wake();
    }
  };
  const publicProfile = (profile: DesktopProfile): MachineProfile => ({
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    address: profile.address,
    status: states.get(profile.id)?.status || 'none',
  });
  /**
   * Публичный снимок содержит только сведения, нужные интерфейсу.
   * Закрытый ключ, pin и внутренние порты профилей не уходят в renderer.
   */
  const state = (): ShellState => {
    const selected = options.profiles.settings.profiles.find((item) =>
      item.id === options.profiles.settings.selected);
    const connection = selected ? states.get(selected.id) : null;

    return {
      rev,
      ...(options.systemLanguage === undefined ? {} : {
        locale: {
          preference: options.profiles.settings.uiLanguage ?? 'system',
          systemLanguage: options.systemLanguage,
        },
      }),
      profile: selected ? publicProfile(selected) : null,
      profiles: options.profiles.settings.profiles.map(publicProfile),
      status: connection?.status || (selected ? 'offline' : 'none'),
      detail: connection?.detail || null,
      serverApi: connection?.serverApi || null,
      appApi,
      capabilities: options.nativeWindows ? ['windows'] : [],
      localAvailable: options.localAvailable(),
    };
  };

  /**
   * Повтор имеет ограниченную экспоненту и jitter от подменяемого источника случайности.
   * Отменённый callback проверяет поколение, даже если уже попал в очередь событий.
   */
  const retry = (id: string) => {
    if (closed || disabled.has(id) || retries.has(id)) {
      return;
    }

    const attempt = attempts.get(id) || 0;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
    const generation = generations.get(id);
    const duration = Math.round(delay * (0.8 + (options.random || Math.random)() * 0.4));

    attempts.set(id, attempt + 1);
    retries.set(id, schedule(() => {
      retries.delete(id);

      if (closed || disabled.has(id) || generations.get(id) !== generation) {
        return;
      }

      return connect(id, false);
    }, duration));

    const current = states.get(id);

    if (current) {
      const previous = current.detail;
      const detail = previous && ['server_start_failed', 'server_start_timeout'].includes(previous.code)
        ? previous : { code: 'retry_wait' };

      states.set(id, { ...current, detail: { ...detail, retryAt: Date.now() + duration } });
      changed();
    }
  };

  /**
   * Повтор одинакового ответа API не создаёт новую ревизию бесконечного long-poll.
   * Любая терминальная причина отменяет ранее назначенный offline-повтор.
   */
  const report = (id: string, value: UpstreamState) => {
    if (value.detail?.code === 'server_start_timeout' && states.get(id)?.status === 'online') {
      return;
    }

    if (JSON.stringify(states.get(id)) !== JSON.stringify(value)) {
      states.set(id, value);
      changed();
    }

    if (value.status === 'offline') {
      retry(id);
    } else {
      retries.get(id)?.();
      retries.delete(id);

      if (value.status === 'online') {
        attempts.delete(id);
      }
    }
  };

  /**
   * Новое подключение уничтожает прежние сокеты и начинает отдельное поколение.
   * Поздний ответ закрытого транспорта не может вернуть профиль в online.
   */
  const connect = async (id = options.profiles.settings.selected, manual = true): Promise<void> => {
    if (!id || closed) {
      return;
    }

    if (!manual && (disabled.has(id)
      || !['offline', 'connecting'].includes(states.get(id)?.status || 'none'))) {
      return;
    }

    if (manual) {
      disabled.delete(id);
      attempts.delete(id);
    }

    retries.get(id)?.();
    retries.delete(id);
    transports.get(id)?.close?.();

    const generation = (generations.get(id) || 0) + 1;

    generations.set(id, generation);
    report(id, {
      status: 'connecting',
      detail: null,
      serverApi: null,
    });

    const transport = options.upstream(options.profiles.get(id), (value) => {
      if (!disabled.has(id) && generations.get(id) === generation) {
        report(id, value);
      }
    });

    transports.set(id, transport);

    try {
      await transport.probe();
    } catch {
      if (!disabled.has(id) && generations.get(id) === generation) {
        report(id, {
          status: 'offline',
          detail: null,
          serverApi: null,
        });
      }
    }
  };

  /**
   * Отключение запрещает повтор и уничтожает сокеты текущего профиля.
   * Поздний callback транспорта отбрасывается по disabled и поколению.
   */
  const disconnect = (id = options.profiles.settings.selected) => {
    if (!id) {
      return;
    }

    disabled.add(id);
    retries.get(id)?.();
    retries.delete(id);
    transports.get(id)?.close?.();
    transports.delete(id);
    states.set(id, {
      status: 'offline',
      detail: { code: 'disconnected', message: 'Отключено' },
      serverApi: null,
    });
    changed();
  };
  /**
   * Выбор сохраняется перед навигацией на отдельный origin профиля.
   * Прежнее подключение закрывается, новая попытка не задерживает загрузку UI.
   */
  const selectNow = async (id: string | null) => {
    const previous = options.profiles.settings.selected;

    if (previous === id) {
      return;
    }

    if (id) {
      await options.beforeSelect?.(options.profiles.get(id));
    }

    if (previous && previous !== id) {
      disconnect(previous);
    }

    await options.profiles.select(id);
    changed();

    if (id) {
      void connect(id);
    }
  };

  const select = (id: string | null) => {
    const operation = selectionQueue.then(() => selectNow(id));

    selectionQueue = operation.catch(() => {});

    return operation;
  };

  /**
   * Неизменившаяся ревизия ожидает изменение либо таймаут, не занимая прикладной SSE.
   * Уход документа и закрытие оболочки освобождают таймер и подписку.
   */
  const poll = (req: IncomingMessage, res: ServerResponse) => {
    let cancel = () => {};
    const wake = () => {
      cancel();
      waiters.delete(wake);

      if (!res.writableEnded) {
        json(res, 200, state());
      }
    };

    waiters.add(wake);
    cancel = schedule(wake, 25000);
    res.once('close', () => {
      cancel();
      waiters.delete(wake);
    });
  };

  /**
   * Набор маршрутов совпадает с web-клиентом; мобильные capabilities здесь отсутствуют.
   * Навигация вызывается после ответа, поэтому смена origin не обрывает действие формы.
   */
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url || '/', 'http://pipe');
    const pathname = url.pathname;
    const locale = options.systemLanguage === undefined ? 'ru'
      : resolveLocale(options.profiles.settings.uiLanguage, options.systemLanguage, locales);
    const t = localeTranslator(locale);

    try {
      if (req.method === 'GET' && pathname === '/__shell/state') {
        if (url.searchParams.has('rev') && Number(url.searchParams.get('rev')) === rev) {
          poll(req, res);
        } else {
          json(res, 200, state());
        }

        return;
      }

      const body = await readBody(req, locale);

      if (req.method === 'POST' && pathname === '/__shell/locale') {
        const preference = body.preference;

        if (Object.keys(body).length !== 1 || typeof preference !== 'string'
          || (preference !== 'system' && !locales.some((item) => item.id === preference))) {
          throw new Error(t('desktop.shellInvalidLanguage'));
        }

        const save = localeQueue.catch(() => {}).then(async () => {
          const previous = options.profiles.settings.uiLanguage;

          options.profiles.settings.uiLanguage = preference;

          try {
            await options.saveLocale?.();
          } catch (error) {
            options.profiles.settings.uiLanguage = previous;

            throw error;
          }

          options.onLocale?.(preference);
          changed();
        });

        localeQueue = save;
        await save;
        json(res, 200, state());

        return;
      }

      if (req.method === 'POST' && pathname.startsWith('/__shell/surfaces/')) {
        if (!options.nativeWindows) {
          json(res, 404, { error: 'not_found' });

          return;
        }

        const target = pathname === '/__shell/surfaces/open' ? parseSurfaceTarget(body) : null;
        const request = pathname === '/__shell/surfaces/main' ? parseMainRequest(body) : null;

        if (!target && !request) {
          json(res, 400, { error: 'invalid_surface', message: 'Неверное действие окна.' });

          return;
        }

        const origin = new URL('http://' + req.headers.host).origin;
        const opened = target
          ? await options.nativeWindows.open(origin, target)
          : await options.nativeWindows.main(origin, request!);

        json(res, 200, { opened });

        return;
      }

      let navigation: string | null | undefined;
      let removed: string | undefined;

      if (req.method === 'POST' && pathname === '/__shell/profiles') {
        let profile: DesktopProfile;

        if (body.local === true && options.localAvailable()) {
          profile = await options.profiles.add({
            name: 'Этот компьютер',
            kind: 'local',
            address: options.localAddress(),
            fp: null,
          });
        } else if (typeof body.pairing === 'string') {
          profile = await options.pairing.addByPairing(body.pairing);
        } else {
          throw new Error(t('desktop.shellPairingRequired'));
        }

        if (profile.id === options.profiles.settings.selected) {
          await connect(profile.id);
        } else {
          await select(profile.id);
        }

        navigation = profile.id;
      } else if (pathname.startsWith('/__shell/profiles/') && req.method === 'DELETE') {
        const id = decodeURIComponent(pathname.slice('/__shell/profiles/'.length));
        const selected = id === options.profiles.settings.selected;

        disconnect(id);
        await options.profiles.remove(id);
        removed = id;
        changed();

        if (selected) {
          navigation = null;
        }
      } else if (pathname.startsWith('/__shell/profiles/') && req.method === 'PATCH') {
        const id = decodeURIComponent(pathname.slice('/__shell/profiles/'.length));
        const profile = options.profiles.get(id);
        const updated = normalizeProfile({ ...profile, ...body });

        if (!updated || Object.keys(body).some((key) => !['name', 'address'].includes(key))) {
          throw new Error(t('desktop.shellInvalidMachineAddress'));
        }

        if (updated.address !== profile.address) {
          if (updated.kind === 'local' && !localOrigin(updated.address)) {
            throw new Error(t('desktop.shellInvalidLocalAddress'));
          }

          if (updated.kind === 'remote' && !options.verifyAddress) {
            throw new Error(t('desktop.shellAddressCheckUnavailable'));
          }

          await options.verifyAddress?.(updated);
        }

        const addressChanged = updated.address !== profile.address;

        await options.profiles.add(updated);
        changed();

        if (addressChanged && options.profiles.settings.selected === id) {
          void connect(id);
        }
      } else if (req.method === 'POST' && pathname === '/__shell/select' && typeof body.id === 'string') {
        if (body.id !== options.profiles.settings.selected) {
          await select(body.id);
          navigation = body.id;
        }
      } else if (req.method === 'POST' && pathname === '/__shell/connect') {
        void connect();
      } else if (req.method === 'POST' && pathname === '/__shell/disconnect') {
        disconnect();
      } else {
        json(res, 404, { error: 'not_found' });

        return;
      }

      json(res, 200, { ok: true });

      if (removed) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await options.removed?.(removed);
      }

      if (navigation !== undefined) {
        await options.navigate(navigation);
      }
    } catch (error) {
      if (!res.headersSent) {
        json(res, 400, { error: 'shell_action_failed', message: (error as Error).message });
      }
    }
  };

  return {
    handle,
    state,
    connect,
    disconnect,
    report,
    /**
     * Этап supervisor не отменяет выбор человека и терминальную причину транспорта.
     * Его прогресс относится только к текущему местному профилю.
     */
    reportBackground(id: string, value: UpstreamState) {
      if (id !== options.profiles.settings.selected || disabled.has(id)
        || !['none', 'offline', 'connecting'].includes(states.get(id)?.status || 'none')) {
        return;
      }

      report(id, value);
    },
    upstream: (id: string) => transports.get(id) || null,
    /**
     * Завершение оболочки освобождает все созданные ею таймеры и сокеты.
     * Ожидающие long-poll получают последний снимок и перестают удерживать сервер.
     */
    close() {
      closed = true;

      for (const cancel of retries.values()) {
        cancel();
      }

      for (const transport of transports.values()) {
        transport.close?.();
      }

      for (const wake of [...waiters]) {
        wake();
      }
    },
  };
}
