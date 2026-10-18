<template>
  <div class="settings-workspace" :data-navigation="navigationVisible">
    <aside class="settings-sidebar">
      <UiInput
        v-model="settings.query"
        type="search"
        aria-label="Поиск настроек"
        placeholder="Найти настройку"
      />
      <UiButton v-if="settings.query" @click="settings.query = ''">Очистить поиск</UiButton>
      <div class="settings-navigation-scroll">
        <SettingsNavigation v-if="!settings.query.trim()" @select="navigationVisible = false" />
        <div
          v-else
          class="settings-results"
          aria-label="Результаты поиска"
        >
          <UiPressable
            v-for="(result, index) in results"
            :key="index"
            data-settings-result
            @click="openResult(result)"
          >
            <span>{{ result.label }}</span>
            <small>{{ result.description }}</small>
          </UiPressable>
          <p v-if="!results.length">Ничего не найдено. Попробуйте другое слово.</p>
        </div>
      </div>
    </aside>
    <section class="settings-page-area">
      <div class="settings-page-heading">
        <UiButton class="settings-sections" @click="navigationVisible = true">Разделы</UiButton>
        <p aria-label="Путь раздела">{{ group?.label }} / {{ page?.label }}</p>
      </div>
      <p v-if="settings.navigationError" role="alert">{{ settings.navigationError }}</p>
      <div class="settings-page-scroll">
        <h3>{{ page?.label }}</h3>
        <component
          :is="component"
          v-if="component"
          :key="settings.pageId"
          :active="true"
        />
        <p v-else>Раздел загружается…</p>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { UiButton, UiInput, UiPressable } from '../../ui.ts';
import { useSettingsStore } from '../../stores/settings.ts';
import { SETTINGS_GROUPS, SETTINGS_PAGES } from '../../features/settings/catalog.ts';
import { searchSettings, type SettingsSearchResult } from '../../features/settings/search.ts';
import { SETTINGS_PAGE_COMPONENTS } from './pageComponents.ts';
import SettingsNavigation from './SettingsNavigation.vue';

const settings = useSettingsStore();
const navigationVisible = ref(false);
const component = computed(() => SETTINGS_PAGE_COMPONENTS[settings.pageId]);
const page = computed(() => SETTINGS_PAGES.find((item) => item.id === settings.pageId));
const group = computed(() => SETTINGS_GROUPS.find((item) => item.id === page.value?.groupId));
const results = computed(() => searchSettings(settings.query, settings.dynamicFields));

function openResult(result: SettingsSearchResult): void {
  settings.openSearchResult(result);
  navigationVisible.value = false;
}
</script>

<style scoped>
.settings-workspace { display: grid; grid-template-columns: 240px minmax(0, 1fr); flex: 1; min-height: 0; }
.settings-sidebar { display: flex; flex-direction: column; gap: 12px; min-height: 0; padding: 16px; }
.settings-navigation-scroll { overflow: auto; min-height: 0; }
.settings-page-area { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.settings-page-heading { display: flex; align-items: center; gap: 12px; padding: 0 20px; }
.settings-page-scroll { flex: 1; min-height: 0; min-width: 0; overflow: auto; padding: 0 20px 20px; }
.settings-results { display: grid; gap: 12px; }
.settings-results span, .settings-results small { display: block; text-align: start; }
.settings-sections { display: none; flex-shrink: 0; }
@media (max-width: 900px) {
  .settings-workspace { grid-template-columns: 210px minmax(0, 1fr); }
}
@media (max-width: 600px) {
  .settings-workspace { grid-template-columns: minmax(0, 1fr); }
  .settings-sidebar { display: none; }
  .settings-workspace[data-navigation='true'] .settings-sidebar { display: flex; }
  .settings-workspace[data-navigation='true'] .settings-page-area { display: none; }
  .settings-sections { display: inline-flex; }
}
</style>
