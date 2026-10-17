<template>
  <div class="docker-images">
    <header class="docker-images__head">
      <div>
        <h3>Локальные образы <span>{{ store.images.length }}</span></h3>
        <p>Образы для запуска контейнеров. Неиспользуемых: {{ unusedCount }}.</p>
      </div>
    </header>

    <div class="docker-images__filters">
      <div class="docker-images__search">
        <UiSearchInput
          v-model="query"
          placeholder="Найти по имени, тегу или ID"
          aria-label="Поиск образа"
        />
      </div>
      <UiCheckbox v-model="onlyUnused">Только неиспользуемые</UiCheckbox>
    </div>

    <p v-if="!visible.length" class="docker-images__empty">
      {{ store.images.length ? 'По этим условиям образы не найдены.' : 'Локальных образов пока нет.' }}
    </p>

    <ul v-else class="docker-list" aria-label="Локальные образы">
      <li v-for="image in visible" :key="image.id" class="docker-image">
        <div class="docker-image__main">
          <strong v-tooltip="formatTags(image)">{{ formatTags(image) }}</strong>
          <div class="docker-image__meta">
            <span class="docker-image__id">{{ image.shortId }}</span>
            <span>создан {{ formatAge(image.createdAt) }} назад</span>
          </div>
          <p v-if="image.inUse" class="docker-image__used" v-tooltip="image.usedBy.join(', ')">
            Контейнеры: {{ image.usedBy.join(', ') }}
          </p>
        </div>

        <div class="docker-image__details">
          <span class="docker-image__size">{{ formatSize(image.size) }}</span>
          <span v-if="image.inUse" class="docker-image__tag is-used">используется</span>
          <span v-else-if="image.dangling" class="docker-image__tag is-dangling">без тега</span>
          <span v-else class="docker-image__tag">не используется</span>
        </div>

        <UiIconButton
          role="embedded"
          :label="`Удалить образ ${formatTags(image)}`"
          v-tooltip="image.inUse ? 'Образ используется контейнером' : 'Удалить образ'"
          tone="danger"
          :disabled="image.inUse"
          :loading="store.isBusy(image.id)"
          @click="removeOne(image)"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M5 7h14 M9 7V5h6v2 M7 7l1 13h8l1-13 M10 11v6 M14 11v6" />
          </svg>
        </UiIconButton>
      </li>
    </ul>

    <UiInlineMessage v-if="message" :tone="message.tone" class="docker-images__message">
      {{ message.text }}
    </UiInlineMessage>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';

import type { DockerImage } from '../../../../shared/plugins/docker/dockerContracts';

import { useDockerStore } from '../../stores/docker';
import { UiCheckbox, UiIconButton, UiInlineMessage, UiSearchInput, confirmDialog, vTooltip } from '../../ui';
import { formatAge, formatSize, formatTags } from './format';

interface DockerFeedback {
  tone: 'success' | 'danger';
  text: string;
}

const store = useDockerStore();
const query = ref('');
const onlyUnused = ref(false);
const message = ref<DockerFeedback | null>(null);
let messageTimer: ReturnType<typeof setTimeout> | undefined;

const unusedCount = computed(() => store.images.filter((image) => !image.inUse).length);
const visible = computed(() => {
  const needle = query.value.trim().toLowerCase();

  return store.images.filter((image) => {
    if (onlyUnused.value && image.inUse) {
      return false;
    }

    return [...image.tags, image.shortId].join(' ').toLowerCase().includes(needle);
  });
});

/**
 * Размер образа включает общие слои, поэтому диалог не обещает освободить его
 * целиком. Образ с контейнерами сохраняет блокировку и на уровне интерфейса.
 */
async function removeOne(image: DockerImage): Promise<void> {
  if (image.inUse || store.isBusy(image.id)) {
    return;
  }

  const accepted = await confirmDialog(
    `Удалить образ «${formatTags(image)}»?\n\nРазмер образа: ${formatSize(image.size)}.`
      + '\nСлои, используемые другими образами, сохранятся.',
    {
      title: 'Удаление образа',
      okText: 'Удалить',
      danger: true,
    },
  );

  if (!accepted) {
    return;
  }

  const result = await store.removeImage(image.id);

  message.value = result.ok
    ? { tone: 'success', text: 'Образ удалён' }
    : { tone: 'danger', text: result.message || 'Демон отклонил удаление' };

  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    message.value = null;
  }, 6000);
}

onBeforeUnmount(() => {
  clearTimeout(messageTimer);
});
</script>

<style scoped>
.docker-images {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 16px;
}

.docker-images__head h3 {
  display: flex;
  align-items: center;
  margin: 0;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
}

.docker-images__head h3 span {
  padding: 2px 7px;
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 12px;
  font-weight: 500;
}

.docker-images__head p {
  margin: 6px 0 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}

.docker-images__filters {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px 16px;
}

.docker-images__search {
  flex: 1 1 230px;
}

.docker-images__empty {
  margin: 0;
  padding: 28px 16px;
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

.docker-image {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  padding: 14px 16px;
  border-top: 1px solid var(--line);
  gap: 12px;
}

.docker-image:first-child {
  border-top: none;
}

.docker-image__main {
  min-width: 0;
}

.docker-image__main strong {
  display: block;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.docker-image__meta {
  display: flex;
  flex-wrap: wrap;
  margin-top: 6px;
  gap: 4px 12px;
  color: var(--ink-mid);
  font-size: 12px;
}

.docker-image__id {
  font-family: var(--mono);
}

.docker-image__used {
  margin: 5px 0 0;
  overflow: hidden;
  color: var(--ink-mid);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.docker-image__details {
  display: flex;
  align-items: flex-end;
  flex-direction: column;
  gap: 6px;
}

.docker-image__size {
  font-family: var(--mono);
  font-size: 13px;
  white-space: nowrap;
}

.docker-image__tag {
  color: var(--ink-mid);
  font-size: 12px;
  white-space: nowrap;
}

.docker-image__tag.is-used {
  color: var(--accent);
}

.docker-image__tag.is-dangling {
  color: var(--warn);
}

.docker-images__message {
  margin: 0;
}

@container docker-panel (max-width: 560px) {
  .docker-images__search {
    flex-basis: 100%;
  }

  .docker-image {
    grid-template-columns: minmax(0, 1fr) auto;
    padding: 12px;
    gap: 10px;
  }

  .docker-image__main {
    grid-column: 1 / -1;
  }

  .docker-image__details {
    align-items: center;
    flex-direction: row;
    flex-wrap: wrap;
    gap: 8px 12px;
  }
}
</style>
