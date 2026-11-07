import type { BrowserWindow, WebContentsView, WebContentsViewConstructorOptions } from 'electron';
import type { BrowserRect } from './browserTabs.ts';

/**
 * Прозрачный native-слой принимает физический ввод поверх занятой страницы.
 * Guest остаётся показанным и получает CDP-ввод агента напрямую, без окна разрешённого ввода.
 */
export function createBrowserInputGuard(options: {
  create(value: WebContentsViewConstructorOptions): WebContentsView;
  window(): BrowserWindow | null;
}) {
  let shield: WebContentsView | null = null;
  let parent: BrowserWindow | null = null;
  let ready: Promise<void> | null = null;

  /**
   * Пустой документ создаёт собственную поверхность Chromium до первой команды.
   * У него нет preload, сетевой страницы и возможности открыть другое окно.
   */
  function prepare(): WebContentsView {
    if (!shield) {
      shield = options.create({ webPreferences: {
        partition: 'grigdesk-browser-input-guard',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      } });
      shield.setBackgroundColor('#00000000');
      shield.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      shield.webContents.on('will-navigate', (event) => event.preventDefault());
      shield.webContents.on('before-input-event', (event) => event.preventDefault());
      shield.webContents.on('before-mouse-event', (event) => event.preventDefault());
      shield.webContents.on('context-menu', (event) => event.preventDefault());
    }

    return shield;
  }

  /**
   * Снятие перехватчика не меняет документ сайта и не активирует чужое окно.
   * Если клавиатура была в пустом shield, возвращаем её основному интерфейсу.
   */
  function hide(): void {
    if (!shield || !parent) {
      return;
    }

    const window = parent;

    parent = null;
    shield.setVisible(false);

    if (!window.isDestroyed()) {
      window.contentView.removeChildView(shield);

      if (window.isFocused() && shield.webContents.isFocused()) {
        window.webContents.focus();
      }
    }
  }

  return {
    ready(): Promise<void> {
      ready ??= prepare().webContents.loadURL('about:blank');

      return ready;
    },
    /**
     * Один ленивый about:blank без preload переиспользуется для всех вкладок.
     * Повторное добавление держит его выше guest после переключений и новых layout.
     */
    show(rect: BrowserRect): void {
      const window = options.window();

      if (!window || window.isDestroyed()) {
        return;
      }

      const view = prepare();

      if (parent && parent !== window) {
        hide();
      }

      parent = window;
      view.setBounds(rect);
      window.contentView.addChildView(view);
      view.setVisible(true);

      if (window.isFocused() && !window.webContents.isFocused()) {
        window.webContents.focus();
      }
    },
    hide,
    /**
     * Ресурс принадлежит runtime браузера, а не отдельной вкладке или mount Vue.
     * Повторная очистка не обращается к уже закрытому WebContents.
     */
    dispose(): void {
      hide();

      if (shield && !shield.webContents.isDestroyed()) {
        shield.webContents.close();
      }

      shield = null;
      ready = null;
    },
  };
}
