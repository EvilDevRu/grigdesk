<template>
  <div class="docker-cleanup">
    <header class="docker-cleanup__head">
      <div>
        <h3>Место и очистка</h3>
        <p>Выберите ресурсы, которые больше не нужны.</p>
        <small v-if="store.usage">
          Рассчитано {{ formatAge(store.usage.computedAt) }} назад
          <template v-if="store.usage.cached"> · из кэша</template>
          <template v-if="store.usage.source === 'computed'"> · приблизительная оценка</template>
        </small>
      </div>
      <UiButton
        :loading="store.usageLoading"
        :disabled="cleaning"
        @click="store.loadUsage({ force: true })"
      >
        Пересчитать
      </UiButton>
    </header>

    <UiInlineMessage v-if="store.usageError" tone="danger" class="docker-cleanup__message">
      {{ store.usageError }}
    </UiInlineMessage>

    <DockerLoading v-else-if="!store.usage && store.usageLoading"
      label="Демон считает размеры слоёв, это занимает несколько секунд…"  area="usage" />
    <p v-else-if="!store.usage" class="docker-cleanup__empty">
      Нажмите «Пересчитать», чтобы узнать занятое место.
    </p>

    <table v-else class="docker-usage" aria-label="Выбор ресурсов для очистки">
      <thead>
        <tr>
          <th class="docker-usage__pick" aria-label="Выбор"></th>
          <th scope="col">Ресурсы</th>
          <th scope="col" class="docker-usage__num">Занято</th>
          <th scope="col" class="docker-usage__num">Можно освободить</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.key"
          :class="{ 'is-disabled': row.disabled, 'is-selected': picked[row.key] && !row.disabled }"
        >
          <td class="docker-usage__pick">
            <UiCheckbox
              v-model="picked[row.key]"
              :disabled="row.disabled || cleaning"
              :aria-label="`Чистить: ${row.label}`"
            />
          </td>
          <td class="docker-usage__description">
            <strong>{{ row.label }}</strong>
            <small>{{ row.hint }}</small>
          </td>
          <td class="docker-usage__num">
            <span class="docker-usage__mobile-label" aria-hidden="true">Занято</span>
            {{ formatSize(row.size) }}
          </td>
          <td class="docker-usage__num" :class="{ 'is-gain': row.reclaimable > 0 && !row.disabled }">
            <span class="docker-usage__mobile-label" aria-hidden="true">Можно освободить</span>
            {{ formatSize(row.reclaimable) }}
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="store.usage" class="docker-cleanup__foot">
      <UiCheckbox v-if="allowImagePruneAll" v-model="allImages" :disabled="cleaning">
        Удалять все неиспользуемые образы, а не только без тегов
      </UiCheckbox>
      <p v-else class="docker-cleanup__note">
        Образы чистятся только без тегов. Снос всех неиспользуемых включается
        в «Настройки → Плагины → Докер».
      </p>

      <div class="docker-cleanup__actions">
        <div class="docker-cleanup__summary">
          <span class="docker-cleanup__selection">Выбрано категорий: {{ selectedTargets.length }}</span>
          <span class="docker-cleanup__total">Вернётся примерно {{ formatSize(selectedGain) }}</span>
        </div>
        <UiButton
          variant="solid"
          tone="danger"
          :disabled="!selectedTargets.length || cleaning || store.usageLoading"
          :loading="cleaning"
          @click="clean"
        >
          Очистить выбранное
        </UiButton>
      </div>
    </div>

    <UiInlineMessage v-if="result" :tone="result.tone" class="docker-cleanup__message">
      {{ result.text }}
    </UiInlineMessage>
  </div>
</template>

<script setup lang="ts">
import DockerLoading from './DockerLoading.vue';

import { computed, reactive, ref } from 'vue';

import type { DockerPruneTarget } from '../../../../shared/plugins/docker/dockerContracts';

import { useDockerStore } from '../../stores/docker';
import { usePluginsStore } from '../../stores/plugins.ts';
import {
  UiButton,
  UiCheckbox,
  UiInlineMessage,
  confirmDialog,
} from '../../ui';
import { formatAge, formatSize } from './format';
import { dockerSettings } from './settings';

