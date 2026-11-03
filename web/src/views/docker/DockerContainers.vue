<template>
  <div class="docker-containers">
    <div class="docker-containers__filters">
      <div class="docker-containers__search">
        <UiSearchInput
          v-model="query"
          placeholder="Имя, образ, порт или проект"
          aria-label="Поиск контейнера"
        />
      </div>
      <div class="docker-containers__filter-options">
        <UiCheckbox v-model="showStopped">Показывать незапущенные</UiCheckbox>
        <span class="docker-containers__caption" aria-live="polite"
              :aria-label="`Показано контейнеров: ${visible.length} из ${store.containers.length}`">
          {{ visible.length }} из {{ store.containers.length }}
        </span>
      </div>
    </div>

    <UiInlineMessage v-if="message" :tone="message.tone" class="docker-containers__message">
      {{ message.text }}
    </UiInlineMessage>

    <DockerLoading v-if="store.loading && !store.containers.length"
      label="Получаем контейнеры…" description="Здесь появятся проекты и состояние их сервисов."
      area="containers" :failed="Boolean(store.error)" />
    <div v-else-if="!groups.length" class="docker-containers__empty">
      <strong>{{ store.containers.length ? 'Контейнеры не найдены' : 'Контейнеров пока нет' }}</strong>
      <p v-if="store.containers.length">Измените запрос или включите показ незапущенных контейнеров.</p>
      <p v-else>Созданные на этом хосте контейнеры появятся здесь после обновления.</p>
    </div>

    <div v-if="groups.length" class="docker-containers__columns" aria-hidden="true">
      <span>Контейнер / образ</span>
      <span>Порты</span>
      <span>CPU</span>
      <span>Память</span>
      <span>Действия</span>
    </div>

    <article v-for="group in groups" :key="group.key" class="docker-group">
      <header class="docker-group__head">
        <UiIconButton
          role="embedded"
          data-context="workspace-toolbar"
          :label="`${collapsed.has(group.key) ? 'Развернуть' : 'Свернуть'} проект ${group.title}`"
          v-tooltip="collapsed.has(group.key) ? 'Развернуть проект' : 'Свернуть проект'"
          :aria-expanded="!collapsed.has(group.key)"
          :aria-controls="groupId(group)"
          @click="toggleGroup(group.key)"
        >
          <svg v-bind="ICON" aria-hidden="true">
            <path :d="collapsed.has(group.key) ? 'M9 5l7 7-7 7' : 'M5 9l7 7 7-7'" />
          </svg>
        </UiIconButton>
        <div class="docker-group__title">
          <strong v-tooltip="group.title">{{ group.title }}</strong>
          <small v-if="group.workingDir" v-tooltip="group.workingDir">{{ group.workingDir }}</small>
          <small v-else>Отдельные контейнеры</small>
        </div>
        <span class="docker-group__count" :class="{ 'is-running': group.running > 0 }">
          <i aria-hidden="true"></i>{{ group.running }} / {{ group.total }} работают
        </span>
        <div v-if="group.project" class="docker-group__actions">
          <UiButton
            size="compact"
            :disabled="projectBusy(group)"
            @click="runProject(group, group.running ? 'restart' : 'start')"
          >
            {{ group.running ? 'Перезапустить' : 'Поднять' }}
          </UiButton>
          <UiIconButton
            v-if="group.running"
            role="embedded"
            data-context="workspace-toolbar"
            :label="`Остановить проект ${group.title}`"
            v-tooltip="'Остановить весь проект'"
            :disabled="projectBusy(group)"
            @click="runProject(group, 'stop')"
          >
            <svg v-bind="ICON" aria-hidden="true"><path d="M6 6h12v12H6z" /></svg>
          </UiIconButton>
        </div>
      </header>

      <div v-show="!collapsed.has(group.key)" :id="groupId(group)">
        <ul class="docker-list">
          <li
            v-for="container in group.items"
            :key="container.id"
            class="docker-row"
            :class="`tone-${stateTone(container)}`"
          >
            <div class="docker-row__main">
              <div class="docker-row__name">
                <span class="docker-row__dot" aria-hidden="true"></span>
                <strong v-tooltip="container.name">{{ container.compose?.service || container.name }}</strong>
                <div class="docker-row__state">
                  <span v-tooltip="container.status">{{ stateLabel(container.state) }}</span>
                  <span v-if="container.health" class="docker-row__health" :data-health="container.health">
                    {{ healthLabel(container.health) }}
                  </span>
                </div>
              </div>
              <small class="docker-row__image" v-tooltip="container.image">
                {{ formatContainerImage(container.image) }}
              </small>
            </div>

            <div class="docker-row__ports">
              <template
                v-for="port in container.ports"
                :key="`${port.published}-${port.target}-${port.protocol}`"
              >
                <StandLink
                  v-if="port.published"
                  class="docker-port"
                  :href="sandboxUrl(port.published) || ''"
                  v-tooltip="`Открыть ${formatPort(port)}`"
                >{{ formatPort(port) }}<span aria-hidden="true"> ↗</span></StandLink>
                <span v-else class="docker-port is-internal">{{ formatPort(port) }}</span>
              </template>
              <span v-if="!container.ports.length" class="docker-row__placeholder">Нет портов</span>
            </div>

            <div class="docker-row__cpu">
              <span class="docker-row__metric-label">CPU</span>
              {{ formatCpu(container) }}
            </div>
            <div class="docker-row__memory">
              <span class="docker-row__metric-label">Память</span>
              {{ formatMemory(container) }}
            </div>

            <div class="docker-row__actions">
              <UiIconButton
                role="embedded"
                data-context="workspace-toolbar"
                :label="`Логи ${container.name}`"
                v-tooltip="'Логи'"
                @click="emit('logs', container)"
              >
                <svg v-bind="ICON" aria-hidden="true">
                  <path d="M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5" />
                </svg>
              </UiIconButton>
              <UiIconButton
                role="embedded"
                data-context="workspace-toolbar"
                :label="`Терминал в контейнере ${container.name}`"
                v-tooltip="allowExec ? 'Терминал' : 'Терминал выключен в настройках плагина'"
                :disabled="container.state !== 'running' || !allowExec"
                @click="emit('exec', container)"
              >
                <svg v-bind="ICON" aria-hidden="true">
                  <path d="M4 5h16v14H4z M7 9l3 3-3 3 M13 15h4" />
                </svg>
              </UiIconButton>
              <UiIconButton
                class="docker-row__lifecycle"
                role="embedded"
                data-context="workspace-toolbar"
                :label="`${container.state === 'running' ? 'Перезапустить' : 'Запустить'} ${container.name}`"
                v-tooltip="container.state === 'running' ? 'Перезапустить' : 'Запустить'"
                :disabled="store.isBusy(group.project)"
                :loading="store.isBusy(container.id)"
                @click="run(container, container.state === 'running' ? 'restart' : 'start')"
              >
                <UiRefreshIcon v-if="container.state === 'running'" />
                <svg v-else v-bind="ICON" aria-hidden="true">
                  <path d="M8 5l11 7-11 7z" />
                </svg>
              </UiIconButton>
              <UiIconButton
                v-if="container.state === 'running'"
                role="embedded"
                data-context="workspace-toolbar"
                :label="`Остановить ${container.name}`"
                v-tooltip="'Остановить'"
                :disabled="store.isBusy(group.project)"
                :loading="store.isBusy(container.id)"
                @click="run(container, 'stop')"
              >
                <svg v-bind="ICON" aria-hidden="true"><path d="M7 7h10v10H7z" /></svg>
              </UiIconButton>
              <UiIconButton
                role="embedded"
                data-context="workspace-toolbar"
                :label="`Удалить контейнер ${container.name}`"
                v-tooltip="'Удалить контейнер'"
                tone="danger"
                :disabled="store.isBusy(group.project)"
                :loading="store.isBusy(container.id)"
                @click="removeOne(container)"
              >
                <svg v-bind="ICON" aria-hidden="true">
                  <path d="M5 7h14 M9 7V5h6v2 M7 7l1 13h8l1-13 M10 11v6 M14 11v6" />
                </svg>
              </UiIconButton>
            </div>
          </li>
        </ul>
      </div>
    </article>
  </div>
