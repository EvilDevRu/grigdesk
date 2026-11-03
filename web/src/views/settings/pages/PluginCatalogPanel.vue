<template>
  <div ref="panel" class="catalog-panel" :data-detail="state.showDetail">
    <div class="catalog-tools">
      <UiInput
        v-model="state.query"
        data-catalog-search
        type="search"
        :aria-label="t('settings.searchPlugins')"
        :placeholder="t('settings.findAPlugin')"
      />
      <UiSelect v-model="state.category" :aria-label="t('settings.marketplaceCategory')">
        <option value="all">{{ t('settings.marketplaceAllCategories') }}</option>
        <option v-for="category in categories" :key="category.id" :value="category.id">
          {{ category.label }}
        </option>
      </UiSelect>
      <UiSelect v-model="state.origin" :aria-label="t('settings.marketplaceOrigin')">
        <option value="all">{{ t('settings.marketplaceAllOrigins') }}</option>
        <option value="official">{{ t('settings.marketplaceOfficial') }}</option>
        <option value="community">{{ t('settings.marketplaceCommunity') }}</option>
      </UiSelect>
      <UiIconButton :label="t('settings.marketplaceRefresh')" v-tooltip="t('settings.marketplaceRefresh')"
                    data-context="workspace-form" :loading="catalog.loading" @click="refresh">
        <UiRefreshIcon />
      </UiIconButton>
    </div>
    <UiLoadingState v-if="catalog.loading" :label="t('settings.marketplaceLoading')"
      :variant="catalog.index ? 'inline' : 'cards'" :failed="Boolean(catalog.error)">
      <UiSkeletonLayout layout="list" />
    </UiLoadingState>
    <UiInlineMessage v-if="catalog.state !== 'fresh' && !catalog.loading" tone="warning" data-catalog-status>
      {{ t(statusKey) }}
    </UiInlineMessage>
    <div class="catalog-summary" v-if="catalog.index">
      <span>{{ t('settings.marketplaceResults', { count: visible.length }) }}</span>
      <span v-if="catalogStamp">{{ t('settings.marketplaceSnapshot', { date: catalogStamp }) }}</span>
    </div>
    <div class="catalog-layout">
      <aside class="catalog-list" :aria-label="t('settings.marketplaceCatalog')">
        <UiButton
          v-for="entry in visible"
          :key="entry.id"
          :data-catalog-id="entry.id"
          :pressed="state.detailId === entry.id"
          data-ui-settings-catalog data-context="plugin-entry"
          @click="choose(entry.id)"
        >
          <span class="ui-settings-catalog-copy">
            <strong class="ui-settings-catalog-title">{{ entry.name }}</strong>
            <span class="ui-settings-catalog-description">{{ uiLocale === 'en' ? entry.summary.en : entry.summary.ru }}</span>
            <small class="ui-settings-catalog-meta">
              {{ entry.origin === 'official' ? t('settings.marketplaceOfficial')
                : t('settings.marketplaceCommunity') }} · {{ entry.latest?.version ?? '—' }}
            </small>
            <small v-if="installedById(entry.id) && !rowConflict(entry.id)">
              {{ t('settings.marketplaceInstalled') }} · {{ installedById(entry.id)?.install?.version }}
            </small>
            <small v-else-if="rowConflict(entry.id)">{{ t('settings.marketplaceSourceConflict') }}</small>
          </span>
        </UiButton>
        <p v-if="!catalog.loading && !visible.length" class="catalog-note" data-catalog-empty>
          {{ catalog.index?.plugins.length ? t('settings.marketplaceNoMatches')
            : t('settings.marketplaceEmpty') }}
        </p>
      </aside>
      <article class="catalog-card">
        <UiButton class="catalog-back" data-context="workspace-form" variant="ghost" @click="back">{{ t('settings.marketplaceBack') }}</UiButton>
        <UiLoadingState v-if="catalog.detailLoading" :label="t('settings.marketplaceLoading')"
          variant="document"  :failed="Boolean(catalog.detailError)">
          <UiSkeletonLayout layout="form" :header="false" />
        </UiLoadingState>
        <UiInlineMessage v-else-if="catalog.detailError" tone="warning">
          {{ t('settings.marketplaceDetailError') }}
        </UiInlineMessage>
        <template v-else-if="detail">
          <header class="catalog-card-heading">
            <h4 data-catalog-title tabindex="-1">{{ detail.name }}</h4>
            <span class="catalog-origin">{{ detail.origin === 'official'
              ? t('settings.marketplaceOfficial') : t('settings.marketplaceCommunity') }}</span>
            <p>{{ uiLocale === 'en' ? detail.summary.en : detail.summary.ru }}</p>
          </header>
          <dl class="catalog-facts">
            <div>
              <dt>{{ t('settings.repository') }}</dt>
              <dd><UiActionLink :href="`https://github.com/${detail.repository}`" target="_blank"
                                variant="text" data-context="plugin-repository">
                {{ detail.repository }} <span aria-hidden="true">↗</span>
              </UiActionLink></dd>
            </div>
            <div>
              <dt>{{ t('settings.marketplaceLicense') }}</dt>
              <dd>{{ detail.license ?? t('settings.marketplaceLicenseUnknown') }}</dd>
            </div>
          </dl>
          <div class="catalog-release">
            <UiField :label="t('settings.version')">
              <UiSelect
                :model-value="action?.target?.version ?? ''"
                :aria-label="t('settings.version')"
                @update:model-value="selectVersion(String($event))"
              >
                <option v-if="!detail.versions.length" value="">—</option>
                <option v-for="version in detail.versions" :key="version.version" :value="version.version"
                        :disabled="!compatible.some((entry) => entry.version === version.version)">
                  {{ version.version }}
                </option>
              </UiSelect>
            </UiField>
            <UiButton data-catalog-action data-context="workspace-form" variant="solid" tone="accent"
                      :disabled="!canInstall" @click="install">
              {{ actionLabel }}
            </UiButton>
          </div>
          <p v-if="action?.target" class="catalog-note">
            {{ action.target.minGrigDeskVersion
              ? t('settings.marketplaceMinimum', { version: action.target.minGrigDeskVersion })
              : t('settings.marketplaceCompatibilityUnknown') }}
          </p>
          <UiInlineMessage v-if="action?.reason" tone="warning">
            {{ t(reasonKeys[action.reason] ?? 'settings.marketplaceDetailError') }}
          </UiInlineMessage>
          <p class="catalog-note">{{ t('settings.marketplaceTrustHint') }}</p>
          <UiInlineMessage v-if="versionChanged" tone="warning" data-catalog-version-changed>
            {{ t('settings.marketplaceVersionChanged') }}
          </UiInlineMessage>
          <UiButton v-if="installed" data-context="workspace-form-wrap"
                    @click="emit('configure', installed.id)">
            {{ t('settings.marketplaceOpenInstalled') }}
          </UiButton>
          <UiTabs
            v-model="state.detailTab"
            :label="t('settings.marketplaceDetails')"
            data-ui-settings-tabs
          >
            <UiTab id="plugin-catalog-description" value="description" controls="plugin-catalog-content">
              {{ t('settings.marketplaceDescription') }}
            </UiTab>
            <UiTab id="plugin-catalog-versions" value="versions" controls="plugin-catalog-content">
              {{ t('settings.marketplaceVersions') }}
            </UiTab>
            <UiTab id="plugin-catalog-changes" value="changes" controls="plugin-catalog-content">
              {{ t('settings.marketplaceChanges') }}
            </UiTab>
          </UiTabs>
          <section
            id="plugin-catalog-content" class="catalog-content"
            role="tabpanel"
            :aria-labelledby="`plugin-catalog-${state.detailTab}`"
          >
            <template v-if="state.detailTab === 'description'">
              <p>{{ detail.description }}</p>
              <pre data-catalog-readme>{{ detail.readme ?? t('settings.marketplaceNoReadme') }}</pre>
            </template>
            <ul v-else-if="state.detailTab === 'versions'">
              <li v-for="version in detail.versions" :key="version.version">
                {{ version.version }} · {{ version.minGrigDeskVersion
                  ? t('settings.marketplaceMinimum', { version: version.minGrigDeskVersion })
                  : t('settings.marketplaceCompatibilityUnknown') }}
              </li>
            </ul>
            <pre v-else>{{ detail.releaseNotes ?? t('settings.marketplaceNoChanges') }}</pre>
          </section>
        </template>
        <p v-else class="catalog-empty">{{ t('settings.marketplaceSelect') }}</p>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { UiSkeletonLayout } from '../../../ui';


