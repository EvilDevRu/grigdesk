<template>
  <section
    class="docker-panel ui-workspace"
    data-ui-workspace
    :class="{
      'is-compact': props.compact,
      'is-dock': props.presentation === 'dock',
      'has-viewer': Boolean(viewer.container),
    }"
    aria-labelledby="docker-panel-title"
    :aria-busy="store.loading || undefined"
  >
    <div class="docker-panel__surface">
      <div class="docker-panel__heading">
        <UiPaneHeader>
          <template #title>
            <div class="docker-panel__title">
              <h2 id="docker-panel-title">Докер</h2>
              <span class="ui-maturity-chip" data-product-maturity="beta" aria-label="Бета-версия">
                бета
              </span>
            </div>
          </template>
          <template #meta>
            <span class="docker-panel__connection" :class="{ 'is-online': available }">
              <i aria-hidden="true"></i>{{ connectionLabel }}
            </span>
          </template>
          <template #actions>
            <UiIconButton
              role="embedded"
              data-context="workspace-toolbar"
              label="Обновить состояние Docker"
              v-tooltip="'Обновить состояние Docker'"
              :loading="store.loading"
              @click="refresh"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.6-6.4 M21 4v5h-5" />
              </svg>
            </UiIconButton>
          </template>
        </UiPaneHeader>
      </div>

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

      <div class="docker-panel__navigation">
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

        <dl class="docker-panel__summary" aria-label="Сводка Docker">
          <div class="docker-summary-item is-running">
            <dt>Работают</dt>
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
      </div>

      <div class="docker-panel__workspace">
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
          <UiPaneHeader>
            <template #title><h3>{{ viewer.kind === 'logs' ? 'Логи' : 'Терминал' }}</h3></template>
            <template #meta>
              <span class="docker-viewer__name" v-tooltip="viewer.container.name">
                {{ viewer.container.name }}
              </span>
            </template>
            <template #actions>
              <UiIconButton
                ref="viewerClose"
                role="embedded"
                data-context="workspace-toolbar"
                label="Закрыть просмотр контейнера"
                v-tooltip="'Закрыть просмотр контейнера'"
                @click="closeViewer"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </UiIconButton>
            </template>
          </UiPaneHeader>
          <DockerLogs v-if="viewer.kind === 'logs'" :container="viewer.container" />
          <DockerExec v-else :container="viewer.container" :active="props.active" />
        </section>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';

import type { DockerContainer } from '../../../../shared/plugins/docker/dockerContracts';

import { useDockerStore } from '../../stores/docker';
import { UiIconButton, UiInlineMessage, UiPaneHeader, UiTab, UiTabs, vTooltip } from '../../ui';
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
const viewerClose = ref<{ $el?: HTMLElement } | null>(null);
let viewerTrigger: HTMLElement | null = null;
let pendingViewer: { kind: ViewerKind; container: DockerContainer } | null = null;

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
    closeViewer();
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

/**
 * Узкая панель заменяет каталог просмотрщиком, сохраняя сам список и его фильтры.
 * Фокус переходит на закрытие, чтобы клавиатурой можно было сразу вернуться к списку.
 */
function openViewer(kind: ViewerKind, container: DockerContainer): void {
  if (!viewer.container) {
    viewerTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  viewer.kind = kind;
  viewer.container = container;

  void nextTick(() => viewerClose.value?.$el?.focus());
}

/**
 * Закрытие освобождает поток и возвращает фокус в исходную строку контейнера.
 * Удалённая строка либо переход к другому разделу не получают запоздалый фокус.
 */
function closeViewer(): void {
  const trigger = viewerTrigger;

  viewer.kind = '';
  viewer.container = null;
  viewerTrigger = null;

  void nextTick(() => {
    if (trigger?.isConnected) {
      trigger.focus();
    }
  });
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

  restoreViewer();

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

function exportState() {
  return { tab: tab.value, viewer: { kind: viewer.kind, containerId: viewer.container?.id ?? '' } };
}

/**
 * Возврат сначала импортирует снимок в скрытую панель, затем показывает колонку.
 * Просмотрщик монтируется активным, чтобы его единственный клиент открыл соединение.
 */
function restoreViewer() {
  if (props.active && pendingViewer) {
    openViewer(pendingViewer.kind, pendingViewer.container);
    pendingViewer = null;
  }
}

/**
 * Восстанавливает вкладку и просмотрщик после перечитывания контейнеров.
 * Соединения статистики принадлежат только новому смонтированному экземпляру.
 */
async function importState(state: Record<string, unknown>) {
  await store.load();
  selectTab(String(state.tab));

  const selected = state.viewer as { kind?: string; containerId?: string } | undefined;
  const container = store.containers.find((item) => item.id === selected?.containerId);

  if (container && (selected?.kind === 'logs' || selected?.kind === 'exec')) {
    pendingViewer = { kind: selected.kind, container };
    restoreViewer();
  }
}

defineExpose({ exportState, importState });

onBeforeUnmount(() => {
  store.stopStats();
});
</script>

<style scoped>
.docker-panel {
  container: docker-panel / inline-size;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: var(--surface);
}

.docker-panel__surface {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.docker-panel__heading {
  flex: none;
}

.is-dock .docker-panel__heading {
  padding-right: var(--tool-dock-actions-space, 82px);
}

.docker-panel__title,
.docker-panel__connection {
  display: flex;
  align-items: center;
  gap: 8px;
}

.docker-panel__connection i {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--idle);
}

.docker-panel__connection.is-online i {
  background: var(--good);
}

.docker-panel__navigation {
  display: grid;
  flex: none;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}

.docker-panel__summary {
  display: grid;
  grid-template-columns: repeat(4, auto);
  gap: 16px;
  margin: 0;
  padding-left: 16px;
  border-left: 1px solid var(--line);
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 18px;
}

.docker-summary-item {
  display: flex;
  flex-direction: row-reverse;
  align-items: baseline;
  gap: 6px;
}

.docker-summary-item dd {
  margin: 0;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  font-weight: 600;
}

.docker-summary-item.is-running dd {
  color: var(--good);
}

.docker-panel__message {
  flex: none;
  margin: 8px 12px;
}

.docker-tab__count {
  color: var(--ink-mid);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.docker-panel__workspace {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}

.has-viewer .docker-panel__workspace {
  grid-template-columns: minmax(400px, 0.9fr) minmax(0, 1.1fr);
}

.docker-panel__content {
  min-width: 0;
  min-height: 0;
  padding: 12px;
  overflow: auto;
  scrollbar-gutter: stable;
}

.docker-viewer {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-left: 1px solid var(--line);
  overflow: hidden;
}

.docker-viewer__name {
  min-width: 0;
  max-width: 28ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@container docker-panel (max-width: 900px) {
  .docker-panel__navigation {
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }

  .docker-panel__summary {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    width: 100%;
    padding-left: 0;
    border-left: 0;
  }

  .docker-summary-item {
    justify-content: flex-end;
  }
}

@container docker-panel (max-width: 400px) {
  .docker-panel__summary {
    gap: 8px;
  }

  .docker-summary-item {
    flex-direction: column-reverse;
    align-items: flex-start;
    gap: 0;
  }
}

@container docker-panel (max-width: 960px) {
  .has-viewer .docker-panel__workspace {
    grid-template-columns: minmax(0, 1fr);
  }

  .has-viewer .docker-panel__content {
    display: none;
  }

  .docker-viewer {
    border-left: 0;
  }
}
</style>
