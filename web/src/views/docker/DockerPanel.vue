<template>
  <section
    class="docker-panel"
    :class="{ 'is-compact': props.compact, 'is-dock': props.presentation === 'dock' }"
    aria-labelledby="docker-panel-title"
    :aria-busy="store.loading || undefined"
  >
    <div class="docker-panel__surface">
      <header class="docker-panel__header">
        <div class="docker-panel__brand">
          <span class="docker-panel__mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
              <path :d="NAV_ICONS.docker" />
            </svg>
          </span>
          <div class="docker-panel__heading">
            <div class="docker-panel__title">
              <h2 id="docker-panel-title">Докер</h2>
              <span class="ui-maturity-chip" data-product-maturity="beta" aria-label="Бета-версия">
                бета
              </span>
            </div>
            <p>Контейнеры и ресурсы локального хоста</p>
          </div>
        </div>
        <div class="docker-panel__connection" :class="{ 'is-online': available }">
          <span aria-hidden="true"></span>
          {{ connectionLabel }}
        </div>
        <UiIconButton
          role="embedded"
          label="Обновить состояние Docker"
          v-tooltip="'Обновить состояние Docker'"
          :loading="store.loading"
          @click="refresh"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.6-6.4 M21 4v5h-5" />
          </svg>
        </UiIconButton>
      </header>

      <UiInlineMessage v-if="store.error" tone="danger" class="docker-panel__message">
        {{ store.error }}
      </UiInlineMessage>
      <UiInlineMessage
        v-else-if="store.health && !store.health.available"
        tone="warning"
        class="docker-panel__message"
      >
        {{ store.health.message || 'Демон Docker недоступен' }} ({{ store.health.socketPath }})
      </UiInlineMessage>

      <dl class="docker-panel__summary" aria-label="Сводка Docker">
        <div class="docker-summary-item is-running">
          <dt><i aria-hidden="true"></i>Работают</dt>
          <dd>{{ available ? store.counts.running : '—' }}</dd>
        </div>
        <div class="docker-summary-item">
          <dt>Не запущены</dt>
          <dd>{{ available ? store.counts.containers - store.counts.running : '—' }}</dd>
        </div>
        <div class="docker-summary-item">
          <dt>Проекты</dt>
          <dd>{{ available ? store.projects.length : '—' }}</dd>
        </div>
        <div class="docker-summary-item">
          <dt>Образы</dt>
          <dd>{{ available ? store.counts.images : '—' }}</dd>
        </div>
      </dl>

      <UiTabs
        :model-value="tab"
        label="Разделы Docker"
        data-ui-docker-tabs
        @update:model-value="selectTab"
      >
        <UiTab id="docker-tab-containers" value="containers" controls="docker-content">
          Контейнеры <span class="docker-tab__count">{{ store.containers.length }}</span>
        </UiTab>
        <UiTab id="docker-tab-images" value="images" controls="docker-content">
          Образы <span class="docker-tab__count">{{ store.images.length }}</span>
        </UiTab>
        <UiTab id="docker-tab-storage" value="storage" controls="docker-content">Тома и сети</UiTab>
        <UiTab id="docker-tab-cleanup" value="cleanup" controls="docker-content">Уборка</UiTab>
      </UiTabs>

      <div
        id="docker-content"
        class="docker-panel__content"
        role="tabpanel"
        :aria-labelledby="`docker-tab-${tab}`"
        tabindex="0"
      >
        <DockerContainers
          v-if="tab === 'containers'"
          :stats="store.stats"
          @logs="openViewer('logs', $event)"
          @exec="openViewer('exec', $event)"
        />
        <DockerImages v-else-if="tab === 'images'" />
        <DockerStorage v-else-if="tab === 'storage'" />
        <DockerCleanup v-else />
      </div>

      <section v-if="viewer.container" class="docker-viewer" :class="`is-${viewer.kind}`">
        <header class="docker-viewer__bar">
          <strong>{{ viewer.kind === 'logs' ? 'Логи' : 'Терминал' }}</strong>
          <span class="docker-viewer__name">{{ viewer.container.name }}</span>
          <UiIconButton
            role="embedded"
            label="Закрыть просмотр контейнера"
            v-tooltip="'Закрыть просмотр контейнера'"
            @click="closeViewer"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </UiIconButton>
        </header>
        <DockerLogs v-if="viewer.kind === 'logs'" :container="viewer.container" />
        <DockerExec v-else :container="viewer.container" :active="props.active" />
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';