import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

import {
  UiRefreshIcon,
  UiActionLink,
  UiButton,
  UiIconButton,
  UiField,
  UiInput,
  UiSelect,
  UiInlineMessage,
  UiTabs,
  UiTab,
  t,
  uiLocale,
  vTooltip,
  UiLoadingState,
} from '../../../ui.ts';
import { formatDate } from '../../../../../shared/i18n/formats.ts';
import { usePluginCatalogStore } from '../../../stores/pluginCatalog.ts';
import { usePluginsStore } from '../../../stores/plugins.ts';
import { usePluginInstallStore } from '../../../stores/pluginInstall.ts';
import { usePluginMarketplaceState } from '../../../features/settings/pluginMarketplace.ts';
import { localizePluginCategory } from '../../../features/settings/metadataLocale.ts';
import { PLUGIN_CATEGORIES, type PluginListItem } from '../../../../../shared/plugins/pluginsContracts.ts';
import type { MessageKey } from '../../../../../shared/i18n/catalogs.ts';
import { sameCatalogSource, catalogAction, compatibleVersions, detailMatchesIndex,
  type CatalogSelection } from '../../../../../shared/plugins/pluginCatalogPolicy.ts';

const emit = defineEmits<{
  install: [selection: CatalogSelection, installed: PluginListItem | null];
  configure: [id: string];
}>();
const catalog = usePluginCatalogStore();
const plugins = usePluginsStore();
const installer = usePluginInstallStore();
const state = usePluginMarketplaceState();
const panel = ref<HTMLElement | null>(null);
const selecting = ref(false);
const versionChanged = ref(false);
let disposed = false;
const catalogStamp = computed(() => catalog.index?.generatedAt
  ? formatDate(new Date(catalog.index.generatedAt), uiLocale, {
      dateStyle: 'short',
      timeStyle: 'short',
    }) : '');
