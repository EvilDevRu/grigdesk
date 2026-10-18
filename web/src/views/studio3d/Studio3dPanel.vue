<template>
  <section
    class="studio-panel"
    :class="{
      'is-active': active,
      'is-compact': !wide,
      'is-dock': presentation === 'dock',
      'is-model': tab === 'models' && Boolean(modelId),
      'is-page': presentation === 'page'
    }"
  >
    <header class="studio-header">
      <div class="studio-identity">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
          stroke-linejoin="round" aria-hidden="true">
          <path d="M12 2l9 5v10l-9 5-9-5V7z M12 22V12 M21 7l-9 5-9-5" />
        </svg>
        <h2>3D</h2>
      </div>
      <div v-if="store.state" class="studio-resources">
        <div v-for="provider in store.state.providers.filter((item) => !item.local)"
          :key="provider.id" class="studio-resource">
          <span class="studio-resource-label">{{ provider.name }}</span>
          <template v-if="provider.available && provider.balance">
            <strong>{{ formatPrice(provider.balance.available, provider.unit) }}</strong>
            <span class="studio-resource-note">{{ provider.balance.reserved }} в резерве</span>
          </template>
          <template v-else-if="provider.available">баланс неизвестен</template>
          <UiActionLink v-else href="#/settings" @click.prevent="providerSettings(provider.id)">нужен ключ</UiActionLink>
        </div>
        <div class="studio-resource" :class="{ 'studio-disk-warning': store.state.library.lowDisk }">
          <span class="studio-resource-label">Библиотека</span>
          <strong>{{ bytes(store.state.library.bytes) }}</strong>
          <span class="studio-resource-note">свободно {{ bytes(store.state.library.freeBytes) }}</span>
        </div>
      </div>
    </header>
    <UiInlineMessage v-if="disabled">
      Плагин «3D» выключен. Включить его можно в «Настройки → Плагины».
    </UiInlineMessage>
    <template v-else>
      <nav class="studio-navigation" aria-label="Разделы 3D">
        <UiTabs :model-value="tab" label="Разделы 3D" data-ui-studio-tabs @update:model-value="choose">
          <UiTab v-for="item in tabs" :id="`${panelId}-${item.id}`" :key="item.id" :value="item.id"
            :controls="panelId" :aria-label="item.id === 'tasks' && store.active
              ? `Задачи · ${store.active}` : item.label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path :d="item.icon" />
            </svg>
            {{ item.label }}
            <span v-if="item.id === 'tasks' && store.active" class="studio-badge">{{ store.active }}</span>
          </UiTab>
        </UiTabs>
      </nav>
      <UiInlineMessage v-if="store.error" tone="danger">{{ store.error }}</UiInlineMessage>
      <UiInlineMessage v-if="store.state && !store.state.library.ok" tone="warning">
        {{ store.state.library.error }}
      </UiInlineMessage>
      <div :id="panelId" class="studio-content" role="tabpanel" :aria-labelledby="`${panelId}-${tab}`">
        <CreatePanel :key="store.libraryId" v-show="tab === 'create'" :active="active && tab === 'create'"
          @created="openCreated" @tasks="choose('tasks')" />
        <div v-if="tab === 'models' && modelId" class="studio-layout" :data-pane="modelPane"
          :class="{ 'studio-compact-column': !wide }" :style="{ '--studio-nav-width': `${navWidth}px` }">
          <UiTabs v-model="modelPane" class="studio-model-panes" data-ui-workspace-tabs label="Работа с моделью">
            <UiTab value="viewer" :controls="`${panelId}-viewer`">Модель</UiTab>
            <UiTab value="versions" :controls="`${panelId}-versions`">Версии</UiTab>
            <UiTab value="details" :controls="`${panelId}-details`">Сведения</UiTab>
          </UiTabs>
          <aside :id="`${panelId}-versions`" class="studio-navigator">
            <div class="studio-tree-heading">
              <UiButton variant="ghost" @click="back">← Все модели</UiButton>
              <div class="studio-tree-title">
                <h3>Версии модели</h3>
                <span v-if="store.detail">{{ store.detail.versions.length }}</span>
              </div>
            </div>
            <VersionTree
              v-if="store.detail"
              :versions="store.detail.versions"
              :selected="store.selectedVersion"
              :main="store.detail.model.mainVersion"
              @select="selectVersion"
            />
            <UiPressable
              v-if="wide"
              class="studio-separator"
              data-context="studio-separator"
              role="separator"
              tabindex="0"
              aria-orientation="vertical"
              aria-label="Ширина навигатора 3D"
              :aria-valuenow="navWidth"
              :aria-valuemin="240"
              :aria-valuemax="420"
              @pointerdown="resizeStart"
              @pointermove="resizeMove"
              @pointerup="resizeEnd"
              @pointercancel="resizeEnd"
              @keydown="resizeKey"
              @dblclick="resizeReset"
            />
          </aside>
          <main :id="`${panelId}-viewer`" class="studio-main">
            <ModelPage
              :active="active"
              :show-save-shortcut="!wide"
              :compare-version-id="compareVersion"
              @save="detailPage?.openSave()"
              @created="openCreated"
              @tasks="choose('tasks')"
            />
          </main>
          <aside :id="`${panelId}-details`" class="studio-side">
            <ModelPage
              ref="detailPage"
              section="details"
              :compare-version-id="compareVersion"
              @compare="compareVersion = $event"
              @created="openCreated"
              @tasks="choose('tasks')"
            />
          </aside>
        </div>
        <main v-else-if="tab !== 'create'" class="studio-page-scroll">
          <LibraryPanel v-if="tab === 'models'" @open="openCreated" @create="choose('create')" />
          <TasksPanel v-else @open="openCreated" />
        </main>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch, useId } from 'vue';