</template>

<script setup lang="ts">
import StandLink from '../../shared/browser/StandLink.vue';
import DockerLoading from './DockerLoading.vue';

import { computed, onBeforeUnmount, ref } from 'vue';
import type { SVGAttributes } from 'vue';

import type {
  DockerActionResult,
  DockerContainer,
  DockerContainerAction,
  DockerProjectAction,
  DockerProjectActionResponse,
  DockerStatsMap,
} from '../../../../shared/plugins/docker/dockerContracts';

import { sandboxUrl } from '../../shared/sandbox.ts';
import { useDockerStore } from '../../stores/docker';
import { usePluginsStore } from '../../stores/plugins.ts';
import {
  UiRefreshIcon,
  UiButton,
  UiCheckbox,
  UiIconButton,
  UiInlineMessage,
  UiSearchInput,
  confirmDialog,
  vTooltip,
} from '../../ui';
import { formatContainerImage, formatPort, formatSize, stateLabel, stateTone } from './format';
import { dockerSettings } from './settings';

interface DockerFeedback {
  tone: 'success' | 'danger';
  text: string;
}

interface ContainerGroup {
  key: string;
  project: string;
  title: string;
  workingDir: string;
  items: DockerContainer[];
  total: number;
  running: number;
}

const props = withDefaults(defineProps<{ stats?: DockerStatsMap }>(), {
  stats: () => ({}),
});
const emit = defineEmits<{
  logs: [container: DockerContainer];
  exec: [container: DockerContainer];
}>();

