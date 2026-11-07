import type { PrefsStore } from '../prefsStore.ts';

/**
 * Закрытие приложения не превращает выбранный GrigDesk в незаметный headless fallback.
 * Настройка survives server restart и снимается только явным действием человека.
 */
export function createBrowserRouting(prefs: Pick<PrefsStore, 'read' | 'write'>) {
  return {
    mode(): 'legacy' | 'grigdesk' {
      return prefs.read().browserAgentMode === 'grigdesk' ? 'grigdesk' : 'legacy';
    },
    set(mode: 'legacy' | 'grigdesk'): void {
      prefs.write({ browserAgentMode: mode });
    },
  };
}
