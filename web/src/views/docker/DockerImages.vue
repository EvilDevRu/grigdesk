<template>
  <div class="docker-images">
    <div class="docker-images__filters">
      <div class="docker-images__search">
        <UiSearchInput
          v-model="query"
          :placeholder="t('core.dockerNaytiPoImeniTegu')"
          :aria-label="t('core.dockerPoiskObraza')"
        />
      </div>
      <div class="docker-images__filter-options">
        <UiCheckbox v-model="onlyUnused">{{ t('core.dockerTolkoNeispolzuemye') }}</UiCheckbox>
        <span class="docker-images__caption">{{ t('core.dockerUnusedImagesCount', { count: unusedCount }) }}</span>
      </div>
    </div>

    <p v-if="!visible.length" class="docker-images__empty">
      {{ store.images.length ? t('core.dockerPoEtimUsloviyamObrazy') : t('core.dockerLokalnyhObrazovPokaNet') }}
    </p>

    <ul v-else class="docker-list" :aria-label="t('core.dockerLokalnyeObrazy')">
      <li v-for="image in visible" :key="image.id" class="docker-image">
        <div class="docker-image__main">
          <strong v-tooltip="formatTags(image)">{{ formatTags(image) }}</strong>
          <div class="docker-image__meta">
            <span class="docker-image__id">{{ image.shortId }}</span>
            <span>{{ t('core.dockerSozdan') }} {{ formatAge(image.createdAt) }} {{ t('core.dockerNazad') }}</span>
            <span v-if="image.inUse" class="docker-image__used" v-tooltip="image.usedBy.join(', ')"> {{ t('core.dockerKonteynery') }} {{ image.usedBy.join(', ') }}
            </span>
          </div>
        </div>

        <div class="docker-image__details">
          <span class="docker-image__size">{{ formatSize(image.size) }}</span>
          <span v-if="image.inUse" class="docker-image__tag is-used">{{ t('core.dockerIspolzuetsya') }}</span>
          <span v-else-if="image.dangling" class="docker-image__tag is-dangling">{{ t('core.dockerBezTega') }}</span>
          <span v-else class="docker-image__tag">{{ t('core.dockerNeIspolzuetsya') }}</span>
        </div>

        <UiIconButton
          role="embedded"
          data-context="workspace-toolbar"
          :label="t('core.dockerUdalitObrazFormattagsimage', { formatTagsimage: formatTags(image) })"
          v-tooltip="image.inUse ? t('core.dockerObrazIspolzuetsyaKonteynerom') : t('core.dockerUdalitObraz')"
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
import {
  UiCheckbox, UiIconButton, UiInlineMessage, UiSearchInput, confirmDialog, t, vTooltip,
  messageRef,
} from '../../ui';
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
    messageRef('core.dockerUdalitObrazFormattagsimageRazmer', {
      formatTagsimage: formatTags(image),
      size: formatSize(image.size),
    }),
    {
      title: t('core.dockerUdalenieObraza'),
      okText: t('core.taskDelete'),
      danger: true,
    },
  );

  if (!accepted) {
    return;
  }

  const result = await store.removeImage(image.id);

  message.value = result.ok
    ? { tone: 'success', text: t('core.dockerObrazUdalen') }
    : { tone: 'danger', text: result.message || t('core.dockerDemonOtklonilUdalenie') };

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
  gap: 12px;
}

.docker-images__filter-options {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 20px;
}

.docker-images__caption {
  color: var(--ink-mid);
  font-size: 12px;
}

.docker-images__filters {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 12px 24px;
}

.docker-images__search {
  min-width: 0;
  flex: 0 1 420px;
}

.docker-images__empty {
  margin: 0;
  padding: 28px 16px;
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

.docker-image {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 100px 140px auto;
  align-items: center;
  padding: 10px;
  border-top: 1px solid var(--line);
  gap: 12px;
}

.docker-image:first-child {
  border-top: 1px solid var(--line);
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
  margin-top: 4px;
  gap: 4px 12px;
  color: var(--ink-mid);
  font-size: 12px;
}

.docker-image__id {
  font-family: var(--mono);
}

.docker-image__used {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  color: var(--ink-mid);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.docker-image__details {
  display: contents;
}

.docker-image__size {
  font-family: var(--mono);
  font-size: 13px;
  text-align: right;
  white-space: nowrap;
}

.docker-image__tag {
  color: var(--ink-mid);
  font-size: 12px;
  text-align: right;
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

@container docker-panel (max-width: 760px) {
  .docker-images__search {
    flex-basis: 100%;
  }

  .docker-images__filter-options {
    width: 100%;
    justify-content: space-between;
  }
}

@container docker-panel (max-width: 600px) {
  .docker-image {
    grid-template-columns: minmax(0, 1fr) auto;
    padding: 10px 0;
    gap: 10px;
  }

  .docker-image__main {
    grid-column: 1 / -1;
  }

  .docker-image__details {
    display: flex;
    align-items: center;
    flex-direction: row;
    flex-wrap: wrap;
    gap: 8px 12px;
  }
}
</style>
