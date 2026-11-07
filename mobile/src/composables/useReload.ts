import { onMounted, onScopeDispose, watch } from 'vue';

import { onSignal, useLinkStore } from '../stores/link.ts';

/**
 * Экран подписывается на общий поток и снимает подписку при уходе с route.
 * Смена поколения перечитывает ресурс; reconnect принадлежит native владельцу.
 */
export function useReload(
  load: () => Promise<unknown>,
  names: string[],
  accepts: (value: any) => boolean = () => true,
) {
  const link = useLinkStore();
  const reload = () => {
    if (link.state?.unlocked) {
      void load();
    }
  };
  const remove = onSignal((name, value) => {
    if (name === 'ready' || (names.includes(name) && accepts(value))) {
      reload();
    }
  });

  onMounted(reload);
  watch(() => link.state?.generation, reload);
  onScopeDispose(remove);
}