import type { DockerContainer } from '../../../../shared/plugins/docker/dockerContracts';

import { useDockerStore } from '../../stores/docker';
import { NAV_ICONS } from '../../shared/navIcons.ts';
import { UiIconButton, UiInlineMessage, UiTab, UiTabs, vTooltip } from '../../ui';
import DockerCleanup from './DockerCleanup.vue';
import DockerContainers from './DockerContainers.vue';
import DockerExec from './DockerExec.vue';
import DockerImages from './DockerImages.vue';
import DockerLogs from './DockerLogs.vue';
import DockerStorage from './DockerStorage.vue';

type DockerTab = 'containers' | 'images' | 'storage' | 'cleanup';
type ViewerKind = 'logs' | 'exec';

interface DockerViewer {
  kind: ViewerKind | '';
  container: DockerContainer | null;
}

const props = withDefaults(defineProps<{
  active?: boolean;
  compact?: boolean;
  presentation?: 'page' | 'dock' | 'hidden' | 'placeholder';
  intents?: readonly unknown[];
}>(), {
  active: true,
  compact: false,
  presentation: 'page',
  intents: () => [],
});
const emit = defineEmits<{
  'consume-intent': [intent: unknown];
  status: [status: 'open' | 'closed'];
  context: [context: unknown];
}>();

const store = useDockerStore();
const tab = ref<DockerTab>('containers');
const viewer = reactive<DockerViewer>({ kind: '', container: null });

const available = computed(() => Boolean(store.health?.available && !store.error));
const connectionLabel = computed(() => {
  if (store.error) {
    return 'Ошибка подключения';
  }

  if (available.value && store.health?.available) {
    return `Docker ${store.health.version}`;
  }

  return store.loading ? 'Подключение…' : 'Нет подключения';
});

function selectTab(value: string | number): void {
  if (value === 'containers' || value === 'images' || value === 'storage' || value === 'cleanup') {
    tab.value = value;
  }
}

/**
 * Обзор обновляется быстро; дорогой расчёт диска нужен только открытой уборке.
 */
function refresh(): void {
  store.load();

  if (tab.value === 'cleanup') {
    store.loadUsage({ force: true });
  }
}

function openViewer(kind: ViewerKind, container: DockerContainer): void {
  viewer.kind = kind;
  viewer.container = container;
}

function closeViewer(): void {
  viewer.kind = '';
  viewer.container = null;
}

// Статистику наблюдаем только пока контейнеры видны: скрытая панель не нагружает демон.
const watchedIds = computed(() => (props.active && tab.value === 'containers'
  ? store.containers.filter((container) => container.state === 'running').map((item) => item.id)
  : []));

watch(watchedIds, (ids) => {
  if (ids.length) {
    store.watchStats(ids);
  } else {
    store.stopStats();
  }
}, { immediate: true });

watch(() => props.active, async (active) => {
  if (!active) {
    store.stopStats();

    return;
  }

  // Рейка получает статус после ответа, когда уже известно состояние демона.
  await store.load();
  emit('status', store.health?.available ? 'open' : 'closed');
}, { immediate: true });

watch(tab, (value) => {
  if (value === 'cleanup' && !store.usage) {
    store.loadUsage();
  }
});

// Исчезнувший контейнер закрывает и просмотрщик, и связанный с ним поток.
watch(() => store.containers, (containers) => {
  const viewedId = viewer.container?.id;

  if (viewedId && !containers.some((container) => container.id === viewedId)) {
    closeViewer();
  }
});

onBeforeUnmount(() => {
  store.stopStats();
});
</script>

