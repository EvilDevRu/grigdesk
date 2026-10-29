interface DirectoryWindow {
  isDestroyed(): boolean;
  webContents: { isDestroyed(): boolean; getURL(): string };
}

interface DirectorySelectionOptions<Window extends DirectoryWindow> {
  getWindow(): Window | null | undefined;
  showOpenDialog(window: Window, options: { properties: ['openDirectory'] }): Promise<{
    canceled: boolean;
    filePaths: string[];
  }>;
}

/**
 * Диалог принадлежит текущему главному окну и не принимает параметры от renderer.
 * Повторная проверка окна и origin скрывает путь при навигации во время ожидания.
 */
export function createDirectorySelector<Window extends DirectoryWindow>(
  options: DirectorySelectionOptions<Window>,
): (origin: string) => Promise<string | null> {
  return async (origin) => {
    const parent = options.getWindow();
    const valid = () => {
      if (!parent || parent !== options.getWindow() || parent.isDestroyed()
        || parent.webContents.isDestroyed()) {
        return false;
      }

      return new URL(parent.webContents.getURL()).origin === origin;
    };

    if (!valid() || !parent) {
      throw new Error('Окно выбора папки больше не доступно');
    }

    const result = await options.showOpenDialog(parent, { properties: ['openDirectory'] });

    if (!valid()) {
      throw new Error('Окно выбора папки изменилось');
    }

    return result.canceled ? null : result.filePaths[0] ?? null;
  };
}
