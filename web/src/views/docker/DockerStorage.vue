<template>
  <div class="docker-storage">
    <section class="docker-storage__block">
      <header class="docker-storage__head">
        <div class="docker-storage__heading">
          <h3>{{ t('core.dockerToma') }} <span>{{ store.volumes.length }}</span></h3>
          <p>{{ t('core.dockerPostoyannyeDannyeKonteynerovNeispolzuemyh') }} {{ unusedVolumes }}.</p>
        </div>
        <UiCheckbox v-model="onlyUnusedVolumes">{{ t('core.dockerTolkoNeispolzuemye') }}</UiCheckbox>
        <p v-if="!allowVolumeRemoval" class="docker-storage__note"> {{ t('core.dockerUdalenieTomovVyklyuchenoV2') }} </p>
      </header>

      <p v-if="!visibleVolumes.length" class="docker-storage__empty">
        {{ store.volumes.length ? t('core.dockerNeispolzuemyhTomovNet') : t('core.dockerTomovPokaNet') }}
      </p>
      <ul v-else class="docker-list" :aria-label="t('core.dockerTomaDocker')">
        <li v-for="volume in visibleVolumes" :key="volume.name" class="docker-item">
          <div class="docker-item__main">
            <strong v-tooltip="volume.name">{{ volume.name }}</strong>
            <div class="docker-item__meta">
              <span>{{ volume.compose ? t('core.dockerProektCompose', { compose: volume.compose }) : volume.driver }}</span>
              <span v-if="volume.anonymous">{{ t('core.dockerBezymyannyy') }}</span>
              <span :class="{ 'is-used': volume.inUse }">
                {{ volume.inUse ? t('core.dockerIspolzuetsya') : t('core.dockerNeIspolzuetsya') }}
              </span>
              <span v-if="volume.usedBy.length" class="docker-item__used"
                    v-tooltip="volume.usedBy.join(', ')"> {{ t('core.dockerKonteynery') }} {{ volume.usedBy.join(', ') }}
              </span>
            </div>
          </div>

          <div class="docker-item__end">
            <span v-if="volume.size !== null" class="docker-item__size">
              {{ formatSize(volume.size) }}
            </span>
            <UiIconButton
              role="embedded"
              data-context="workspace-toolbar"
              :label="t('core.dockerUdalitTomName', { name: volume.name })"
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
          <h3>{{ t('core.dockerSeti') }} <span>{{ store.networks.length }}</span></h3>
          <p>{{ t('core.dockerSoedineniyaMezhduKonteyneramiVstroennye') }}</p>
        </div>
      </header>

      <p v-if="!store.networks.length" class="docker-storage__empty">{{ t('core.dockerSeteyPokaNet') }}</p>
      <ul v-else class="docker-list" :aria-label="t('core.dockerSetiDocker')">
        <li v-for="network in store.networks" :key="network.id" class="docker-item">
          <div class="docker-item__main">
            <strong v-tooltip="network.name">{{ network.name }}</strong>
            <div class="docker-item__meta">
              <span>{{ network.driver }}</span>
              <span v-if="network.subnets.length">{{ network.subnets.join(', ') }}</span>
              <span v-if="network.builtin">{{ t('core.dockerVstroennaya') }}</span>
            </div>
          </div>

          <div class="docker-item__end">
            <span class="docker-item__size">{{ network.containers }} {{ t('core.dockerKont') }}</span>
            <UiIconButton
              role="embedded"
              data-context="workspace-toolbar"
              :label="t('core.dockerUdalitSetName', { name: network.name })"
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
import { usePluginsStore } from '../../stores/plugins.ts';
import { UiCheckbox, UiIconButton, UiInlineMessage, confirmDialog, vTooltip, t, messageRef } from '../../ui';
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
    return t('core.dockerUdalenieTomovVyklyuchenoV');
  }
  if (volume.inUse) {
    return t('core.dockerTomIspolzuetsyaKonteynerom');
  }

  return t('core.dockerUdalitTom');
}

/**
 * Причина недоступности сети зависит от её типа и подключений.
 * Название действия остаётся доступным для свободных пользовательских сетей.
 */
function networkRemovalTitle(network: DockerNetwork): string {
  if (network.builtin) {
    return t('core.dockerVstroennayaSetDocker');
  }
  if (network.containers > 0) {
    return t('core.dockerKSetiPodklyuchenyKonteynery');
  }

  return t('core.dockerUdalitSet');
}

/**
 * Сообщение относится к последнему действию; старый таймер не должен скрыть
 * новый результат, если человек последовательно удаляет несколько ресурсов.
 */
function report(result: DockerActionResult, okText: string): void {
  message.value = result.ok
    ? { tone: 'success', text: okText }
    : { tone: 'danger', text: result.message || t('core.dockerDemonOtklonilUdalenie') };

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

  const size = volume.size === null ? '' : t('core.dockerRazmerTomaSize', { size: formatSize(volume.size) });
  const accepted = await confirmDialog(
    messageRef('core.dockerUdalitTomNameDannye', { name: volume.name, size }),
    {
      title: t('core.dockerUdalenieToma'),
      okText: t('core.dockerUdalitTom'),
      danger: true,
    },
  );

  if (!accepted) {
    return;
  }

  report(await store.removeVolume(volume.name), t('core.dockerTomUdalen'));
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
    messageRef('core.dockerUdalitSetName2', { name: network.name }),
    {
      title: t('core.dockerUdalenieSeti'),
      okText: t('core.taskDelete'),
      danger: true,
    },
  );

  if (!accepted) {
    return;
  }

  report(await store.removeNetwork(network.id), t('core.dockerSetUdalena'));
}

onBeforeUnmount(() => {
  clearTimeout(messageTimer);
});
</script>

<style scoped>
.docker-storage {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  min-width: 0;
  gap: 24px;
}

.docker-storage__block {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 12px;
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
  font-size: 13px;
  font-weight: 600;
}

.docker-storage__head h3 span {
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
  flex-basis: 100%;
  margin: 0;
}

.docker-storage__empty {
  margin: 0;
  padding: 24px 16px;
  color: var(--ink-mid);
  font-size: 13px;
  text-align: center;
}

.docker-list {
  margin: 0;
  padding: 0;
  list-style: none;
  overflow: hidden;
}

.docker-item {
  display: flex;
  align-items: center;
  padding: 10px 0;
  border-top: 1px solid var(--line);
  gap: 12px;
}

.docker-item:first-child {
  border-top: 1px solid var(--line);
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
  margin-top: 4px;
  gap: 4px 12px;
  color: var(--ink-mid);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.docker-item__meta .is-used {
  color: var(--accent);
}

.docker-item__used {
  min-width: 0;
  max-width: 100%;
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
  grid-column: 1 / -1;
}

@container docker-panel (min-width: 1100px) {
  .docker-storage {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 24px;
  }

  .docker-storage__head {
    min-height: 80px;
    align-content: start;
  }
}

@container docker-panel (max-width: 560px) {
  .docker-storage__heading {
    flex-basis: 100%;
  }

  .docker-item {
    flex-wrap: wrap;
    padding: 10px 0;
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