const ICON: SVGAttributes = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '1.8',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
};
const HEALTH_LABELS: Record<string, string> = {
  healthy: 'исправен',
  unhealthy: 'ошибка проверки',
  starting: 'проверяется',
};

const store = useDockerStore();
const plugins = usePluginsStore();
const query = ref('');
const showStopped = ref(false);
const collapsed = ref(new Set<string>());
const message = ref<DockerFeedback | null>(null);
let messageTimer: ReturnType<typeof setTimeout> | undefined;

const allowExec = computed(() => dockerSettings(plugins.byId('docker')).allowExec !== false);
const statsOf = (container: DockerContainer) => container.state === 'running'
  ? props.stats[container.id] || null
  : null;
const healthLabel = (health: DockerContainer['health']) => HEALTH_LABELS[health] || health;
const groupId = (group: ContainerGroup) => `docker-project-${encodeURIComponent(group.key)}`;

function formatCpu(container: DockerContainer): string {
  const stats = statsOf(container);

  return stats ? `${Math.round(stats.cpuPercent)}%` : '—';
}

function formatMemory(container: DockerContainer): string {
  const stats = statsOf(container);

  return stats ? formatSize(stats.memoryUsed) : '—';
}

/**
 * Поиск учитывает опубликованный и внутренний порт, сервис и compose-проект:
 * человек может помнить адрес стенда, не зная имени контейнера.
 */
function matches(container: DockerContainer): boolean {
  const needle = query.value.trim().toLowerCase();

  if (!needle) {
    return true;
  }

  const haystack = [
    container.name,
    container.image,
    container.compose?.project,
    container.compose?.service,
    ...container.ports.map((port) => `${port.published} ${port.target}`),
  ].join(' ').toLowerCase();

  return haystack.includes(needle);
}

const visible = computed(() => store.containers.filter((container) => {
  if (!showStopped.value && container.state !== 'running') {
    return false;
  }

  return matches(container);
}));

// Счётчики и действия относятся ко всему проекту, даже если поиск скрыл его часть.
const groups = computed(() => {
  const byProject = new Map<string, ContainerGroup>();
  const visibleIds = new Set(visible.value.map((container) => container.id));

  for (const container of store.containers) {
    const project = container.compose?.project || '';
    const key = project ? `project:${project}` : 'loose';
    const group = byProject.get(key) || {
      key,
      project,
      title: project || 'Без проекта',
      workingDir: container.compose?.workingDir || '',
      items: [],
      total: 0,
      running: 0,
    };

    group.total += 1;

    if (container.state === 'running') {
      group.running += 1;
    }

    if (visibleIds.has(container.id)) {
      group.items.push(container);
    }

    byProject.set(key, group);
  }

  return [...byProject.values()]
    .filter((group) => group.items.length)
    .sort((left, right) => Number(Boolean(right.project)) - Number(Boolean(left.project))
      || right.running - left.running
      || left.title.localeCompare(right.title, 'ru'));
});

function toggleGroup(key: string): void {
  if (collapsed.value.has(key)) {
    collapsed.value.delete(key);
  } else {
    collapsed.value.add(key);
  }
}

