import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Event,
  Session,
  WebContents,
  WebContentsWillNavigateEventParams,
  WebContentsWillRedirectEventParams,
} from 'electron';
import type { WindowState } from './settings.ts';
import { isSettingsWindowRequest } from '../../shared/desktop/desktopWindowContract.ts';

export const LOCAL_PARTITION = 'persist:grigdesk-local';

export type PipeOrigins = string | ReadonlySet<string>;

export type SessionLike = Pick<Session,
  'setSpellCheckerEnabled' | 'setSpellCheckerDictionaryDownloadURL' | 'setSpellCheckerLanguages' |
  'setPermissionRequestHandler' | 'setPermissionCheckHandler' | 'webRequest' | 'clearStorageData'>;

export type ContentsLike = Pick<WebContents, 'on' | 'setWindowOpenHandler'>;

export type ContentsGuardOptions = {
  origin: PipeOrigins;
  openExternal: (url: string) => Promise<unknown> | void;
  childOptions: BrowserWindowConstructorOptions;
  onChild?: (child: BrowserWindow) => void;
  onSettingsRequest?: () => void;
};

/**
 * Все окна используют один набор безопасных browser preferences.
 * Общая фабрика не позволяет модальному окну ослабить sandbox или включить Node.
 */
export function secureWebPreferences(packaged: boolean) {
  return {
    partition: LOCAL_PARTITION,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
    devTools: !packaged,
    webviewTag: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
  };
}

const guardedContents = new WeakSet<ContentsLike>();

/**
 * Окно показывает локальный веб в изолированном renderer с песочницей Chromium.
 * Привилегии Node остаются в главном процессе, инструменты разработчика — только в dev.
 */
export function windowOptions(
  icon: string,
  packaged: boolean,
  size: WindowState,
): BrowserWindowConstructorOptions {
  return {
    width: size.width,
    height: size.height,
    minWidth: 600,
    minHeight: 600,
    title: 'GrigDesk',
    frame: false,
    show: false,
    autoHideMenuBar: false,
    backgroundColor: '#0b0d11',
    icon,
    webPreferences: secureWebPreferences(packaged),
  };
}

/**
 * Собственным считается только обычный HTTP-адрес без встроенных credentials.
 * Совпадение вложенного origin у blob не даёт документу полномочий окна.
 */
export function sameOrigin(target: string, origin: PipeOrigins): boolean {
  try {
    const url = new URL(target);

    return url.protocol === 'http:' && !url.username && !url.password
      && (typeof origin === 'string' ? url.origin === origin : origin.has(url.origin));
  } catch {
    return false;
  }
}

/**
 * Политика главного фрейма отделяет свой сайт, системный браузер и отказ.
 * Обработчики событий применяют это решение также к redirect.
 */
export function navigationDecision(target: string, origin: PipeOrigins): 'allow' | 'external' | 'deny' {
  if (sameOrigin(target, origin)) {
    return 'allow';
  }

  return externalUrl(target) ? 'external' : 'deny';
}

/**
 * Собственная ссылка в новом окне должна получить защищённое дочернее окно.
 * Все остальные адреса проходят ту же границу схем, что и навигация.
 */
export function openDecision(target: string, origin: PipeOrigins): 'child' | 'external' | 'deny' {
  const decision = navigationDecision(target, origin);

  return decision === 'allow' ? 'child' : decision;
}

/**
 * Разрешения выдаются только своему origin и ограниченному списку возможностей.
 * Медиа требует явного непустого набора, содержащего исключительно audio.
 */
export function permissionAllowed(
  permission: string,
  requestingUrl: string,
  origin: PipeOrigins,
  mediaTypes: readonly string[],
): boolean {
  if (!sameOrigin(requestingUrl, origin)) {
    return false;
  }

  if (permission === 'media') {
    return Array.isArray(mediaTypes) && mediaTypes.length > 0 && mediaTypes.every((type) => type === 'audio');
  }

  return ['notifications', 'clipboard-sanitized-write', 'fullscreen'].includes(permission);
}

/**
 * Блокирует ровно штатный script service worker своего origin независимо от query.
 * Остальные запросы остаются доступными браузерному интерфейсу GrigDesk.
 */
export function serviceWorkerBlocked(target: string, origin: PipeOrigins): boolean {
  return sameOrigin(target, origin) && new URL(target).pathname === '/sw.js';
}

/**
 * Подготавливает отдельную сессию до загрузки сайта: запрет SW и очистка его кэшей.
 * Обработчики разрешений используют реальные поля обоих callback Electron.
 */
