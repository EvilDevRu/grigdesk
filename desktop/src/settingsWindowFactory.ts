// Создание окна настроек собирает прежний singleton controller через узкие порты.
// Значения Electron, icon и признак упаковки передаёт main; CJS-пути здесь не вычисляются.
import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron';
import { desktopUserAgent, settingsWindowUrl } from '../../shared/desktop/desktopWindowContract.ts';
import { createSettingsWindowController, settingsWindowGeometry } from './settingsWindowController.ts';
import type { SettingsWindowController, WindowRect } from './settingsWindowController.ts';
import { settingsWindowOptions } from './windowSecurity.ts';

interface SettingsWindowFactoryOptions {
  parent: BrowserWindow;
  session: Session;
  origin: string;
  icon: string;
  packaged: boolean;
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  workArea(bounds: WindowRect): WindowRect;
  revealed(): boolean;
  sessionActive(): Promise<boolean>;
  pinnedUrl(): string | undefined;
  configureChild(child: BrowserWindow): void;
  installShortcut(child: BrowserWindow): void;
  showLoadError(): void;
}

/**
 * Роль UA, shortcut и защита потомков устанавливаются до первого loadURL.
 * Контроллер сохраняет владение единственным окном, проверкой входа и его закрытием.
 */
export function createSettingsWindow(options: SettingsWindowFactoryOptions): SettingsWindowController {
  const { parent, session, origin, icon, packaged, createWindow, workArea, revealed, sessionActive,
    pinnedUrl, configureChild, installShortcut, showLoadError } = options;

  return createSettingsWindowController({
    async canOpen() {
      return revealed() && !parent.isDestroyed() && await sessionActive();
    },
    /**
     * Создаёт модальное окно в рабочей области дисплея родителя.
     * Роль UA устанавливается до первого loadURL, потомки получают опции главного.
     */
    create() {
      if (parent.isDestroyed()) {
        return null;
      }

      const bounds = parent.getBounds();
      const geometry = settingsWindowGeometry(bounds, workArea(bounds));
      const child = createWindow(settingsWindowOptions({
        icon,
        packaged,
        parent,
        geometry,
        session,
      }));

      child.removeMenu();
      child.webContents.setUserAgent(desktopUserAgent(child.webContents.getUserAgent(), 'settings'));
      child.on('page-title-updated', (event) => event.preventDefault());
      installShortcut(child);
      configureChild(child);

      return child;
    },
    load: (child) => (child as BrowserWindow).loadURL(settingsWindowUrl(pinnedUrl() ?? origin)),
    onClosed() {
      if (!parent.isDestroyed()) {
        parent.focus();
      }
    },
    onLoadFailed: showLoadError,
  });
}