interface DockerFeedback {
  tone: 'success' | 'danger' | 'warning';
  text: string;
}

interface CleanupRow {
  key: DockerPruneTarget;
  label: string;
  hint: string;
  size: number;
  reclaimable: number;
  disabled: boolean;
}

const store = useDockerStore();
const plugins = usePluginsStore();

const picked = reactive<Record<DockerPruneTarget, boolean>>({
  containers: false,
  images: false,
  volumes: false,
  networks: false,
  buildCache: false,
});
const allImages = ref(false);
const cleaning = ref(false);
const result = ref<DockerFeedback | null>(null);

const settings = computed(() => dockerSettings(plugins.byId('docker')));
const allowVolumeRemoval = computed(() => settings.value.allowVolumeRemoval === true);
const allowImagePruneAll = computed(() => settings.value.allowImagePruneAll === true);
const effectiveAllImages = computed(() => allowImagePruneAll.value && allImages.value);

// Строки описывают решения человека: что исчезнет и сколько это вернёт.
// Политика плагина исключает запрещённые действия, а размеры берутся у демона.
const rows = computed<CleanupRow[]>(() => {
  const usage = store.usage;

  if (!usage) {
    return [];
  }

  return [
    {
      key: 'containers',
      label: 'Остановленные контейнеры',
      hint: `${usage.containers.stopped} из ${usage.containers.total}`,
      size: usage.containers.size,
      reclaimable: usage.containers.reclaimable,
      disabled: usage.containers.stopped === 0,
    },
    {
      key: 'images',
      label: 'Образы',
      hint: effectiveAllImages.value
        ? `${usage.images.unused} неиспользуемых`
        : `${usage.images.dangling.count} без тегов из ${usage.images.total}`,
      size: usage.images.size,
      reclaimable: effectiveAllImages.value ? usage.images.reclaimable : usage.images.dangling.size,
      disabled: effectiveAllImages.value ? usage.images.unused === 0 : usage.images.dangling.count === 0,
    },
    {
      key: 'volumes',
      label: 'Неиспользуемые тома',
      hint: allowVolumeRemoval.value
        ? `${usage.volumes.unused} из ${usage.volumes.total} — в них лежат данные стендов`
        : 'удаление томов выключено в настройках плагина',
      size: usage.volumes.size,
      reclaimable: usage.volumes.reclaimable,
      disabled: !allowVolumeRemoval.value || usage.volumes.unused === 0,
    },
    {
      key: 'networks',
      label: 'Пустые сети',
      hint: `${usage.networks.unused} без контейнеров`,
      size: 0,
      reclaimable: 0,
      disabled: usage.networks.unused === 0,
    },
    {
      key: 'buildCache',
      label: 'Кэш сборки',
      hint: `${usage.buildCache.total} записей — пересборка образов станет дольше`,
      size: usage.buildCache.size,
      reclaimable: usage.buildCache.reclaimable,
      disabled: usage.buildCache.reclaimable === 0,
    },
  ];
});

const selectedTargets = computed(() => rows.value
  .filter((row) => picked[row.key] && !row.disabled)
  .map((row) => row.key));

const selectedGain = computed(() => rows.value
  .filter((row) => selectedTargets.value.includes(row.key))
  .reduce((sum, row) => sum + row.reclaimable, 0));

/**
 * Подтверждение перечисляет выбранные ресурсы. Снимок выбора используется
 * до конца операции: обновлённая сводка не должна менять уже принятое решение.
 */