const categories = computed(() => PLUGIN_CATEGORIES
  .map((item) => localizePluginCategory(item, uiLocale.value)));
const visible = computed(() => {
  const needle = state.query.trim().toLocaleLowerCase(uiLocale.value);

  return (catalog.index?.plugins ?? []).filter((entry) => {
    const text = [entry.id, entry.name, entry.repository, entry.summary.ru, entry.summary.en]
      .join(' ').toLocaleLowerCase(uiLocale.value);

    return (!needle || text.includes(needle))
      && (state.category === 'all' || state.category === entry.category)
      && (state.origin === 'all' || state.origin === entry.origin);
  });
});
const detail = computed(() => catalog.detail?.plugin.id === state.detailId ? catalog.detail.plugin : null);
const installed = computed(() => installedById(state.detailId));
const compatible = computed(() => detail.value
  ? compatibleVersions(detail.value, catalog.applicationVersion) : []);
// Версия из сессии, которой нет среди совместимых в текущем снимке, не превращает карточку
// в «нет подходящих версий»: действие возвращается к старшей совместимой.
const chosenVersion = computed(() => compatible.value
  .some((entry) => entry.version === state.version) ? state.version : undefined);
const action = computed(() => detail.value
  ? catalogAction(detail.value, catalog.applicationVersion, installed.value, chosenVersion.value)
  : null);

