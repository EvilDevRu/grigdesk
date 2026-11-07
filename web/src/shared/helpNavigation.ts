import { watch } from 'vue';
import type { Router } from 'vue-router';
import { useHelpStore } from '../stores/help.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { helpContextId } from '../../../shared/help/helpLinks.ts';
/**
 * Контекстная команда показывает поверх формы только справку о её разделе.
 * Она не закрывает настройки, не применяет черновик и не выбирает рабочий каталог.
 */
export function openHelp(route = globalThis.location?.hash.replace(/^#/u, '') ?? ''): void {
  const settings = useSettingsStore();
  const article = helpContextId(route, settings.isOpen ? settings.pageId : '');

  useHelpStore().open(article);
}
/**
 * Один capture-слушатель работает перед xterm и не принимает параметры из native event.
 * Повторный F1 и скрытый/неавторизованный документ не создают новых действий.
 */
export function installHelpNavigation(target: Window, router: Router, allowed: () => boolean): () => void {
  const open = () => {
    if (allowed()) {
      openHelp(router.currentRoute.value.path);
    }
  };
  const key = (event: KeyboardEvent) => {
    if (event.code === 'F1' && !event.repeat && !event.altKey && !event.ctrlKey
      && !event.metaKey && !event.shiftKey && allowed()) {
      event.preventDefault();
      open();
    }
  };

  target.addEventListener('keydown', key, true);
  target.addEventListener('grigdesk:open-help', open);

  return () => {
    target.removeEventListener('keydown', key, true);
    target.removeEventListener('grigdesk:open-help', open);
  };
}

/**
 * Владелец окна закрывает справку синхронно при потере входа или смене машины/владельца.
 * Восстановление доступа не открывает прежний диалог автоматически.
 */
export function bindHelpAccess(
  auth: { authenticated: boolean; clientScope: string },
  shell: { profile: { id: string } | null },
  close: () => void,
): () => void {
  return watch(() => [auth.authenticated, auth.clientScope, shell.profile?.id], (next, previous) => {
    if (!next[0] || next[1] !== previous?.[1] || next[2] !== previous?.[2]) {
      close();
    }
  }, { immediate: true, flush: 'sync' });
}