import { UiButton, UiTabs, UiTab, UiActionLink, UiInlineMessage, UiPressable } from '../../ui.ts';
import { useStudio3dStore } from '../../stores/studio3d.ts';
import { openSettings } from '../../shared/settingsNavigation.ts';
import { usePluginsStore } from '../../stores/plugins.js';
import { useDockStore } from '../../stores/dock.js';
import { formatPrice } from '../../../../shared/studio3d/studio3dOperations.ts';
import CreatePanel from './CreatePanel.vue';
import LibraryPanel from './LibraryPanel.vue';
import VersionTree from './VersionTree.vue';
import ModelPage from './ModelPage.vue';
import TasksPanel from './TasksPanel.vue';

type StudioTab = 'create' | 'models' | 'tasks';

interface StudioIntent {
  id: number;
  type?: string;
  tab?: string;
  model?: string;
  version?: string;
}

const props = withDefaults(defineProps<{
  active?: boolean;
  compact?: boolean;
  presentation?: string;
  intents?: StudioIntent[];
}>(), {
  active: true,
  compact: false,
  presentation: 'page',
  intents: () => []
});

const emit = defineEmits<{
  'consume-intent': [id: number];
  context: [value: { tab: StudioTab; model: string } | null];
}>();

const store = useStudio3dStore();
const plugins = usePluginsStore();
const dock = useDockStore();
const panelId = `studio-panel-${useId()}`;
const detailPage = ref<InstanceType<typeof ModelPage> | null>(null);

const tab = ref<StudioTab>('create');
const modelId = ref('');
const modelPane = ref('viewer');
const compareVersion = ref('');
const pendingVersion = ref('');
const selectionEpoch = ref(0);
const disabled = computed(() => plugins.loaded && !plugins.enabled('studio3d'));

const tabs: {
  id: StudioTab;
  label: string;
  icon: string
}[] = [
  {
    id: 'create',
    label: 'Создать',
    icon: 'M12 4v16 M4 12h16'
  },
  {
    id: 'models',
    label: 'Модели',
    icon: 'M12 2l9 5v10l-9 5-9-5V7z M12 22V12 M21 7l-9 5-9-5'
  },
  {
    id: 'tasks',
    label: 'Задачи',
    icon: 'M4 5h16v14H4z M8 9h8 M8 13h5'
  },
];

