<template>
  <div class="plugins" data-testid="plugins-catalog">
    <div v-if="!pluginsStore.loaded" class="plugin-loading">
      <UiSpinner decorative /> Загружаю плагины…
    </div>

    <template v-else>
      <div class="plugin-toolbar">
        <UiSearchInput
          v-model="query"
          class="plugin-search"
          aria-label="Поиск плагинов"
          placeholder="Найти плагин"
        />
        <div class="plugin-filter-group">
          <UiSegmentedControl
            v-model="stateFilter"
            class="plugin-filter"
            :options="filterOptions"
            label="Состояние плагинов"
          />
          <UiToggleButton v-model="configurableOnly">
            С параметрами {{ stats.configurable }}
          </UiToggleButton>
          <UiToggleButton
            v-if="stats.custom"
            v-model="customOnly"
            aria-label="Только пользовательские плагины"
            title="Пользовательские плагины"
          >
            Свои {{ stats.custom }}
          </UiToggleButton>
        </div>
      </div>

      <section
        v-for="group in groups"
        :key="group.id"
        class="plugin-group"
        :data-category="group.id"
      >
        <div class="plugin-group-head">
          <div>
            <h3>{{ group.label }}</h3>
            <p>{{ group.hint }}</p>
          </div>
          <small>{{ pluginCountLabel(group.plugins.length) }}</small>
        </div>

        <div class="plugin-grid">
          <!-- Плитка не является кнопкой целиком: в углу лежит своя кнопка питания, а
               интерактив внутри интерактива недоступен с клавиатуры и ломает разметку.
               Поэтому площадь плитки открывает модалку растянутой кнопкой, а включение
               живёт поверх неё отдельным элементом. -->
          <div
            v-for="plugin in group.plugins"
            :key="plugin.id"
            class="plugin-tile"
            :class="{ off: !plugin.enabled }"
            :data-plugin-id="plugin.id"
          >
            <UiPressable
              class="plugin-tile-open"
              :aria-label="`Настройки плагина ${plugin.name}`"
              @click="openPlugin(plugin.id)"
            >
              <span class="plugin-tile-body">
                <span class="plugin-tile-icon" aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.7"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path :d="pluginIconPath(plugin)" />
                  </svg>
                </span>
                <span class="plugin-tile-name">{{ plugin.name }}</span>
                <span class="plugin-tile-meta">
                  {{ settingCount(plugin)
                    ? settingCountLabel(settingCount(plugin))
                    : 'без параметров' }}
                </span>
              </span>
            </UiPressable>

            <span class="plugin-tile-power">
              <UiIconButton
                role="rail"
                :variant="plugin.enabled ? 'solid' : 'ghost'"
                :tone="plugin.enabled ? 'accent' : 'neutral'"
                :disabled="togglingId === plugin.id"
                :label="`${plugin.enabled ? 'Выключить' : 'Включить'} ${plugin.name}`"
                :title="plugin.enabled ? 'Плагин включён' : 'Плагин выключен'"
                @click="toggle(plugin, !plugin.enabled)"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M12 3.5v7.7 M17.7 6.6a8 8 0 1 1-11.4 0" />
                </svg>
              </UiIconButton>
            </span>
          </div>
        </div>
      </section>

      <div v-if="!visiblePlugins.length" class="plugin-empty">
        <span class="plugin-empty-icon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-4-4 M8.5 11h5" />
          </svg>
        </span>
        <div>
          <b>Плагины не найдены</b>
          <p>Измените запрос или сбросьте выбранный фильтр.</p>
        </div>
        <UiButton variant="ghost" data-role="settings-action" @click="clearFilters">
          Сбросить фильтры
        </UiButton>
      </div>

      <div class="plugin-guide">
        <UiDisclosureButton
          v-model:open="guideOpen"
          controls="plugin-user-guide"
          density="compact"
        >
          Как добавить пользовательский плагин
        </UiDisclosureButton>
        <p v-if="guideOpen" id="plugin-user-guide" class="plugin-guide-note">
          Пользовательский модуль — папка <code>plugins/&lt;id&gt;/</code> с
          <code>plugin.json</code>. Серверная часть подключается после рестарта Cockpit.
        </p>
      </div>

      <PluginSettingsDialog
        v-model:open="dialogOpen"
        :plugin="openedPlugin"
        :toggling="togglingId === openedPluginId"
        @toggle="(value) => openedPlugin && toggle(openedPlugin, value)"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  UiButton,
  UiDisclosureButton,
  UiIconButton,
  UiPressable,
  UiSearchInput,
  UiSegmentedControl,
  UiSpinner,
  UiToggleButton,
} from '../../ui';
import { pluginCategoryOf, usePluginsStore } from '../../stores/plugins.js';
import { pluginIconPath } from '../../shared/navIcons.ts';
import { PLUGIN_CATEGORIES } from '../../../../shared/pluginsContracts.ts';
import type { PluginListItem } from '../../../../shared/pluginsContracts.ts';
import PluginSettingsDialog from './PluginSettingsDialog.vue';