<style scoped>
.docker-panel {
  container: docker-panel / inline-size;
  display: flex;
  min-width: 0;
  min-height: 0;
  height: 100%;
  flex-direction: column;
}

.docker-panel__surface {
  display: flex;
  min-width: 0;
  min-height: 0;
  height: 100%;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}

.docker-panel__header,
.docker-panel__brand,
.docker-panel__title {
  display: flex;
  align-items: center;
  gap: 12px;
}

.docker-panel__brand {
  min-width: 0;
  flex: 1;
}

.is-dock .docker-panel__header {
  padding-right: var(--tool-dock-actions-space, 82px);
}

.docker-panel__mark {
  display: grid;
  width: 44px;
  height: 44px;
  flex: none;
  border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--line));
  border-radius: 12px;
  background: color-mix(in srgb, var(--accent) 10%, var(--ground));
  color: var(--accent);
  place-items: center;
}

.docker-panel__mark svg {
  width: 28px;
  height: 28px;
}

.docker-panel__heading {
  min-width: 0;
}

.docker-panel__title h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.4px;
}

.docker-panel__heading p {
  margin: 3px 0 0;
  color: var(--ink-mid);
  font-size: 12px;
}

.docker-panel__connection {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--ink-mid);
  font-size: 12px;
  white-space: nowrap;
}

.docker-panel__connection span,
.docker-summary-item i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--idle);
}

.docker-panel__connection.is-online span,
.docker-summary-item i {
  background: var(--good);
}

.docker-panel__summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin: 0;
}

.docker-summary-item {
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
}

.docker-summary-item dt {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--ink-mid);
  font-size: 12px;
}

.docker-summary-item dd {
  margin: 5px 0 0;
  font-size: 22px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.docker-summary-item.is-running dd {
  color: var(--good);
}

.docker-panel__message {
  margin: 0;
}

.docker-tab__count {
  color: var(--ink-mid);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.docker-panel__content {
  min-width: 0;
  min-height: 0;
  flex: 1;
  overflow: auto;
  scrollbar-gutter: stable;
}

.docker-viewer {
  display: flex;
  height: 40%;
  min-height: 180px;
  flex: none;
  flex-direction: column;
  border: 1px solid var(--line-2);
  border-radius: var(--radius);
  background: var(--surface);
  overflow: hidden;
}

.docker-viewer__bar {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  gap: 12px;
  font-size: 13px;
}

.docker-viewer__name {
  overflow: hidden;
  flex: 1;
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@container docker-panel (max-width: 680px) {
  .docker-panel__surface {
    gap: 14px;
    padding: 16px;
  }

  .docker-panel__header {
    flex-wrap: wrap;
    gap: 10px;
  }

  .docker-panel__connection {
    order: 3;
    width: 100%;
  }

  .docker-summary-item {
    padding: 10px;
  }
}

@container docker-panel (max-width: 440px) {
  .docker-tab__count {
    display: none;
  }

  .docker-panel__surface {
    gap: 12px;
    padding: 12px;
  }

  .docker-panel__summary {
    gap: 6px;
  }

  .docker-summary-item {
    padding: 8px 6px;
  }

  .docker-summary-item dt {
    font-size: 10px;
    gap: 4px;
  }

  .docker-summary-item dd {
    font-size: 22px;
  }
}
@media (max-height: 500px) {
  .docker-panel__surface { gap: 8px; padding: 8px 16px; }
  .docker-panel__mark, .docker-panel__heading p { display: none; }
  .docker-summary-item { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 4px 8px; }
  .docker-summary-item dd { margin: 0; font-size: 16px; }
}
@container docker-panel (max-width: 440px) {
  .docker-panel__mark { display: none; }
  .docker-panel__connection { order: 0; width: auto; }
  .docker-panel__heading p { display: none; }
  .docker-panel__summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .docker-summary-item { display: flex; align-items: baseline; justify-content: space-between; gap: 4px; padding: 4px 8px; }
  .docker-summary-item dd { margin: 0; font-size: 16px; }
}
</style>