// Выбрана версия ниже установленной: кнопка называет фактически установленную версию,
// а не утверждает, что установлена выбранная. Понижение версии из каталога не выполняется.
const actionLabel = computed(() => {
  if (action.value?.action === 'update') {
    return t('settings.update');
  }

  if (action.value?.action !== 'installed') {
    return t('settings.install');
  }

  const current = installed.value?.install?.version;

  return current && current !== action.value.target?.version
    ? t('settings.marketplaceInstalledVersion', { version: current })
    : t('settings.marketplaceInstalled');
});
const canInstall = computed(() => !selecting.value && catalog.state === 'fresh'
  && !catalog.loading && !catalog.detailLoading
  && Boolean(catalog.index && catalog.detail
    && detailMatchesIndex(catalog.index, catalog.detail, state.detailId))
  && plugins.loaded && !plugins.loadError
  && ['install', 'update'].includes(action.value?.action ?? '')
  && !installer.recoveryError && installer.job?.status !== 'recovery_required');
const statusKey = computed(() => ({
  fresh: 'settings.marketplaceCatalog',
  stale: 'settings.marketplaceStale',
  unavailable: 'settings.marketplaceUnavailable',
  unconfigured: 'settings.marketplaceUnconfigured',
} as const)[catalog.state]);
const reasonKeys: Record<string, MessageKey> = {
  archived: 'settings.marketplaceArchived',
  incompatible: 'settings.marketplaceIncompatible',
  sourceConflict: 'settings.marketplaceSourceConflict',
  commitConflict: 'settings.marketplaceCommitConflict',
};

function installedById(id: string): PluginListItem | null {
  return (plugins.list as PluginListItem[]).find((entry) => entry.id === id) ?? null;
}

/**
 * Строка индекса не объявляет installed по одному совпавшему ID другого источника.
 * Системный и ручной ID остаются конфликтом даже до чтения полного detail.
 */
function rowConflict(id: string): boolean {
  const installed = installedById(id);
  const entry = catalog.index?.plugins.find((item) => item.id === id);

  return Boolean(installed && (installed.system || !installed.install
    || !entry || !sameCatalogSource(installed.install.source, entry.source)));
}

/**
 * Выбор не отправляет мутации и не трогает entityId редактора установленных плагинов.
 * Фокус переносится только для ещё выбранной карточки после асинхронного ответа.
 */
async function choose(id: string): Promise<void> {
  state.detailId = id;
  state.version = '';
  state.showDetail = true;
  state.detailTab = 'description';
  versionChanged.value = false;
  await catalog.loadDetail(id);
  await nextTick();

  if (state.detailId !== id) {
    return;
  }

  // Без карточки заголовка нет; в узкой раскладке список скрыт, и фокус уходит на «Назад».
  const title = panel.value?.querySelector<HTMLElement>('[data-catalog-title]');

  (title ?? panel.value?.querySelector<HTMLElement>('.catalog-back'))?.focus();
}

function selectVersion(version: string): void {
  state.version = version;
  versionChanged.value = false;
}

/**
 * Назад возвращает список и его выбранную строку без повторного запроса каталога.
 * Параметры поиска и загруженная карточка остаются в сессии настроек.
 */
async function back(): Promise<void> {
  state.showDetail = false;
  await nextTick();
  panel.value?.querySelector<HTMLElement>(`[data-catalog-id="${state.detailId}"]`)?.focus();
}

/**
 * Явный refresh повторно получает индекс и только потом карточку текущего выбора.
 * Старый snapshot не остаётся основанием для доступной кнопки установки.
 */
async function refresh(): Promise<void> {
  versionChanged.value = false;
  await catalog.loadIndex(true);

  if (state.detailId) {
    await catalog.loadDetail(state.detailId);
  }
}

/**
 * Перед действием повторно проверяются свежий index и соответствующий detail.
 * Давно открытая карточка также проходит актуальную проверку источника и снимка.
 * Только неизменившийся version/SHA передаётся host; новый выбор требует отдельного клика человека.
 */
