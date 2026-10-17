import { onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';

import { usePluginsStore } from '../stores/plugins.js';
import { useProvidersStore } from '../stores/providers.js';
import { useChatStore } from '../stores/chat.js';
import { useBoardStore } from '../stores/board.js';
import { useHotkeysStore, HOTKEYS_KEY } from '../stores/hotkeys.js';
import { useDeviceStore, WAKE_LOCK_KEY } from '../stores/device.js';
import { useToolLauncher } from '../shared/tools/launcher.ts';
import { api } from '../shared/apiClient.ts';
import { createSettingsWindowChannel } from '../shared/settingsWindowChannel.ts';
import type { ChannelFactory, SettingsWindowChannel } from '../shared/settingsWindowChannel.ts';
import { createSettingsWindowBridge } from '../shared/settingsWindowBridge.ts';

/**
 * Мост живёт вместе с вошедшим AppShell, поэтому намерения принимает только главное окно.
 * Stores перечитывают сохранённое без перезагрузки чата; cleanup отменяет поздние записи prefs.
 */
export function useDesktopSettingsSync(options: { channelFactory?: ChannelFactory } = {}): void {
  const launcher = useToolLauncher();
  const router = useRouter();
  const plugins = usePluginsStore();
  const providers = useProvidersStore();
  const chat = useChatStore();
  const board = useBoardStore();
  const hotkeys = useHotkeysStore();
  const device = useDeviceStore();

  let live = false;
  let channel: SettingsWindowChannel | null = null;
  let bridge: { dispose(): void } | null = null;

  /**
   * Фиксированный набор не зависит от адреса успешной мутации настроек.
   * Ошибка одной области не мешает другим, доска читается только при видимой ошибке.
   */
  async function reread(): Promise<void> {
    const prefs = api.get('/api/settings/prefs').then((value) => {
      if (!live) {
        return;
      }

      const window = value && typeof value === 'object' && 'chatAutoCompactWindow' in value
        ? value.chatAutoCompactWindow : 0;

      chat.compactWindow = Math.max(0, Math.round(Number(window) || 0));
    });
    const reads = [plugins.load(), providers.load(), prefs];

    if (board.error) {
      reads.push(board.load(true));
    }

    await Promise.allSettled(reads);
  }

  /**
   * Изменение памяти другого окна применяется без обратной записи.
   * Очистка storage требует перечитать оба независимых предпочтения устройства.
   */
  function onStorage(event: StorageEvent): void {
    if (event.key === null || event.key === HOTKEYS_KEY) {
      hotkeys.reload();
    }

    if (event.key === null || event.key === WAKE_LOCK_KEY) {
      void device.reloadWakeLock();
    }
  }

  onMounted(() => {
    live = true;
    channel = createSettingsWindowChannel(options.channelFactory);
    bridge = createSettingsWindowBridge({
      channel,
      reread,
      openTerminal: (insert) => launcher.openTerminal({ insert }),
      openChat: async (chatKey) => {
        chat.setActive(chatKey);
        await router.push('/chats');

        return true;
      },
    });
    window.addEventListener('storage', onStorage);
  });

  onBeforeUnmount(() => {
    live = false;
    bridge?.dispose();
    channel?.close();
    window.removeEventListener('storage', onStorage);
  });
}
