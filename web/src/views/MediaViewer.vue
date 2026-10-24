<template>
  <UiDialog
    :open="Boolean(media)"
    layer="document"
    size="media"
    :label="media?.name || ''"
    :body-inset="false"
    fade-only
    data-role="media-viewer"
    @update:open="onOpenChange"
  >
    <div v-if="media" class="media-viewer" @keydown="onKeydown">
      <header class="media-viewer__bar">
        <div class="media-viewer__titles">
          <span class="media-viewer__name">{{ media.name }}</span>
          <span v-if="meta" class="media-viewer__meta">{{ meta }}</span>
        </div>
        <div class="media-viewer__actions">
          <UiIconButton
            v-if="preview.image"
            :label="actualSize ? t('core.mediaFitToScreen') : t('core.mediaActualSize')"
            v-tooltip="actualSize ? t('core.mediaFitToScreen') : t('core.mediaActualSize')"
            :pressed="actualSize"
            @click="actualSize = !actualSize"
          ><span class="media-viewer__scale" aria-hidden="true">1:1</span></UiIconButton>
          <UiActionLink
            :href="media.src"
            :download="media.name"
            variant="ghost"
            :aria-label="t('core.mediaDownload')"
            v-tooltip="t('core.mediaDownload')"
          >
            <svg class="media-viewer__icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" />
            </svg>
          </UiActionLink>
          <UiActionLink
            :href="media.src"
            target="_blank"
            variant="ghost"
            :aria-label="t('core.mediaOpenSeparately')"
            v-tooltip="t('core.mediaOpenSeparately')"
          >
            <svg class="media-viewer__icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
            </svg>
          </UiActionLink>
          <UiIconButton :label="t('core.close')" v-tooltip="t('core.close')" @click="preview.close()">
            <svg class="media-viewer__icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="m6 6 12 12M6 18 18 6" />
            </svg>
          </UiIconButton>
        </div>
      </header>

      <!-- Пустое место вокруг картинки пропускает клик к затемнению: его закрывает UiDialog. -->
      <div class="media-viewer__stage" :data-actual="actualSize ? 'true' : 'false'">
        <img
          v-if="preview.image"
          :key="preview.image.src"
          :src="preview.image.src"
          :alt="preview.image.name"
          @load="onImageLoad"
        />
        <UiVideo
          v-else-if="preview.video"
          :key="preview.video.src"
          class="media-viewer__video"
          :src="preview.video.src"
          :label="preview.video.name"
          autoplay
        />
      </div>

      <div v-if="hasPrevious" class="media-viewer__nav" data-side="previous">
        <UiIconButton
          variant="outline"
          :label="t('core.mediaPrevious')"
          v-tooltip="t('core.mediaPrevious')"
          @click="preview.stepImage(-1)"
        >
          <svg class="media-viewer__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 6-6 6 6 6" /></svg>
        </UiIconButton>
      </div>
      <div v-if="hasNext" class="media-viewer__nav" data-side="next">
        <UiIconButton
          variant="outline"
          :label="t('core.mediaNext')"
          v-tooltip="t('core.mediaNext')"
          @click="preview.stepImage(1)"
        >
          <svg class="media-viewer__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 6 6 6-6 6" /></svg>
        </UiIconButton>
      </div>
      <span v-if="counter" class="media-viewer__count">{{ counter }}</span>
    </div>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { UiActionLink, UiDialog, UiIconButton, UiVideo, t, vTooltip } from '../ui.ts';
import { useDocumentPreviewStore } from '../stores/documentPreview.ts';

const preview = useDocumentPreviewStore();
const actualSize = ref(false);
const natural = ref<{ width: number; height: number } | null>(null);

const media = computed(() => preview.image || preview.video);
const hasPrevious = computed(() => preview.galleryIndex > 0);
const hasNext = computed(() => preview.galleryIndex >= 0
  && preview.galleryIndex < preview.gallery.length - 1);
const counter = computed(() => preview.galleryIndex >= 0
  ? t('core.mediaCounter', { current: preview.galleryIndex + 1, total: preview.gallery.length }) : '');
const meta = computed(() => {
  const size = natural.value ? `${natural.value.width} × ${natural.value.height}` : '';

  return [size, formatOf(media.value?.mime || '', media.value?.name || '')].filter(Boolean).join(' · ');
});

