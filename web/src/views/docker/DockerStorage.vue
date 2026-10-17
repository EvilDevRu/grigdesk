<template>
  <div class="docker-storage">
    <section class="docker-storage__block">
      <header class="docker-storage__head">
        <div class="docker-storage__heading">
          <h3>Тома <span>{{ store.volumes.length }}</span></h3>
          <p>Постоянные данные контейнеров. Неиспользуемых: {{ unusedVolumes }}.</p>
        </div>
        <UiCheckbox v-model="onlyUnusedVolumes">Только неиспользуемые</UiCheckbox>
      </header>

      <p v-if="!allowVolumeRemoval" class="docker-storage__note">
        Удаление томов выключено в настройках плагина.
      </p>
      <p v-if="!visibleVolumes.length" class="docker-storage__empty">
        {{ store.volumes.length ? 'Неиспользуемых томов нет.' : 'Томов пока нет.' }}
      </p>
      <ul v-else class="docker-list" aria-label="Тома Docker">
        <li v-for="volume in visibleVolumes" :key="volume.name" class="docker-item">
          <div class="docker-item__main">
            <strong v-tooltip="volume.name">{{ volume.name }}</strong>
            <div class="docker-item__meta">
              <span>{{ volume.compose ? `проект ${volume.compose}` : volume.driver }}</span>
              <span v-if="volume.anonymous">безымянный</span>
              <span :class="{ 'is-used': volume.inUse }">
                {{ volume.inUse ? 'используется' : 'не используется' }}
              </span>
            </div>
            <p v-if="volume.usedBy.length" class="docker-item__used" v-tooltip="volume.usedBy.join(', ')">
              Контейнеры: {{ volume.usedBy.join(', ') }}
            </p>
          </div>

          <div class="docker-item__end">
            <span v-if="volume.size !== null" class="docker-item__size">
              {{ formatSize(volume.size) }}
            </span>
            <UiIconButton
              role="embedded"
              :label="`Удалить том ${volume.name}`"
              v-tooltip="volumeRemovalTitle(volume)"
              tone="danger"
              :disabled="volume.inUse || !allowVolumeRemoval"
              :loading="store.isBusy(volume.name)"
              @click="removeVolume(volume)"
            >
              <svg v-bind="ICON" aria-hidden="true">
                <path d="M5 7h14 M9 7V5h6v2 M7 7l1 13h8l1-13 M10 11v6 M14 11v6" />
              </svg>
            </UiIconButton>
          </div>
        </li>
      </ul>
    </section>

    <section class="docker-storage__block">
      <header class="docker-storage__head">
        <div class="docker-storage__heading">
          <h3>Сети <span>{{ store.networks.length }}</span></h3>
          <p>Соединения между контейнерами. Встроенные и занятые сети сохраняются.</p>
        </div>
      </header>

      <p v-if="!store.networks.length" class="docker-storage__empty">Сетей пока нет.</p>
      <ul v-else class="docker-list" aria-label="Сети Docker">
        <li v-for="network in store.networks" :key="network.id" class="docker-item">
          <div class="docker-item__main">
            <strong v-tooltip="network.name">{{ network.name }}</strong>
            <div class="docker-item__meta">
              <span>{{ network.driver }}</span>
              <span v-if="network.subnets.length">{{ network.subnets.join(', ') }}</span>
              <span v-if="network.builtin">встроенная</span>
            </div>
          </div>

          <div class="docker-item__end">
            <span class="docker-item__size">{{ network.containers }} конт.</span>
            <UiIconButton
              role="embedded"
              :label="`Удалить сеть ${network.name}`"
              v-tooltip="networkRemovalTitle(network)"
              tone="danger"
              :disabled="network.builtin || network.containers > 0"
              :loading="store.isBusy(network.id)"
              @click="removeNetwork(network)"
            >
              <svg v-bind="ICON" aria-hidden="true">
                <path d="M5 7h14 M9 7V5h6v2 M7 7l1 13h8l1-13 M10 11v6 M14 11v6" />
              </svg>
            </UiIconButton>
          </div>
        </li>
      </ul>
    </section>

    <UiInlineMessage v-if="message" :tone="message.tone" class="docker-storage__message">
      {{ message.text }}
    </UiInlineMessage>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import type { SVGAttributes } from 'vue';

import type {
  DockerActionResult,
  DockerNetwork,
  DockerVolume,
} from '../../../../shared/plugins/docker/dockerContracts';

import { useDockerStore } from '../../stores/docker';
import { usePluginsStore } from '../../stores/plugins.js';
import { UiCheckbox, UiIconButton, UiInlineMessage, confirmDialog, vTooltip } from '../../ui';
import { formatSize } from './format';
import { dockerSettings } from './settings';

interface DockerFeedback {
  tone: 'success' | 'danger';
  text: string;
}

const ICON: SVGAttributes = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '1.8',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
};

const store = useDockerStore();
const plugins = usePluginsStore();
const onlyUnusedVolumes = ref(false);
const message = ref<DockerFeedback | null>(null);
let messageTimer: ReturnType<typeof setTimeout> | undefined;