export async function configureSession(session: SessionLike, origin: PipeOrigins): Promise<void> {
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const shell = sameOrigin(details.url, origin) && new URL(details.url).pathname.startsWith('/__shell/');

    callback({ cancel: serviceWorkerBlocked(details.url, origin)
      || (shell && (!details.frame || details.frame.parent !== null)) });
  });
  await session.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });

  session.setSpellCheckerEnabled(false);
  session.setSpellCheckerLanguages([]);
  session.setSpellCheckerDictionaryDownloadURL('http://127.0.0.1:9/');
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes ?? [] : [];
    const securityOrigin = 'securityOrigin' in details ? details.securityOrigin : undefined;
    const securityAllowed = permission !== 'media' || securityOrigin === undefined ||
      (typeof securityOrigin === 'string' && sameOrigin(securityOrigin, origin));

    callback(details.isMainFrame === true && securityAllowed
      && permissionAllowed(permission, details.requestingUrl, origin, mediaTypes));
  });
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    const securityAllowed = details.securityOrigin === undefined ||
      sameOrigin(details.securityOrigin, origin);
    const mediaTypes = details.mediaType === undefined ? [] : [details.mediaType];

    return details.isMainFrame === true && securityAllowed
      && permissionAllowed(permission, requestingOrigin, origin, mediaTypes);
  });
}

/**
 * Передаёт браузеру только канонический разрешённый адрес из политики внешних ссылок.
 * Исключение shell не должно превращаться в необработанный Promise rejection окна.
 */
async function openInBrowser(
  target: string,
  openExternal: ContentsGuardOptions['openExternal'],
): Promise<void> {
  const url = externalUrl(target);

  if (!url) {
    return;
  }

  try {
    await openExternal(url);
  } catch {
    // Навигация уже отменена; отказ системного браузера не ослабляет эту границу.
  }
}

/**
 * URL берётся из первого аргумента Electron 44, без deprecated позиционных полей.
 * Подфреймы сохраняют браузерное поведение, главный фрейм следует общей политике.
 */
function guardNavigation(
  event: Event<WebContentsWillNavigateEventParams | WebContentsWillRedirectEventParams>,
  options: ContentsGuardOptions,
): void {
  if (!event.isMainFrame) {
    return;
  }

  const decision = navigationDecision(event.url, options.origin);

  if (decision === 'allow') {
    return;
  }

  event.preventDefault();

  if (decision === 'external') {
    void openInBrowser(event.url, options.openExternal);
  }
}

/**
 * Применяет решения навигации к главным фреймам и безопасно создаёт дочерние окна.
 * Повторное подключение не умножает обработчики, потомки получают ту же защиту синхронно.
 */
export function guardContents(contents: ContentsLike, options: ContentsGuardOptions): void {
  if (guardedContents.has(contents)) {
    return;
  }

  guardedContents.add(contents);
  contents.on('will-navigate', (event) => guardNavigation(event, options));
  contents.on('will-redirect', (event) => guardNavigation(event, options));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler((details) => {
    if (options.onSettingsRequest && sameOrigin(details.url, options.origin)
      && isSettingsWindowRequest(details.url, new URL(details.url).origin)) {
      try {
        options.onSettingsRequest();
      } catch {
        // Отказ открытия не превращает специальный адрес в обычное дочернее окно.
      }

      return { action: 'deny' };
    }

    const decision = openDecision(details.url, options.origin);

    if (decision === 'child') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...options.childOptions,
          show: true,
          // Произвольный документ потомка не обязан иметь топбар и область перетаскивания.
          titleBarStyle: 'default',
          titleBarOverlay: false,
          frame: true,
          webPreferences: {
            ...options.childOptions.webPreferences,
            partition: LOCAL_PARTITION,
          },
        },
      };
    }

    if (decision === 'external') {
      void openInBrowser(details.url, options.openExternal);
    }

    return { action: 'deny' };
  });
  contents.on('did-create-window', (child) => {
    if (guardedContents.has(child.webContents)) {
      return;
    }

    guardContents(child.webContents, options);
    options.onChild?.(child);
  });
}

/**
 * Внешняя ссылка передаётся системному браузеру только как канонический http(s) URL.
 * Credentials, локальные схемы и слишком длинные строки не достигают shell.
 */
export function externalUrl(target: string): string | null {
  try {
    const url = new URL(target);

    return target.length <= 8192 && ['http:', 'https:'].includes(url.protocol) &&
      !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Прежнее окно сохраняло сессию сервера в общей partition и могло переслать её другому порту.
 * Перед установкой нового секрета удаляются и прежние секреты трубы с любыми Path.
 */
export async function clearLegacyCookies(cookies: Pick<Session['cookies'], 'get' | 'remove'>): Promise<void> {
  for (const cookie of await cookies.get({ domain: '127.0.0.1' })) {
    const url = `${cookie.secure ? 'https' : 'http'}://127.0.0.1${cookie.path || '/'}`;

    await cookies.remove(url, cookie.name);
  }
}