async function clean(): Promise<void> {
  if (cleaning.value || store.usageLoading || !selectedTargets.value.length) {
    return;
  }

  const targets = [...selectedTargets.value];
  const pruneAllImages = effectiveAllImages.value;
  const chosen = rows.value.filter((row) => targets.includes(row.key));
  const lines = chosen.map((row) => `• ${row.label} (${row.hint})`).join('\n');
  const accepted = await confirmDialog(
    `Будет удалено:\n\n${lines}\n\nВернётся примерно ${formatSize(selectedGain.value)}.`,
    {
      title: 'Очистка Docker',
      okText: 'Очистить',
      danger: true,
    },
  );

  if (!accepted) {
    return;
  }

  cleaning.value = true;
  result.value = null;

  try {
    const outcome = await store.prune({ targets, allImages: pruneAllImages });

    if (!outcome.ok) {
      result.value = { tone: 'danger', text: outcome.message || 'Уборка не выполнена' };

      return;
    }

    const freed = Object.values(outcome.report).reduce((sum, item) => sum + (item.freed || 0), 0);
    const removed = Object.values(outcome.report).reduce((sum, item) => sum + (item.removed || 0), 0);
    const failures = Object.entries(outcome.report)
      .flatMap(([key, item]) => 'error' in item && item.error ? [`${key}: ${item.error}`] : []);

    result.value = {
      tone: failures.length ? 'warning' : 'success',
      text: `Удалено объектов: ${removed}, освобождено ${formatSize(freed)}.`
        + (failures.length ? ` Не вышло — ${failures.join('; ')}` : ''),
    };

    for (const key of targets) {
      picked[key] = false;
    }
  } finally {
    cleaning.value = false;
  }
}
</script>

<style scoped>
.docker-cleanup {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 16px;
}

.docker-cleanup__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px 16px;
}

.docker-cleanup__head div {
  flex: 1 1 230px;
}

.docker-cleanup__head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.docker-cleanup__head p {
  margin: 6px 0 0;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.5;
}

.docker-cleanup__head small {
  display: block;
  margin-top: 6px;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}

.docker-cleanup__empty {
  margin: 0;
  padding: 24px 16px;
  border: 1px dashed var(--line-2);
  border-radius: var(--radius);
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.5;
  text-align: center;
}

.docker-usage {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  border-spacing: 0;
  background: var(--surface);
  overflow: hidden;
}

.docker-usage th {
  padding: 12px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 12px;
  font-weight: 500;
  text-align: left;
}

.docker-usage td {
  padding: 14px 12px;
  border-top: 1px solid var(--line);
  vertical-align: middle;
}

.docker-usage__description strong {
  display: block;
  font-size: 13px;
  font-weight: 600;
}

.docker-usage__description small {
  display: block;
  margin-top: 5px;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}

.docker-usage__pick {
  width: 38px;
}

.docker-usage .docker-usage__num {
  font-family: var(--mono);
  font-size: 12px;
  text-align: right;
  white-space: nowrap;
}

.docker-usage th.docker-usage__num {
  font-family: var(--sans);
}

.docker-usage__num.is-gain {
  color: var(--good);
}

.docker-usage tr.is-disabled {
  color: var(--ink-mid);
}

.docker-usage tr.is-selected {
  background: color-mix(in srgb, var(--accent) 5%, var(--surface));
}

.docker-usage__mobile-label {
  display: none;
}

.docker-cleanup__foot {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.docker-cleanup__note {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}

.docker-cleanup__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  gap: 16px;
}

.docker-cleanup__summary {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.docker-cleanup__selection {
  color: var(--ink-mid);
  font-size: 12px;
}

.docker-cleanup__total {
  font-size: 14px;
  font-weight: 600;
}

.docker-cleanup__message {
  margin: 0;
}

@container docker-panel (max-width: 680px) {
  .docker-usage,
  .docker-usage tbody {
    display: block;
  }

  .docker-usage thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }

  .docker-usage tbody tr {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr) minmax(0, 1fr);
    padding: 14px 12px;
    border-top: 1px solid var(--line);
    gap: 12px;
  }

  .docker-usage tbody tr:first-child {
    border-top: none;
  }

  .docker-usage td {
    padding: 0;
    border: none;
  }

  .docker-usage__pick {
    width: auto;
    grid-column: 1;
    grid-row: 1 / 3;
  }

  .docker-usage__description {
    grid-column: 2 / -1;
  }

  .docker-usage .docker-usage__num {
    text-align: left;
  }

  .docker-usage__mobile-label {
    display: block;
    margin-bottom: 4px;
    color: var(--ink-mid);
    font-family: var(--sans);
    font-size: 12px;
    white-space: normal;
  }
}
</style>
