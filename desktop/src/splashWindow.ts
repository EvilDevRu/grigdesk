import type {
  BrowserWindowConstructorOptions,
  Rectangle,
  Session,
  WebContents,
} from 'electron';

import { secureWebPreferences } from './windowSecurity.ts';

export const SPLASH_SIZE = {
  width: 720,
  height: 480,
} as const;
export const SPLASH_STATUS_TEXT = 'Загрузка…';
export const SPLASH_BACKGROUND = '#15191f';

export type SplashContentsLike = Pick<WebContents, 'on' | 'setWindowOpenHandler'>;

export type SplashSessionLike = Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>;

/**
 * Заставка держит пропорцию картинки 3:2 и не выходит за рабочую область экрана.
 * Ширина ограничена 720 px, окно ставится по центру области, а не по курсору.
 */
export function splashBounds(area: Rectangle): Rectangle {
  const unit = Math.floor(Math.min(SPLASH_SIZE.width, area.width, area.height * 1.5) / 3);
  const width = unit * 3;
  const height = unit * 2;

  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  };
}

/**
 * Самостоятельное окно без родителя и модальности: при скрытом главном окне оконный
 * менеджер их не учитывает. Сессия только в памяти, остальная защита — как у главного.
 */
export function splashWindowOptions(input: {
  icon: string;
  packaged: boolean;
  bounds: Rectangle;
  session: Session;
}): BrowserWindowConstructorOptions {
  return {
    ...input.bounds,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    title: 'Кокпит',
    icon: input.icon,
    backgroundColor: SPLASH_BACKGROUND,
    webPreferences: {
      ...secureWebPreferences(input.packaged),
      session: input.session,
    },
  };
}

/**
 * Локальной странице заставки не нужны ни переходы, ни новые окна, ни разрешения.
 * Любая попытка отменяется до начала, а сессия заставки отвечает отказом на запросы.
 */
export function guardSplash(contents: SplashContentsLike, session: SplashSessionLike): void {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
}
