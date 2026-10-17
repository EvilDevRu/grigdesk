<template>
  <ol class="board" aria-label="Сцены ролика">
    <li v-for="(scene, index) in scenes" :key="scene.id">
      <UiSelectableRow
        class="board__row"
        :selected="scene.id === selectedId"
        :data-stale="scene.stale ? 'yes' : 'no'"
        @select="emit('select', scene.id)"
      >
        <span class="board__body">
          <span class="board__order">{{ index + 1 }}</span>
          <span class="board__copy">
            <span class="board__line">
              <strong class="board__title">{{ scene.title || `Сцена ${index + 1}` }}</strong>
              <span class="board__chip" :data-tone="stateOf(scene).tone">{{ stateOf(scene).label }}</span>
              <span v-if="changedIds.includes(scene.id)" class="board__chip" data-tone="accent">
                не сохранено
              </span>
              <span v-if="timeOf(scene)" class="board__time">{{ timeOf(scene) }}</span>
            </span>
            <!-- Что запись покажет на экране: без этой строки человек читал бы только
                 текст диктора и не видел, что все сцены снимают один неподвижный экран. -->
            <span class="board__plan" :data-static="actionsOf(scene) ? 'no' : 'yes'">
              <span v-if="continuesOf(scene)" class="board__chain">{{ CONTINUATION_LABEL }}</span>
              <span class="board__screen">{{ screenTitleOf(scene) }}</span>
              <span>{{ actionsOf(scene) || 'без действий — неподвижный экран' }}</span>
            </span>
            <span class="board__text">{{ excerptOf(scene) }}</span>
            <span v-if="warningOf(scene)" class="board__warn">{{ warningOf(scene) }}</span>
          </span>
        </span>
      </UiSelectableRow>
    </li>
  </ol>
</template>

<script setup lang="ts">
import { UiSelectableRow } from '../../ui';
import { continuesPrevious } from '../../../../shared/plugins/showcase/showcaseChains';
import type { ShowcaseScene, ShowcaseScreen } from '../../../../shared/plugins/showcase/showcaseContracts';
import { plainNarration } from '../../../../shared/plugins/showcase/showcaseNarration';
import { actionsText, CONTINUATION_LABEL, sceneStateOf, screenLabelOf, timecode } from './sceneText';

const props = defineProps<{
  // Сцены уже в порядке показа: порядок решает родитель, а не список.
  scenes: ShowcaseScene[];
  screens: ShowcaseScreen[];
  selectedId: string;
  // Сцены с несохранёнными правками: их видно в списке, чтобы правка не потерялась
  // при переходе к другой сцене.
  changedIds: string[];
  // Начало каждой сцены в собранном ролике; null — ролик из этих сцен не собран.
  startsMs: Map<string, number> | null;
}>();

const emit = defineEmits<{
  select: [sceneId: string];
}>();

const EXCERPT_LENGTH = 140;

function screenTitleOf(scene: ShowcaseScene): string {
  return screenLabelOf(props.screens, scene);
}

function actionsOf(scene: ShowcaseScene): string {
  return actionsText(scene);
}

function stateOf(scene: ShowcaseScene) {
  return sceneStateOf(scene);
}

// Продолжение считается по цепочке, а не по одному флагу: первой сцене ролика
// продолжать нечего, и её флаг в списке не показывается.
function continuesOf(scene: ShowcaseScene): boolean {
  return continuesPrevious(props.scenes, scene.id);
}

// Текст диктора без знаков ударения и не длиннее пары строк: список нужен, чтобы
// прочитать историю целиком, а правят её уже в редакторе сцены.
function excerptOf(scene: ShowcaseScene): string {
  const text = plainNarration(scene.narration).trim();

  if (!text) {
    return 'Текст озвучки пуст.';
  }

  return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH - 1)}…` : text;
}

/**
 * Время сцены: с какой секунды ролика она начинается и сколько длится запись.
 * Старт известен только у собранного ролика, длина — у записанной сцены.
 */
function timeOf(scene: ShowcaseScene): string {
  const parts: string[] = [];
  const start = props.startsMs?.get(scene.id);

  if (start !== undefined) {
    parts.push(timecode(start));
  }

  if (scene.clip?.durationMs) {
    parts.push(`${(scene.clip.durationMs / 1000).toFixed(1).replace('.', ',')} с`);
  }

  return parts.join(' · ');
}

// Спорное место озвучки и запрет проверки видны прямо в списке: до сборки человек
// должен знать, какую сцену послушать самому.
function warningOf(scene: ShowcaseScene): string {
  const check = scene.checks.find((item) => (
    item.kind === 'speech' && (item.status === 'warning' || item.status === 'blocked')
  ));

  return check ? `озвучка: ${check.reason}` : '';
}
</script>

<style scoped>
.board {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.board__row {
  width: 100%;
}

.board__body {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
  padding: 2px 0;
}

.board__order {
  display: grid;
  flex: none;
  min-width: 24px;
  height: 24px;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.board__copy {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.board__line {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  flex-wrap: wrap;
}

.board__title {
  font-size: 13.5px;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.board__chip {
  padding: 1px 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--ink-mid);
  font-size: 10.5px;
  white-space: nowrap;
}

.board__chip[data-tone='good'] {
  border-color: color-mix(in srgb, var(--good) 32%, var(--line));
  color: var(--good);
}

.board__chip[data-tone='warn'] {
  border-color: color-mix(in srgb, var(--warn) 38%, var(--line));
  color: var(--warn);
}

.board__chip[data-tone='accent'] {
  border-color: color-mix(in srgb, var(--accent) 38%, var(--line));
  color: var(--accent);
}

.board__time {
  margin-left: auto;
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.board__plan {
  display: flex;
  gap: 4px 8px;
  min-width: 0;
  flex-wrap: wrap;
  color: var(--ink-mid);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.board__plan[data-static='yes'] {
  color: color-mix(in srgb, var(--warn) 70%, var(--ink-mid));
}

.board__screen {
  color: var(--ink);
  font-weight: 600;
}

.board__chain {
  color: var(--accent);
  white-space: nowrap;
}

.board__text {
  color: var(--ink-mid);
  font-size: 12.5px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.board__warn {
  color: var(--warn);
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
</style>