/**
 * Формат берётся из MIME, а без него — из расширения имени файла.
 * Неизвестный формат не показывается: строка размеров остаётся без лишней метки.
 */
function formatOf(mime: string, name: string): string {
  const fromMime = mime.split('/')[1]?.split(/[;+]/u)[0] || '';
  const fromName = /\.([a-z0-9]{2,5})$/iu.exec(name)?.[1] || '';

  return (fromMime || fromName).toUpperCase();
}

function onImageLoad(event: Event): void {
  const image = event.target as HTMLImageElement;

  natural.value = { width: image.naturalWidth, height: image.naturalHeight };
}

function onOpenChange(open: boolean): void {
  if (!open) {
    preview.close();
  }
}

/**
 * Стрелки клавиатуры листают картинки ленты, как кнопки по краям.
 * Видео стрелки не перехватывает: ими управляет его собственная шкала.
 */
function onKeydown(event: KeyboardEvent): void {
  if (!preview.image || !['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    return;
  }

  event.preventDefault();
  preview.stepImage(event.key === 'ArrowLeft' ? -1 : 1);
}

// Новая картинка открывается вписанной в экран; её размеры читаются заново после загрузки.
watch(() => media.value?.src, () => {
  actualSize.value = false;
  natural.value = null;
});
</script>

<style scoped>
.media-viewer {
  position: relative;
  flex: 1;
  width: 100%;
  min-width: 0;
  min-height: 0;
  color: var(--ink);
}

.media-viewer__bar,
.media-viewer__stage img,
.media-viewer__video,
.media-viewer__nav,
.media-viewer__count {
  pointer-events: auto;
}

.media-viewer__stage[data-actual='true'] {
  pointer-events: auto;
}

.media-viewer__bar {
  position: absolute;
  inset: 0 0 auto;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 14px;
  height: 64px;
  padding: 0 16px 0 20px;
}

.media-viewer__titles {
  display: grid;
  min-width: 0;
}

.media-viewer__name {
  overflow: hidden;
  font-size: 14px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.media-viewer__meta {
  color: var(--ink-mid);
  font-size: 12px;
}

.media-viewer__actions {
  display: flex;
  flex: none;
  gap: 6px;
  margin-left: auto;
}

.media-viewer__icon {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.media-viewer__scale {
  font-size: 12px;
  font-weight: 600;
}

/* Дорожки сетки заданы явно: без них max-height картинки считается от авто-строки и
   высокая картинка вылезает за сцену на счётчик. */
.media-viewer__stage {
  position: absolute;
  inset: 64px 76px 56px;
  display: grid;
  grid-template: minmax(0, 1fr) / minmax(0, 1fr);
  place-items: center;
  min-height: 0;
}

.media-viewer__stage img,
.media-viewer__video {
  display: block;
  max-width: 100%;
  max-height: 100%;
  border-radius: 6px;
  box-shadow: 0 30px 90px rgb(0 0 0 / 80%);
}

.media-viewer__stage img {
  object-fit: contain;
}

.media-viewer__stage[data-actual='true'] {
  inset: 64px 0 0;
  place-items: start center;
  overflow: auto;
  overscroll-behavior: contain;
}

.media-viewer__stage[data-actual='true'] img {
  max-width: none;
  max-height: none;
  border-radius: 0;
}

.media-viewer__nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
}

.media-viewer__nav[data-side='previous'] {
  left: 20px;
}

.media-viewer__nav[data-side='next'] {
  right: 20px;
}

.media-viewer__count {
  position: absolute;
  bottom: 16px;
  left: 50%;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgb(255 255 255 / 6%);
  color: var(--ink-mid);
  font-size: 12px;
  transform: translateX(-50%);
}

@media (max-width: 600px) {
  .media-viewer__bar {
    height: 56px;
    padding-top: env(safe-area-inset-top);
    padding-left: 16px;
    padding-right: 8px;
  }

  .media-viewer__stage {
    inset: 56px 0 72px;
  }

  .media-viewer__stage img,
  .media-viewer__video {
    border-radius: 0;
  }

  .media-viewer__nav {
    top: auto;
    bottom: max(14px, env(safe-area-inset-bottom));
    transform: none;
  }

  .media-viewer__nav[data-side='previous'] {
    left: 16px;
  }

  .media-viewer__nav[data-side='next'] {
    right: 16px;
  }

  .media-viewer__count {
    bottom: max(22px, calc(env(safe-area-inset-bottom) + 8px));
  }
}
</style>