const allowVolumeRemoval = computed(() => dockerSettings(plugins.byId('docker')).allowVolumeRemoval === true);
const unusedVolumes = computed(() => store.volumes.filter((volume) => !volume.inUse).length);
const visibleVolumes = computed(() => (onlyUnusedVolumes.value
  ? store.volumes.filter((volume) => !volume.inUse)
  : store.volumes));

/**
 * Заблокированное удаление объясняется рядом с действием, чтобы политика
 * плагина и занятость ресурса не выглядели как неисправная кнопка.
 */
function volumeRemovalTitle(volume: DockerVolume): string {
  if (!allowVolumeRemoval.value) {
    return 'Удаление томов выключено в настройках плагина';
  }
  if (volume.inUse) {
    return 'Том используется контейнером';
  }

  return 'Удалить том';
}

/**
 * Причина недоступности сети зависит от её типа и подключений.
 * Название действия остаётся доступным для свободных пользовательских сетей.
 */
function networkRemovalTitle(network: DockerNetwork): string {
  if (network.builtin) {
    return 'Встроенная сеть Docker';
  }
  if (network.containers > 0) {
    return 'К сети подключены контейнеры';
  }

  return 'Удалить сеть';
}

/**
 * Сообщение относится к последнему действию; старый таймер не должен скрыть
 * новый результат, если человек последовательно удаляет несколько ресурсов.
 */
function report(result: DockerActionResult, okText: string): void {
  message.value = result.ok
    ? { tone: 'success', text: okText }
    : { tone: 'danger', text: result.message || 'Демон отклонил удаление' };

  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    message.value = null;
  }, 8000);
}

/**
 * Том хранит данные контейнера, поэтому удаление требует явного подтверждения.
 * Политика плагина блокирует действие заранее и повторно проверяется сервером.
 */
async function removeVolume(volume: DockerVolume): Promise<void> {
  if (volume.inUse || !allowVolumeRemoval.value || store.isBusy(volume.name)) {
    return;
  }

  const size = volume.size === null ? '' : `\n\nРазмер тома: ${formatSize(volume.size)}.`;
  const accepted = await confirmDialog(
    `Удалить том «${volume.name}»? Данные внутри восстановить будет нельзя.${size}`,
    {
      title: 'Удаление тома',
      okText: 'Удалить том',
      danger: true,
    },
  );

  if (!accepted) {
    return;
  }

  report(await store.removeVolume(volume.name), 'Том удалён');
}

/**
 * Встроенные и используемые сети защищены от удаления. Для свободной сети
 * подтверждение называет её явно перед отправкой запроса.
 */
async function removeNetwork(network: DockerNetwork): Promise<void> {
  if (network.builtin || network.containers > 0 || store.isBusy(network.id)) {
    return;
  }

  const accepted = await confirmDialog(
    `Удалить сеть «${network.name}»?`,
    {
      title: 'Удаление сети',
      okText: 'Удалить',
      danger: true,
    },
  );

  if (!accepted) {
    return;
  }

  report(await store.removeNetwork(network.id), 'Сеть удалена');
}

onBeforeUnmount(() => {
  clearTimeout(messageTimer);
});
</script>

<style scoped>
.docker-storage {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 28px;
}

.docker-storage__block {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 14px;
}

.docker-storage__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px 16px;
}

.docker-storage__heading {
  flex: 1 1 260px;
}

.docker-storage__head h3 {
  display: flex;
  align-items: center;
  margin: 0;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
}

.docker-storage__head h3 span {
  padding: 2px 7px;
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 12px;
  font-weight: 500;
}

.docker-storage__head p,
.docker-storage__note {
  margin: 6px 0 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}

.docker-storage__note {
  margin: 0;
}

.docker-storage__empty {
  margin: 0;
  padding: 24px 16px;
  border: 1px dashed var(--line-2);
  border-radius: var(--radius);
  color: var(--ink-mid);
  font-size: 13px;
  text-align: center;
}

.docker-list {
  margin: 0;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  list-style: none;
  overflow: hidden;
}

.docker-item {
  display: flex;
  align-items: center;
  padding: 14px 16px;
  border-top: 1px solid var(--line);
  gap: 12px;
}

.docker-item:first-child {
  border-top: none;
}

.docker-item__main {
  min-width: 0;
  flex: 1;
}

.docker-item__main strong {
  display: block;
  overflow: hidden;
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.docker-item__meta {
  display: flex;
  flex-wrap: wrap;
  margin-top: 6px;
  gap: 4px 12px;
  color: var(--ink-mid);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.docker-item__meta .is-used {
  color: var(--accent);
}

.docker-item__used {
  margin: 5px 0 0;
  overflow: hidden;
  color: var(--ink-mid);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.docker-item__end {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 12px;
}

.docker-item__size {
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 12px;
  white-space: nowrap;
}

.docker-storage__message {
  margin: 0;
}

@container docker-panel (max-width: 560px) {
  .docker-storage__heading {
    flex-basis: 100%;
  }

  .docker-item {
    flex-wrap: wrap;
    padding: 12px;
  }

  .docker-item__main {
    flex-basis: 100%;
  }

  .docker-item__end {
    width: 100%;
    justify-content: flex-end;
  }

  .docker-item__size {
    margin-right: auto;
  }
}
</style>