// Каталог плагинов: плитки по роду работы. Список коротких имён со своими иконками
// человек читает целиком за один взгляд, а описание и параметры нужны только тому
// модулю, который он открыл, — их забирает модалка.
const pluginsStore = usePluginsStore();

const query = ref('');
const stateFilter = ref('all');
const configurableOnly = ref(false);
const customOnly = ref(false);
const guideOpen = ref(false);
const togglingId = ref('');
const openedPluginId = ref('');
const dialogOpen = ref(false);

// Список приходит из общего store, поэтому форма записи объявлена контрактом раздела.
const pluginList = computed<PluginListItem[]>(() => (Array.isArray(pluginsStore.list)
  ? pluginsStore.list as PluginListItem[]
  : []));

function settingCount(plugin: PluginListItem): number {
  return (plugin.settings?.length || 0) + (plugin.placements?.length || 0);
}

const stats = computed(() => {
  const list = pluginList.value;

  return {
    enabled: list.filter((plugin) => plugin.enabled).length,
    configurable: list.filter((plugin) => settingCount(plugin) > 0).length,
    custom: list.filter((plugin) => !plugin.system).length,
  };
});

const filterOptions = computed(() => {
  const total = pluginList.value.length;

  return [
    { value: 'all', label: `Все ${total}` },
    { value: 'enabled', label: `Включены ${stats.value.enabled}` },
    { value: 'disabled', label: `Выключены ${total - stats.value.enabled}` },
  ];
});

// Поиск охватывает то, по чему человек узнаёт модуль: имя, описание, место в
// навигации и id из манифеста — по нему модуль ищут, когда помнят папку, а не имя.
function matchesQuery(plugin: PluginListItem, text: string): boolean {
  if (!text) {
    return true;
  }

  const haystack = [
    plugin.id,
    plugin.name,
    plugin.description,
    plugin.nav?.label,
    plugin.system ? 'системный' : 'пользовательский',
  ].filter(Boolean).join(' ').toLocaleLowerCase('ru');

  return haystack.includes(text);
}

// Фильтр состояния и признаки модуля пересекаются, а не заменяют друг друга: иначе
// «выключенные с параметрами» пришлось бы искать глазами по всему каталогу.
function matchesFilter(plugin: PluginListItem): boolean {
  const stateMatches = stateFilter.value === 'enabled'
    ? plugin.enabled === true
    : stateFilter.value === 'disabled'
      ? plugin.enabled !== true
      : true;

  return stateMatches
    && (!configurableOnly.value || settingCount(plugin) > 0)
    && (!customOnly.value || !plugin.system);
}

const visiblePlugins = computed(() => {
  const text = query.value.trim().toLocaleLowerCase('ru');

  return pluginList.value
    .filter((plugin) => matchesFilter(plugin) && matchesQuery(plugin, text));
});

// Порядок групп задаёт общий контракт категорий, а пустая группа с экрана уходит:
// заголовок без плиток под фильтром читался бы как «здесь ничего нет вообще».
const groups = computed(() => PLUGIN_CATEGORIES
  .map((category) => ({
    ...category,
    plugins: visiblePlugins.value
      .filter((plugin) => pluginCategoryOf(plugin) === category.id),
  }))
  .filter((group) => group.plugins.length));

const openedPlugin = computed(() => pluginList.value
  .find((plugin) => plugin.id === openedPluginId.value) || null);

// Плагин может исчезнуть из списка (например, свой модуль удалили с диска) — тогда
// модалка обязана закрыться сама, а не остаться пустой рамкой поверх каталога.
watch(openedPlugin, (plugin) => {
  if (!plugin) {
    dialogOpen.value = false;
  }
});

// Русские формы счётчиков нужны и заголовку группы, и плитке: «1 плагин», «2 плагина»,
// «5 плагинов». Числительные второго десятка идут по общему правилу многих.
function countedLabel(value: number, one: string, few: string, many: string): string {
  const normalized = Math.abs(Number(value)) % 100;
  const digit = normalized % 10;
  let word = many;

  if (normalized < 11 || normalized > 19) {
    if (digit === 1) {
      word = one;
    } else if (digit >= 2 && digit <= 4) {
      word = few;
    }
  }

  return `${value} ${word}`;
}

function pluginCountLabel(value: number): string {
  return countedLabel(value, 'плагин', 'плагина', 'плагинов');
}

function settingCountLabel(value: number): string {
  return countedLabel(value, 'параметр', 'параметра', 'параметров');
}

function openPlugin(id: string): void {
  openedPluginId.value = id;
  dialogOpen.value = true;
}

