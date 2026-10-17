import type { CockpitLink, Listener } from './types.ts';

export type DesktopBridge = {
  invoke(method: string, input?: unknown): Promise<any>;
  onEvent(callback: (name: string, value: unknown) => void): () => void;
};

/**
 * Desktop использует только закрытый preload-мост, без browser fetch и native-плагина.
 * Слушатели разделяют одну подписку IPC, которая снимается после последней отписки.
 */
export function createDesktopLink(bridge: DesktopBridge | undefined): CockpitLink {
  const listeners = new Map<string, Set<(value: any) => void>>();
  let unsubscribe: (() => void) | null = null;

  const requireBridge = () => {
    if (!bridge) {
      throw new Error('Мост приложения недоступен.');
    }

    return bridge;
  };

  const invoke = async (method: string, input?: unknown) => {
    const target = requireBridge();

    return input === undefined ? target.invoke(method) : target.invoke(method, input);
  };

  return {
    getState: () => invoke('getState'),
    addFromText: (input) => invoke('addFromText', input),
    selectRelay: (input) => invoke('selectRelay', input),
    removeRelay: (input) => invoke('removeRelay', input),
    unlock: () => invoke('unlock'),
    request: (input) => invoke('request', input),
    getOutbox: () => invoke('getOutbox'),
    putOutbox: (input) => invoke('putOutbox', input),
    removeOutbox: (input) => invoke('removeOutbox', input),
    startEvents: () => invoke('startEvents'),
    stopEvents: () => invoke('stopEvents'),
    resetDevice: () => invoke('resetDevice'),
    async scanQr() {
      requireBridge();

      throw new Error('Камеры нет: вставьте текст кода из настроек Кокпита.');
    },
    async downloadUpdate() {
      requireBridge();

      throw new Error('Новая версия для компьютера ставится установщиком.');
    },
    /**
     * Путь растра содержит только проверенный hash и поколение разблокировки.
     * Некорректный ответ не превращается в произвольный URL внутри renderer.
     */
    async fetchMedia(input) {
      const result = await invoke('fetchMedia', input);

      if (typeof result?.error === 'string') {
        return { error: result.error };
      }

      if (typeof result?.file !== 'string' || !/^[a-f0-9]{64}$/.test(result.file) ||
        !Number.isSafeInteger(result.generation) || result.generation < 0) {
        return { error: 'network' };
      }

      return { path: 'cockpit-media://media/' + result.generation + '/' + result.file };
    },
    /**
     * Все слушатели используют одну подписку IPC без передачи IpcRendererEvent странице.
     * Последняя отписка освобождает мост, а новая подписка вновь подключает события.
     */
    async addListener(
      name: 'linkEvent' | 'linkState',
      callback: (value: any) => void,
    ): Promise<Listener> {
      const target = requireBridge();
      const group = listeners.get(name) ?? new Set();

      listeners.set(name, group);
      group.add(callback);

      if (!unsubscribe) {
        unsubscribe = target.onEvent((eventName, value) => {
          listeners.get(eventName)?.forEach((listener) => listener(value));
        });
      }

      return {
        remove: async () => {
          group.delete(callback);

          if ([...listeners.values()].every((items) => !items.size) && unsubscribe) {
            unsubscribe();
            unsubscribe = null;
          }
        },
      };
    },
  };
}

export const desktopLink = createDesktopLink((globalThis as typeof globalThis & {
  cockpitDesktop?: DesktopBridge;
}).cockpitDesktop);
