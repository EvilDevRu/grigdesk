import { createApp, h, onBeforeUnmount, ref } from 'vue';
import { setUiLocale, uiLocale } from '../src/ui.ts';
import { resolveLocale } from '../../shared/i18n/core.ts';
import { helpResourceFile } from '../../shared/help/helpContracts.ts';
import HelpBrowser from '../src/features/help/HelpBrowser.vue';
import { createHelpLoader } from '../src/shared/helpLoader.ts';
import type { HelpLoadState } from '../src/shared/helpLoader.ts';
import '../src/styles/index.css';

setUiLocale(resolveLocale(new URL(location.href).searchParams.get('lang'), navigator.language));
document.documentElement.lang = uiLocale.value;
document.documentElement.style.overflow = 'auto';
/**
 * Сайт зависит только от собственного неизменяемого пакета и hash-ссылок статей.
 * Авторизация приложения, модель, плагины и API выбранной машины сюда не подключаются.
 */
const app = createApp({
  /**
   * Самостоятельная страница использует общий reader без stores приложения.
   * Hash выбирает статью, а запрос данных идёт только к соседнему help.json.
   */
  setup() {
    const state = ref<HelpLoadState>({
      status: 'loading',
      bundle: null,
      error: ''
    });
    const articleId = ref('overview');
    const fragment = ref('');
    const locationChanged = () => {
      const match = /^#\/help\/([a-z][a-z0-9-]*)(?:#(.*))?$/u.exec(location.hash);

      articleId.value = match?.[1] ?? 'overview';
      fragment.value = match?.[2] ?? '';
    };
    const loader = createHelpLoader(async () => {
      const file = helpResourceFile(uiLocale.value === 'en' ? 'en' : 'ru');
      const response = await fetch(new URL(`./${file}`, document.baseURI), {
        credentials: 'omit', signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw new Error('help_unavailable');
      }

      return response.json();
    }, (value) => {
      state.value = value;
    });

    locationChanged();
    window.addEventListener('hashchange', locationChanged);
    void loader.reload();
    onBeforeUnmount(() => {
      loader.cancel();
      window.removeEventListener('hashchange', locationChanged);
    });

    return () => h(HelpBrowser, {
      ...state.value,
      articleId: articleId.value,
      fragment: fragment.value,

      canAsk: false,
      showWebsite: false,
      onNavigate: (id: string, hash: string) => {
        location.hash = `/help/${id}${hash ? `#${hash}` : ''}`;
      },
      onRetry: () => void loader.reload(),
    });
  },
});

app.mount('#app');