const handledIntents = new Set<number>();

/**
 * Развёрнутый док занимает всю ширину колонки контента, как страница.
 * Обычный док (380–700 px) показывает компактную одноколоночную раскладку.
 */
const dockExpanded = computed(() => props.presentation === 'dock'
  && dock.isExpanded === true && dock.activeTool === 'studio3d');
const wide = computed(() => props.presentation === 'page' || !props.compact || dockExpanded.value);

/**
 * Открытие модели — состояние панели: в доке адрес принадлежит чату.
 * Явная версия применяется в такте watcher-а вместе с active и library.
 */
function showModel(model: string, version = ''): void {
  tab.value = 'models';
  modelId.value = model;
  modelPane.value = 'viewer';
  pendingVersion.value = version;
  selectionEpoch.value += 1;
}

/**
 * Просмотрщик живёт только в активной панели: скрытый док обязан освободить WebGL.
 * Единственное место вызова openModel держит viewing и selection согласованными.
 */
watch([() => props.active, tab, modelId, selectionEpoch, () => store.state?.library.ok], () => {
  const visible = props.active && tab.value === 'models' ? modelId.value : '';

  store.setViewingModel(visible);

  if (visible && store.state?.library.ok) {
    void store.openModel(visible, pendingVersion.value || store.selectedVersion);
    pendingVersion.value = '';
  }
}, { immediate: true });

watch(modelId, () => {
  compareVersion.value = '';
});

/**
 * Дерево выбирает версию через тот же канал, что и команда open.
 * Так выбор из тоста и клик по версии неотличимы для store.
 */
function selectVersion(version: string): void {
  modelPane.value = 'viewer';

  if (!modelId.value) {
    return;
  }

  pendingVersion.value = version;
  selectionEpoch.value += 1;
}

/**
 * Вкладки сохраняют выбранную модель, чтобы человек мог проверить очередь и вернуться.
 * Скрытый viewer размонтируется, а подписка стора остаётся у оболочки.
 */
function choose(value: string | number): void {
  if (!tabs.some((item) => item.id === value)) {
    return;
  }

  tab.value = value as StudioTab;
}

/**
 * Возвращение к библиотеке очищает только выбор панели.
 * Загруженная модель остаётся кэшем reconnect и не подавляет чужие тосты.
 */
function back(): void {
  modelId.value = '';
}

/**
 * Созданная модель открывается как обычная команда open с новой версией.
 * Платный запуск остаётся в store и продолжает обновляться при смене вкладки.
 */
function openCreated(model: string, version?: string): void {
  showModel(model, version || '');
}

/**
 * Команда open приходит из адаптера маршрута точно один раз на идентификатор.
 * Неизвестные команды тоже подтверждаются: очередь дока не растёт вечно.
 */
function processIntents(): void {
  const current = new Set(props.intents.map((intent) => intent.id));

  for (const id of handledIntents) {
    if (!current.has(id)) {
      handledIntents.delete(id);
    }
  }

  for (const intent of props.intents) {
    if (handledIntents.has(intent.id)) {
      continue;
    }

    handledIntents.add(intent.id);

    if (intent.type === 'open') {
      if (intent.tab && ['create', 'models', 'tasks'].includes(intent.tab)) {
        tab.value = intent.tab as StudioTab;
      }

      if (intent.model) {
        showModel(intent.model, intent.version || '');
      }
    }

    emit('consume-intent', intent.id);
  }
}

watch(() => props.intents, processIntents, { deep: true, immediate: true });

/**
 * Контекст панели публикуется только пока она активна.
 * Скрытый dock не должен подменять ui-context чата своими вкладками.
 */
watch([tab, modelId, () => props.active], () => {
  emit('context', props.active ? {
    tab: tab.value,
    model: tab.value === 'models' ? modelId.value : ''
  } : null);
}, { immediate: true });

/**
 * Ссылка ведёт сразу к исполнителям, не раскрывая ключ в этой панели.
 * Entity берётся из строки реестра исполнителей, без собственного vendor id в UI.
 */
