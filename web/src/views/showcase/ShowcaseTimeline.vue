<template>
  <ol class="timeline" data-testid="showcase-timeline" :aria-label="t('core.showcaseTaymlaynScen')">
    <li v-for="(scene, index) in scenes" :key="scene.id" class="timeline__item">
      <UiSelectableRow
        :selected="scene.id === selectedId"
        :pressed="scene.id === selectedId"
        @select="emit('select', scene.id)"
      >
        <span class="timeline__card" :data-testid="`showcase-timeline-${scene.id}`">
          <img
            v-if="scene.frame"
            class="timeline__frame"
            :src="frameUrl(scene.frame.id)"
            :alt="t('core.showcaseKadrSceny', { title: scene.title })"
            loading="lazy"
          />
          <span v-else class="timeline__frame timeline__frame--empty" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="m10 9 5 3-5 3z" />
            </svg>
          </span>
          <span class="timeline__title-line">
            <span class="timeline__order">{{ scene.order }}</span>
            <span class="timeline__title">{{ scene.title }}</span>
          </span>
          <span class="timeline__meta">
            {{ sceneStateOf(scene).label }}
            <template v-if="timecodeOf(scene.id)"> · {{ timecodeOf(scene.id) }}</template>
            <span v-if="changedIds.includes(scene.id)" class="timeline__changed">
            · {{ t('core.showcaseNeSohraneno') }}
            </span>
          </span>
          <span v-if="speechWarning(scene)" class="timeline__check">
            {{ t('core.showcaseOzvuchka') }}: {{ speechWarning(scene) }}
          </span>
          <span v-if="index > 0 && scene.continuesPrevious" class="timeline__continues">
            {{ continuationLabel() }}
          </span>
        </span>
      </UiSelectableRow>
      <UiButton
        variant="ghost"
        :disabled="busy"
        :data-testid="`showcase-reshoot-${scene.id}`"
        @click="emit('reshoot', scene.id)"
      > {{ t('core.showcasePeresnyatScenu') }} </UiButton>
    </li>
  </ol>
</template>

<script setup lang="ts">
// Таймлайн редактора: сцены слева направо с превью-кадрами. Выбор открывает
// свойства сцены; пересъёмка уходит на сервер отдельным действием и старит
// цепочку продолжений целиком.
import type { ShowcaseScene } from '../../../../shared/plugins/showcase/showcaseContracts.ts';
import { UiButton, UiSelectableRow, t } from '../../ui';
import { continuationLabel, sceneStateOf, timecode } from './sceneText';

const props = defineProps<{
  scenes: ShowcaseScene[];
  selectedId: string | null;
  changedIds: string[];
  busy: boolean;
  frameUrl: (artifactId: string) => string;
  startsMs: Map<string, number> | null;
}>();

const emit = defineEmits<{
  select: [sceneId: string];
  reshoot: [sceneId: string];
}>();

// Таймкод сцены: Map.get возвращает number|undefined, а timecode принимает number —
// локальная переменная с проверкой, как в удаляемом Storyboard (находки B20/R4-B2).
function timecodeOf(sceneId: string): string {
  const start = props.startsMs?.get(sceneId);

  return start != null ? timecode(start) : '';
}

// Спорное место самопроверки речи видно в списке (сохраняемое поведение D8):
// берётся ПЕРВАЯ speech-проверка со статусом warning или blocked — порядок как
// в удаляемом Storyboard (находки R3-R3-A1/A16).
function speechWarning(scene: ShowcaseScene): string {
  const check = scene.checks.find((entry) => (
    entry.kind === 'speech' && (entry.status === 'warning' || entry.status === 'blocked')
  ));

  return check?.reason ?? '';
}
</script>

<style scoped>
.timeline {
  display: flex;
  gap: 10px;
  overflow-x: auto;
  padding: 2px 0 8px;
  list-style: none;
  margin: 0;
  min-width: 0;
  overscroll-behavior-inline: contain;
}

.timeline__item {
  display: flex;
  flex: 0 0 172px;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.timeline__card {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}

.timeline__frame {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border-radius: 3px;
  background: var(--ground);
}

.timeline__frame--empty {
  display: grid;
  place-items: center;
  color: var(--ink-low);
}

.timeline__frame svg {
  width: 26px;
  height: 26px;
}

.timeline__title-line {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
}

.timeline__order {
  color: var(--ink-mid);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.timeline__title {
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.timeline__meta,
.timeline__continues {
  color: var(--ink-mid);
  font-size: 11px;
  line-height: 1.5;
}

.timeline__changed,
.timeline__check {
  color: var(--warn);
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.timeline__continues {
  color: var(--accent);
}
</style>
