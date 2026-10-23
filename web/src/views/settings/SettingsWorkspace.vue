<template>
  <div class="settings-workspace" :data-navigation="navigationVisible" :data-page="settings.pageId">
    <aside class="settings-sidebar" :aria-label="t('settings.settingsNavigation')">
      <UiSearchInput
        v-model="settings.query"
        :aria-label="t('settings.searchSettings')"
        :placeholder="t('settings.findASetting')"
      />
      <p v-if="settings.query.trim()" class="settings-navigation-label">{{ t('settings.searchResults') }}</p>
      <div class="settings-navigation-scroll">
        <SettingsNavigation v-if="!settings.query.trim()" @select="navigationVisible = false" />
        <div
          v-else
          class="settings-results"
          :aria-label="t('settings.searchResults')"
        >
          <UiPressable
            v-for="(result, index) in results"
            :key="index"
            data-settings-result
            data-ui-settings-result
            @click="openResult(result)"
          >
            <span>{{ result.label }}</span>
            <small>{{ result.description }}</small>
          </UiPressable>
          <div v-if="!results.length" class="settings-search-empty" role="status">
            <SettingsIcon name="search" />
            <strong>{{ t('settings.noResults') }}</strong>
            <p>{{ t('settings.tryAnotherWordOrSectionName') }}</p>
          </div>
        </div>
      </div>
    </aside>
    <section class="settings-page-area" aria-labelledby="settings-page-title">
      <div class="settings-page-heading">
        <UiButton class="settings-sections" variant="ghost" @click="navigationVisible = true">
          <span aria-hidden="true">‹</span> {{ t('settings.sections') }}
        </UiButton>
        <p :aria-label="t('settings.sectionPath')">
          {{ group?.label }} <span aria-hidden="true">/</span> <span>{{ page?.label }}</span>
        </p>
      </div>
      <div :key="settings.pageId" class="settings-page-scroll">
        <div class="settings-page-inner">
          <header class="settings-page-intro">
            <h3 id="settings-page-title">{{ page?.label }}</h3>
            <p>{{ page?.description }}</p>
          </header>
          <UiInlineMessage v-if="settings.navigationError" tone="warning">
            {{ settings.navigationError }}
          </UiInlineMessage>
          <component
            :is="component"
            v-if="component"
            :key="settings.pageId"
            :active="true"
          />
          <div v-else class="settings-page-loading" role="status">
            <UiSpinner :label="t('settings.loadingSection')" /> {{ t('settings.loadingSection2') }}
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { t, uiLocale } from '../../ui.ts';

import { computed, ref } from 'vue';
import { UiButton, UiSearchInput, UiPressable, UiInlineMessage, UiSpinner } from '../../ui.ts';
import { useSettingsStore } from '../../stores/settings.ts';
import { getSettingsGroups, getSettingsPages } from '../../features/settings/catalog.ts';
import { searchSettings, type SettingsSearchResult } from '../../features/settings/search.ts';
import { SETTINGS_PAGE_COMPONENTS } from './pageComponents.ts';
import SettingsNavigation from './SettingsNavigation.vue';
import SettingsIcon from './SettingsIcon.vue';

const settings = useSettingsStore();
const navigationVisible = ref(false);
const component = computed(() => SETTINGS_PAGE_COMPONENTS[settings.pageId]);
const page = computed(() => getSettingsPages(uiLocale.value).find((item) => item.id === settings.pageId));
const group = computed(() => getSettingsGroups(uiLocale.value)
  .find((item) => item.id === page.value?.groupId));
const results = computed(() => searchSettings(settings.query, settings.dynamicFields, uiLocale.value));

function openResult(result: SettingsSearchResult): void {
  settings.openSearchResult(result);
  navigationVisible.value = false;
}
</script>

<style scoped>
.settings-workspace {
  display: grid;
  grid-template-columns: 216px minmax(0, 1fr);
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.settings-sidebar {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  min-height: 0;
  padding: 16px 10px;
  border-right: 1px solid var(--line);
  background: var(--sidebar);
}
.settings-navigation-label {
  margin: 0 8px;
  color: var(--ink-mid);
  font-size: 11px;
}
.settings-navigation-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.settings-page-area {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--surface);
}
.settings-page-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 43px;
  padding: 12px 32px 0;
}
.settings-page-heading p {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 8px;
  margin: 0;
  color: var(--ink-low);
  font-size: 11px;
  line-height: 1.5;
}
.settings-page-heading p > span:last-child {
  color: var(--ink-mid);
}
.settings-page-scroll {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.settings-page-inner {
  display: grid;
  align-content: start;
  gap: 24px;
  max-width: 940px;
  margin: 0 auto;
  padding: 16px 32px 32px;
}
.settings-page-intro {
  display: grid;
  gap: 8px;
}
.settings-page-intro h3 {
  margin: 0;
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -.025em;
  line-height: 1.3;
}
.settings-page-intro p {
  max-width: 70ch;
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}
.settings-results {
  display: grid;
  gap: 2px;
}
.settings-results span, .settings-results small {
  display: block;
  text-align: start;
}
.settings-results small {
  margin-top: 5px;
  color: var(--ink-mid);
  font-size: 11px;
  line-height: 1.5;
}
.settings-search-empty {
  display: grid;
  justify-items: start;
  gap: 12px;
  padding: 18px 8px;
}
.settings-search-empty svg {
  color: var(--ink-low);
}
.settings-search-empty p {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}
.settings-page-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--ink-mid);
}
.settings-sections {
  display: none;
  flex-shrink: 0;
}
@media (max-width: 900px) {
  .settings-workspace {
    grid-template-columns: 204px minmax(0, 1fr);
  }
  .settings-page-inner {
    padding: 16px 24px 28px;
  }
  .settings-page-heading {
    padding-inline: 24px;
  }
}
@media (max-width: 600px) {
  .settings-workspace {
    grid-template-columns: minmax(0, 1fr);
  }
  .settings-sidebar {
    display: none;
    border-right: 0;
    padding: 16px 12px;
  }
  .settings-workspace[data-navigation='true'] .settings-sidebar {
    display: flex;
  }
  .settings-workspace[data-navigation='true'] .settings-page-area {
    display: none;
  }
  .settings-page-inner {
    padding: 20px;
    gap: 22px;
  }
  .settings-page-heading {
    padding: 8px 10px;
    border-bottom: 1px solid var(--line);
  }
  .settings-page-heading p {
    gap: 4px 7px;
  }
  .settings-sections {
    display: inline-flex;
  }
}
/* Плагины используют всю область; геометрия остальных страниц сохраняется. */
.settings-workspace[data-page='plugins.installed'] .settings-page-inner {
  max-width: none;
  margin: 0;
  padding: 12px 16px 20px;
  gap: 16px;
}
.settings-workspace[data-page='plugins.installed'] .settings-page-heading {
  padding-inline: 16px;
}
.settings-workspace[data-page='plugins.installed'] .settings-page-intro {
  gap: 4px;
}
.settings-workspace[data-page='plugins.installed'] .settings-page-intro h3 {
  font-size: 15px;
  letter-spacing: normal;
}
</style>