function providerSettings(id: string): void {
  openSettings({ pageId: 'agents.providers', entityId: id });
}

/**
 * Числа размеров показываются отдельно от доступного баланса и денежных оценок.
 * Недоступный statfs остаётся неизвестным и не превращается в ноль свободного места.
 */
function bytes(value: number | null): string {
  if (value === null) {
    return 'неизвестно';
  }

  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value / 1024 ** 3)} ГБ`;
}

/**
 * Размер панели хранится на устройстве, ограничен рабочим диапазоном 240–420px.
 * Отсутствующая запись использует 260px, отказ storage не мешает открытию панели.
 */
function savedWidth(): number {
  try {
    const saved = localStorage.getItem('grigdesk-studio3d-nav-width');

    return saved ? Math.max(240, Math.min(420, Number(saved) || 260)) : 260;
  } catch {
    return 260;
  }
}

const navWidth = ref(savedWidth());
let drag: {
  x: number;
  width: number;
  id: number
} | null = null;

/**
 * Захват указателя держит resize внутри одного собственного separator.
 * Не ставит глобальных listeners, которые могли бы пережить панель.
 */
function resizeStart(event: PointerEvent): void {
  drag = {
    x: event.clientX,
    width: navWidth.value,
    id: event.pointerId
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}

/**
 * Pointer движение меняет только геометрию навигатора и не вызывает API.
 * Границы совпадают с доступными aria-valuemin/aria-valuemax.
 */
function resizeMove(event: PointerEvent): void {
  if (drag) {
    navWidth.value = Math.max(240, Math.min(420, drag.width + event.clientX - drag.x));
  }
}

/**
 * Завершение жеста фиксирует настройку один раз, включая pointer cancel.
 * Сбой localStorage оставляет выбранную ширину на текущей панели.
 */
function resizeEnd(): void {
  drag = null;

  try {
    localStorage.setItem('grigdesk-studio3d-nav-width', String(navWidth.value));
  } catch { /* Геометрия в памяти. */ }
}

/**
 * Клавиатура даёт точный и крупный шаг, Home/End выбирают границы диапазона.
 * Это тот же control для мыши, касания и доступного управления.
 */
function resizeKey(event: KeyboardEvent): void {
  const step = event.shiftKey ? 30 : 10;
  const values: Record<string, number> = {
    ArrowLeft: navWidth.value - step,
    ArrowRight: navWidth.value + step,
    Home: 240,
    End: 420
  };
  const value = values[event.key];

  if (value === undefined) {
    return;
  }

  event.preventDefault();
  navWidth.value = Math.max(240, Math.min(420, value));
  resizeEnd();
}

/**
 * Двойной щелчок возвращает CSS умолчание, не переносит prefs между устройствами.
 * Удаление storage обёрнуто так же, как сохранение геометрии.
 */
function resizeReset(): void {
  navWidth.value = 260;

  try {
    localStorage.removeItem('grigdesk-studio3d-nav-width');
  } catch { /* Геометрия в памяти. */ }
}

onUnmounted(() => {
  store.setViewingModel('');
});
</script>

<style scoped>
.studio-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  background: var(--ground);
  container: studio / inline-size;
}

.studio-header {
  display: flex;
  flex: none;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px 24px;
  padding: 10px 16px 6px;
}

.studio-identity {
  display: flex;
  align-items: center;
  gap: 10px;
}

.studio-identity svg {
  width: 20px;
  height: 20px;
  color: var(--accent);
}

.studio-header h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
}

.is-dock .studio-header {
  padding-right: var(--tool-dock-actions-space, 82px);
}

.studio-resources {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px 20px;
  font-size: 12px;
}

.studio-resource {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 8px;
  font-variant-numeric: tabular-nums;
}

.studio-resource-label,
.studio-resource-note {
  color: var(--ink-mid);
}

.studio-resource strong {
  font-weight: 550;
}

.studio-disk-warning,
.studio-disk-warning .studio-resource-note {
  color: var(--warn);
}

.studio-navigation {
  flex: none;
  padding: 0 16px;
  border-bottom: 1px solid var(--line);
}

.studio-navigation svg {
  width: 16px;
  height: 16px;
  flex: none;
}

.studio-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.studio-layout {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-columns: var(--studio-nav-width, 260px) minmax(0, 1fr) 296px;
}

.studio-navigator {
  position: relative;
  min-width: 0;
  overflow: auto;
  padding: 10px 8px;
  border-right: 1px solid var(--line);
  background: var(--sidebar);
}

.studio-tree-heading {
  display: grid;
  justify-items: start;
  gap: 16px;
  margin-bottom: 10px;
}

.studio-tree-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 0 8px;
  color: var(--ink-mid);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.studio-tree-heading h3 {
  margin: 0;
  color: var(--ink-mid);
  font-size: 11px;
  font-weight: 600;
}

.studio-separator {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 6px;
  touch-action: none;
}

.studio-main,
.studio-side {
  padding: 16px 14px;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 16px;
}

.studio-side {
  border-left: 1px solid var(--line);
  background: var(--sidebar);
}

.studio-page-scroll {
  height: 100%;
  overflow: auto;
  padding: 20px;
}

.studio-compact-column {
  display: flex;
  flex-direction: column;
  overflow: auto;
}

.studio-compact-column > * {
  flex: none;
  overflow: visible;
}

.studio-compact-column .studio-navigator {
  --studio-tree-max-height: 180px;

  border-right: 0;
  border-bottom: 1px solid var(--line);
}

.studio-compact-column .studio-tree-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.studio-compact-column .studio-tree-title {
  width: auto;
  gap: 8px;
}

.studio-badge {
  padding: 1px 5px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  color: var(--accent);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

@container studio (max-width: 1099px) {
  .studio-layout:not(.studio-compact-column) {
    grid-template-columns: var(--studio-nav-width, 260px) minmax(0, 1fr);
    grid-template-rows: minmax(260px, 1fr) auto;
    overflow: auto;
  }

  .studio-layout:not(.studio-compact-column) .studio-navigator {
    grid-row: 1 / 3;
  }

  .studio-side {
    grid-column: 2;
  }
}

@container studio (max-width: 759px) {
  .studio-layout:not(.studio-compact-column) {
    display: flex;
    flex-direction: column;
    overflow: auto;
  }

  .studio-layout > * {
    flex: none;
    overflow: visible;
  }

  .studio-navigator {
    --studio-tree-max-height: 180px;

    border-right: 0;
    border-bottom: 1px solid var(--line);
  }

  .studio-tree-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
  }

  .studio-tree-title {
    width: auto;
    gap: 8px;
  }

  .studio-separator {
    display: none;
  }
}

@container studio (max-width: 559px) {
  .studio-header {
    align-items: flex-start;
    gap: 10px;
    padding-top: 12px;
    padding-left: 14px;
  }

  .studio-resources {
    flex-basis: 100%;
    justify-content: flex-start;
    gap: 6px;
  }

  .studio-resource {
    flex-basis: 100%;
  }

  .studio-navigation {
    padding: 0 10px;
  }

  .studio-page-scroll {
    padding: 14px;
  }
}
.studio-model-panes { display: none; }
@container studio (max-width: 1100px) {
  .studio-model-panes { display: flex; flex: none; }
  .studio-layout[data-pane] { display: flex; flex-direction: column; overflow: hidden; }
  .studio-layout[data-pane] > .studio-main,
  .studio-layout[data-pane] > .studio-navigator,
  .studio-layout[data-pane] > .studio-side { flex: 1; min-height: 0; overflow: auto; max-height: none; }
  .studio-layout:not([data-pane='viewer']) > .studio-main,
  .studio-layout:not([data-pane='versions']) > .studio-navigator,
  .studio-layout:not([data-pane='details']) > .studio-side { display: none; }
}
@media (max-height: 500px) {
  .studio-header { padding-block: 8px; }
  .is-model .studio-header { display: none; }
  .studio-main, .studio-side { padding: 8px; }
}
</style>