// Сброс возвращает каталог целиком: пустая выдача — это чаще всего забытый фильтр,
// а не отсутствие модуля, поэтому выход из неё один и явный.
function clearFilters(): void {
  query.value = '';
  stateFilter.value = 'all';
  configurableOnly.value = false;
  customOnly.value = false;
}

/**
 * Включают плагин из двух мест — кнопкой питания на плитке и тумблером в модалке, —
 * но состояние занятости одно: пока сервер не ответил, второй щелчок ушёл бы вперёд
 * первого. Фильтр состояния при этом сбрасывается — иначе плитка исчезала бы
 * из-под пальца сразу после переключения.
 */
async function toggle(plugin: PluginListItem, enabled: boolean): Promise<void> {
  if (togglingId.value) {
    return;
  }

  if ((stateFilter.value === 'enabled' && !enabled)
      || (stateFilter.value === 'disabled' && enabled)) {
    stateFilter.value = 'all';
  }

  togglingId.value = plugin.id;

  try {
    await pluginsStore.toggle(plugin.id, enabled);
  } finally {
    togglingId.value = '';
  }
}
</script>

<style scoped>
/* Подраздел не наследует scoped-стили SettingsView, поэтому описан здесь целиком. */
.plugins { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.plugin-loading {
  display: flex; align-items: center; gap: 9px; min-height: 88px; padding: 18px;
  border: 1px solid var(--line); border-radius: 13px; background: var(--surface);
  color: var(--ink-mid);
}
.plugin-toolbar {
  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;
  gap: 10px 12px; min-width: 0;
}
.plugin-search { flex: 1 1 240px; max-width: 360px; }
.plugin-filter-group {
  display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 7px;
  min-width: 0;
}
.plugin-filter { flex: none; max-width: 100%; overflow-x: auto; }
.plugin-group { display: grid; gap: 11px; min-width: 0; }
.plugin-group-head {
  display: flex; align-items: flex-end; justify-content: space-between; gap: 10px;
  padding-bottom: 9px; border-bottom: 1px solid var(--line);
}
.plugin-group-head h3 { margin: 0 0 2px; font-size: 13px; font-weight: 650; }
.plugin-group-head p { margin: 0; color: var(--ink-mid); font-size: 11.5px; line-height: 1.45; }
.plugin-group-head small { flex: none; color: var(--ink-mid); font-size: 10.5px; }
.plugin-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.plugin-tile {
  position: relative; min-width: 0; border: 1px solid var(--line); border-radius: 12px;
  background: var(--surface);
}
.plugin-tile:hover { border-color: var(--line-2); background: var(--surface-2); }
.plugin-tile.off { background: var(--ground); }
.plugin-tile-open { width: 100%; min-width: 0; display: block; }
.plugin-tile-body {
  min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 16px 12px 13px; text-align: center;
}
.plugin-tile-icon {
  display: grid; place-items: center; width: 40px; height: 40px; border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line));
  background: color-mix(in srgb, var(--accent) 10%, var(--surface)); color: var(--accent);
}
.plugin-tile.off .plugin-tile-icon {
  border-color: var(--line); background: var(--surface-2); color: var(--ink-mid);
}
.plugin-tile-icon svg { width: 22px; height: 22px; }
.plugin-tile-name {
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12.5px; font-weight: 600;
}
.plugin-tile.off .plugin-tile-name { color: var(--ink-mid); }
.plugin-tile-meta { color: var(--ink-mid); font-size: 10.5px; }
.plugin-tile-power { position: absolute; top: 8px; right: 8px; display: inline-flex; }
.plugin-tile-power svg { width: 15px; height: 15px; }
.plugin-empty {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 13px;
  padding: 16px; border: 1px solid var(--line); border-radius: 13px; background: var(--surface);
}
.plugin-empty-icon {
  display: grid; place-items: center; width: 36px; height: 36px; border-radius: 11px;
  background: var(--surface-2); color: var(--ink-mid);
}
.plugin-empty-icon svg { width: 20px; height: 20px; }
.plugin-empty b { font-size: 13px; }
.plugin-empty p { margin: 2px 0 0; color: var(--ink-mid); font-size: 11.5px; }
.plugin-guide { display: grid; gap: 7px; }
.plugin-guide-note { margin: 0; color: var(--ink-mid); font-size: 11.5px; line-height: 1.55; }
.plugin-guide-note code {
  padding: 1px 5px; border-radius: 5px; background: var(--ground); font-family: var(--mono);
  font-size: 11px;
}

@media (max-width: 639px) {
  .plugin-toolbar { display: grid; }
  .plugin-search { max-width: none; }
  .plugin-filter-group {
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); overflow: visible;
  }
  .plugin-filter { grid-column: 1 / -1; overflow: visible; }
  .plugin-grid { grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); }
  .plugin-empty { grid-template-columns: auto minmax(0, 1fr); }
  .plugin-empty .ui-button { grid-column: 1 / -1; width: 100%; }
}
</style>