/**
 * Новое сообщение заменяет предыдущее вместе с таймером, чтобы старый ответ
 * не скрыл результат следующего действия.
 */
function report(result: DockerActionResult | DockerProjectActionResponse, okText: string): void {
  clearTimeout(messageTimer);

  const failure = 'message' in result ? result.message : '';

  message.value = result.ok
    ? { tone: 'success', text: okText }
    : { tone: 'danger', text: failure || 'Демон отклонил действие' };
  messageTimer = setTimeout(() => {
    message.value = null;
  }, 6000);
}

async function run(container: DockerContainer, action: DockerContainerAction): Promise<void> {
  const result = await store.containerAction(container.id, action);

  report(result, `${container.name}: готово`);
}

/**
 * Действие над проектом не пересекается с уже запущенной мутацией его контейнера,
 * даже когда этот контейнер скрыт поиском или фильтром состояния.
 */
function projectBusy(group: ContainerGroup): boolean {
  return store.isBusy(group.project) || store.containers.some((container) =>
    container.compose?.project === group.project && store.isBusy(container.id));
}

/**
 * Остановка затрагивает весь compose-проект. В диалоге показываем полное число
 * контейнеров независимо от поискового запроса и фильтра состояния.
 */
async function runProject(group: ContainerGroup, action: DockerProjectAction): Promise<void> {
  const labels = {
    start: 'поднят',
    stop: 'остановлен',
    restart: 'перезапущен',
  };

  if (projectBusy(group)) {
    return;
  }

  if (action === 'stop' && !await confirmDialog(
    `Остановить весь проект «${group.project}» — ${group.total} контейнер(ов)?`,
    {
      title: 'Остановка проекта',
      okText: 'Остановить',
      danger: true,
    },
  )) {
    return;
  }

  if (projectBusy(group)) {
    return;
  }

  const result = await store.projectAction(group.project, action);

  report(result, `${group.project} ${labels[action]}`);
}

/**
 * Удаление работающего контейнера требует принудительной остановки;
 * предупреждаем об этом до отправки запроса демону.
 */
async function removeOne(container: DockerContainer): Promise<void> {
  const running = container.state === 'running';
  const accepted = await confirmDialog(
    `Удалить контейнер «${container.name}»?`
      + (running ? '\n\nОн сейчас работает и будет остановлен принудительно.' : ''),
    {
      title: 'Удаление контейнера',
      okText: 'Удалить',
      danger: true,
    },
  );

  if (!accepted) {
    return;
  }

  const result = await store.removeContainer(container.id, { force: running });

  report(result, `${container.name} удалён`);
}

onBeforeUnmount(() => {
  clearTimeout(messageTimer);
});
</script>

<style scoped>
.docker-containers {
  container: docker-containers / inline-size;
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0;
}

.docker-containers__filters {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 12px 24px;
  position: sticky;
  top: -12px;
  z-index: 2;
  margin: -12px -12px 0;
  padding: 12px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}

.docker-containers__search {
  min-width: 0;
  flex: 0 1 420px;
}

.docker-containers__filter-options {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 20px;
}

.docker-containers__caption {
  flex: none;
  color: var(--ink-mid);
  font-size: 12px;
  white-space: nowrap;
}

.docker-containers__empty {
  padding: 32px 12px;
  text-align: center;
}

.docker-containers__empty strong {
  font-size: 13px;
}

.docker-containers__empty p {
  margin: 8px 0 0;
  color: var(--ink-mid);
  font-size: 13px;
}

.docker-group {
  min-width: 0;
  margin-bottom: 12px;
}

.docker-group__head {
  display: flex;
  align-items: center;
  min-width: 0;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-2);
  gap: 8px;
}

.docker-group__title {
  min-width: 0;
  flex: 1;
}

.docker-group__title strong {
  display: block;
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.docker-group__title small {
  display: block;
  overflow: hidden;
  margin-top: 3px;
  color: var(--ink-mid);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.docker-group__count {
  display: flex;
  align-items: center;
  flex: none;
  color: var(--ink-mid);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  gap: 6px;
}

.docker-group__count i,
.docker-row__dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--idle);
}

.docker-group__count.is-running i,
.tone-good .docker-row__dot {
  background: var(--good);
}

