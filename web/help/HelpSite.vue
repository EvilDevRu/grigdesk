<template>
  <main class="help-site">
    <UiPaneHeader>
      <template #title>
        <h1 class="help-site-title"><UiHelpIcon />{{ t('core.helpTitle') }}</h1>
      </template>
      <template #actions>
        <UiSelect v-model="preference" :aria-label="t('core.helpLanguage')">
          <option value="system">{{ t('core.system') }}</option>
          <option v-for="locale in locales" :key="locale.id" :value="locale.id">{{ locale.name }}</option>
        </UiSelect>
      </template>
    </UiPaneHeader>
    <HelpBrowser v-bind="state" :article-id="articleId" :fragment="fragment" :show-website="false" embedded
                 @navigate="navigate" @retry="reload" />
  </main>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { locales, setUiLocale, t, UiHelpIcon, UiPaneHeader, UiSelect } from '../src/ui.ts';
import { resolveLocale } from '../../shared/i18n/core.ts';
import { createHelpLoader } from '../src/shared/helpLoader.ts';
import type { HelpLoadState } from '../src/shared/helpLoader.ts';
import type { HelpLocale } from '../../shared/help/helpContracts.ts';
import HelpBrowser from '../src/features/help/HelpBrowser.vue';

const storageKey = 'grigdesk-help-language';
const preference = ref(initialPreference());
const state = ref<HelpLoadState>({
  status: 'loading',
  bundle: null,
  error: ''
});
const articleId = ref('overview');
const fragment = ref('');
const loader = createHelpLoader(async (locale) => {
  const file = locale === 'en' ? 'help.en.json' : 'help.json';
  const response = await fetch(new URL(`./${file}`, document.baseURI), {
    credentials: 'omit',
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw Object.assign(new Error('help_unavailable'), {
      status: response.status,
      data: locale === 'en' && response.status === 404 ? { error: 'help_locale_unavailable' } : {}
    });
  }

  return response.json();
}, (value) => {
  state.value = value;
});

function valid(value: unknown): value is string {
  return value === 'system' || value === 'ru' || value === 'en';
}

/**
 * Язык URL важнее сохранённого выбора читателя; неизвестное значение использует систему.
 * Запрет хранилища не мешает автономному чтению соседних ресурсов выпуска.
 */
function initialPreference(): string {
  const query = new URLSearchParams(location.search).get('locale');

  if (valid(query)) {
    return query;
  }

  try {
    const stored = localStorage.getItem(storageKey);

    if (valid(stored)) {
      return stored;
    }
  } catch {
    // URL и язык системы доступны даже при запрете постоянного хранилища.
  }

  return 'system';
}

/**
 * UI и корпус переключаются вместе по разрешённой локали текущего предпочтения.
 * Повтор загрузки сохраняет выбор и не трогает hash открытой статьи.
 */
function reload(): void {
  const locale = resolveLocale(preference.value, navigator.language, locales) as HelpLocale;

  setUiLocale(locale);
  document.documentElement.lang = locale;
  void loader.reload(locale);
}

/**
 * Hash хранит только стабильный ID статьи и необязательный фрагмент её локального текста.
 * Смена языка не меняет историю переходов и не выбирает другую статью.
 */
function locationChanged(): void {
  const match = /^#\/help\/([a-z][a-z0-9-]*)(?:#(.*))?$/u.exec(location.hash);

  articleId.value = match?.[1] ?? 'overview';
  fragment.value = match?.[2] ?? '';
}

function navigate(id: string, hash: string): void {
  location.hash = `/help/${id}${hash ? `#${hash}` : ''}`;
}

watch(preference, (value) => {
  const url = new URL(location.href);

  url.searchParams.set('locale', value);
  history.replaceState(null, '', url);

  try {
    localStorage.setItem(storageKey, value);
  } catch {
    // Выбор продолжает действовать в текущем URL без записи на устройство.
  }

  reload();
});
locationChanged();
reload();
window.addEventListener('hashchange', locationChanged);
onBeforeUnmount(() => {
  loader.cancel();
  window.removeEventListener('hashchange', locationChanged);
});
</script>

<style scoped>
.help-site {
  display: flex;
  flex-direction: column;
  height: 100dvh;
}

.help-site-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.help-site-title svg {
  width: 16px;
  height: 16px;
}

.help-site > .help-browser {
  flex: 1;
}
</style>