async function install(): Promise<void> {
  if (!canInstall.value || !detail.value || !action.value?.target) {
    return;
  }

  const chosen = {
    id: detail.value.id,
    version: action.value.target.version,
    sha: action.value.target.sha
  };

  selecting.value = true;
  versionChanged.value = false;

  try {
    await catalog.loadIndex(true);

    if (disposed || catalog.state !== 'fresh' || state.detailId !== chosen.id) {
      return;
    }

    await catalog.loadDetail(chosen.id);

    if (disposed || catalog.state !== 'fresh' || state.detailId !== chosen.id || !detail.value) {
      return;
    }

    // Перепроверка показала другую версию или SHA: клик не пропадает молча,
    // человек видит причину и выбирает версию заново.
    if (action.value?.target?.version !== chosen.version || action.value.target.sha !== chosen.sha) {
      versionChanged.value = true;

      return;
    }

    if (!['install', 'update'].includes(action.value.action)
      || installer.recoveryError || installer.job?.status === 'recovery_required') {
      return;
    }

    emit('install', {
      id: detail.value.id,
      source: detail.value.source,
      target: action.value.target,
    }, installed.value);
  } finally {
    selecting.value = false;
  }
}

onBeforeUnmount(() => {
  disposed = true;
});

onMounted(async () => {
  await catalog.loadIndex();

  if (state.detailId) {
    await catalog.loadDetail(state.detailId);
  }
});
</script>

<style scoped>
.catalog-panel {
  container: plugin-catalog / inline-size;
  display: grid;
  gap: 12px;
  min-width: 0;
  font-size: 13px;
}
.catalog-tools {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 160px 160px auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.catalog-summary {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px 12px;
  color: var(--ink-mid);
  font-size: 12px;
}
.catalog-layout {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 16px;
}
.catalog-list {
  display: grid;
  align-content: start;
  gap: 8px;
  min-width: 0;
}
.catalog-card {
  display: grid;
  align-content: start;
  gap: 12px;
  min-width: 0;
  padding-left: 16px;
  border-left: 1px solid var(--line);
  overflow-wrap: anywhere;
}
.catalog-card p, .catalog-card h4, .catalog-facts {
  margin: 0;
}
.catalog-card-heading {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px 12px;
}
.catalog-card-heading h4 {
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
}
.catalog-card-heading p {
  flex-basis: 100%;
  color: var(--ink-mid);
  line-height: 1.5;
}
.catalog-origin {
  color: var(--ink-mid);
  font-size: 12px;
}
.catalog-facts {
  display: grid;
  gap: 6px;
  font-size: 12px;
}
.catalog-facts > div {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 8px;
  align-items: baseline;
}
.catalog-facts dt {
  color: var(--ink-mid);
}
.catalog-facts dd {
  min-width: 0;
  margin: 0;
}
.catalog-release {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 8px;
}
.catalog-note, .catalog-empty {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 18px;
}
.catalog-empty {
  padding: 12px 0;
}
.catalog-back {
  display: none;
  justify-self: start;
}
.catalog-content {
  display: grid;
  align-content: start;
  gap: 12px;
  line-height: 1.6;
}
.catalog-content pre {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
}
.catalog-content ul {
  margin: 0;
  padding-left: 20px;
}
@container plugin-catalog (max-width: 700px) {
  .catalog-tools {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  }
  .catalog-tools > :first-child {
    grid-column: 1 / -1;
  }
}
@container plugin-catalog (max-width: 600px) {
  .catalog-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .catalog-panel[data-detail='false'] .catalog-card,
  .catalog-panel[data-detail='true'] .catalog-list,
  .catalog-panel[data-detail='true'] .catalog-tools,
  .catalog-panel[data-detail='true'] .catalog-summary {
    display: none;
  }
  .catalog-card {
    padding: 0;
    border: 0;
  }
  .catalog-back {
    display: inline-flex;
  }
}
@container plugin-catalog (max-width: 340px) {
  .catalog-tools {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .catalog-tools > :nth-child(2) {
    grid-column: 1 / -1;
  }
  .catalog-facts > div {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
}
</style>