.docker-group__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: 0;
}

.docker-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.docker-containers__columns,
.docker-row {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(220px, 1fr) 54px 84px 168px;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
}

.docker-containers__columns {
  padding-block: 6px;
  color: var(--ink-mid);
  font-size: 12px;
}

.docker-containers__columns > :nth-child(3),
.docker-containers__columns > :nth-child(4) {
  text-align: right;
}

.docker-containers__columns > :last-child {
  text-align: center;
}

.docker-row:hover {
  background: color-mix(in srgb, var(--surface-2) 40%, transparent);
}

.tone-warn .docker-row__dot {
  background: var(--warn);
}

.tone-bad .docker-row__dot {
  background: var(--bad);
}

.docker-row__main {
  min-width: 0;
}

.docker-row__name {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
}

.docker-row__name strong {
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.docker-row__image {
  display: block;
  overflow: hidden;
  margin: 2px 0 0;
  color: var(--ink-mid);
  font-size: 12px;
  font-family: var(--mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.docker-row__state {
  display: flex;
  flex: none;
  max-width: 60%;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  color: var(--ink-mid);
  font-size: 12px;
}

.docker-row__health {
  color: var(--warn);
}

.docker-row__health[data-health='healthy'] {
  color: var(--good);
}

.docker-row__health[data-health='unhealthy'] {
  color: var(--bad);
}

.docker-row__ports {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-content: center;
  align-items: center;
  gap: 0 12px;
}

.docker-port {
  display: inline-flex;
  align-items: center;
  min-height: var(--toolbar-control-h);
  color: var(--accent);
  font-family: var(--mono);
  font-size: 12px;
  text-decoration: none;
  white-space: nowrap;
}

.docker-port:hover {
  text-decoration: underline;
}

.docker-port.is-internal {
  color: var(--ink-mid);
}

.docker-row__placeholder {
  color: var(--ink-mid);
  font-size: 12px;
}

.docker-row__cpu,
.docker-row__memory {
  color: var(--ink);
  font-family: var(--mono);
  font-size: 12px;
  text-align: right;
  white-space: nowrap;
}

.docker-row__metric-label {
  display: none;
  color: var(--ink-mid);
  font-family: var(--sans);
  font-size: 12px;
}

.docker-row__actions {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
}

.docker-row__lifecycle {
  margin-left: 8px;
}

.docker-containers__message {
  margin: 8px 0;
}

@container docker-containers (max-width: 960px) {
  .docker-containers__columns {
    display: none;
  }

  .docker-row {
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 10px 16px;
  }

  .docker-row__main {
    grid-column: 1;
    grid-row: 1;
  }

  .docker-row__ports {
    grid-column: 1;
    grid-row: 2;
  }

  .docker-row__cpu {
    grid-column: 2;
    grid-row: 1;
  }

  .docker-row__memory {
    grid-column: 3;
    grid-row: 1;
  }

  .docker-row__actions {
    grid-column: 2 / 4;
    grid-row: 2;
  }

  .docker-row__metric-label {
    display: inline;
    margin-right: 6px;
  }
}

@container docker-containers (max-width: 720px) {
  .docker-containers__filters {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }

  .docker-containers__filter-options {
    justify-content: space-between;
  }
}

@container docker-containers (max-width: 600px) {
  .docker-group__head {
    flex-wrap: wrap;
    gap: 8px;
  }

  .docker-group__title {
    flex-basis: calc(100% - 60px);
  }

  .docker-group__count {
    flex: 1;
  }

  .docker-group__actions {
    margin-left: 0;
  }

  .docker-row {
    grid-template-columns: 1fr 1fr;
    padding: 10px 0;
    gap: 8px;
  }

  .docker-row__main {
    grid-column: 1 / -1;
  }

  .docker-row__ports {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  .docker-row__cpu,
  .docker-row__memory {
    grid-row: 3;
    text-align: left;
  }

  .docker-row__cpu {
    grid-column: 1;
  }

  .docker-row__memory {
    grid-column: 2;
  }

  .docker-row__actions {
    grid-column: 1 / -1;
    grid-row: 4;
    padding-top: 0;
  }
}
@media (max-height: 500px) {
  .docker-containers {
    gap: 8px;
  }
  .docker-row {
    padding-block: 8px;
  }
}
</style>
