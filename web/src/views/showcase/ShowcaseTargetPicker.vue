<template>
  <div class="picker">
    <UiLoadingState v-if="!loaded && (loading || !error)" label="Ищем доступные стенды…"
      description="Постоянные стенды и поднятые песочницы появятся здесь сами." :failed="Boolean(error)" >
      <UiSkeletonLayout layout="list" :header="false" />
    </UiLoadingState>

    <div v-else-if="!loaded" class="picker__state" role="status">
      <span class="picker__mark" aria-hidden="true">!</span>
      <div class="picker__state-copy">
        <strong>Не удалось загрузить стенды</strong>
        <p>Проверьте сообщение выше и нажмите «Обновить», чтобы повторить.</p>
      </div>
    </div>

    <template v-else>
      <div v-if="!readyTargets.length" class="picker__state" role="status">
        <span class="picker__mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
            <rect x="3.5" y="4.5" width="17" height="12" rx="2" />
            <path d="M8 20h8 M12 16.5V20" />
          </svg>
        </span>
        <div class="picker__state-copy">
          <strong>{{ targets.length ? 'Стенды сейчас недоступны' : 'Нет стендов для записи' }}</strong>
          <p>
            Поднимите песочницу задачи или запустите постоянный стенд — адрес и профиль
            подставятся сами.
          </p>
        </div>
      </div>

      <!-- Каждая живая цель — своя строка с кнопкой: стендов у человека единицы, и
           выбирать один из них через список с «Далее» — лишний шаг. Стенд задачи
           подписан её названием: по номеру человек задачу не узнаёт. -->
      <ul v-if="readyTargets.length" class="picker__list">
        <li v-for="target in readyTargets" :key="choiceKey(target)" class="picker__item">
          <div class="picker__row">
            <span class="picker__dot" aria-hidden="true"></span>
            <div class="picker__copy">
              <span class="picker__line">
                <strong class="picker__label" v-tooltip="titleOf(target)">{{ titleOf(target) }}</strong>
                <!-- Есть ли уже ролик — видно чипом, а не догадкой по кнопке. -->
                <span class="picker__chip" :data-tone="filmChipOf(target).tone">
                  {{ filmChipOf(target).label }}
                </span>
              </span>
              <span class="picker__meta">{{ metaOf(target) }}</span>
            </div>
            <div class="picker__actions">
              <StandLink
                v-if="urlOf(target)"
                class="picker__link"
                :href="urlOf(target) ?? ''"
                variant="ghost"
              >
                Открыть стенд <span aria-hidden="true">↗</span>
              </StandLink>
              <!-- Ролик без запуска: человек сначала отмечает, о чём рассказать, —
                   коммиты, незакоммиченное, своё пожелание — и снимает из блока. -->
              <UiButton
                variant="ghost"
                :data-testid="`showcase-configure-${choiceKey(target)}`"
                :disabled="busy"
                @click="emit('configure', { ref: { ...target.ref } })"
              >
                Выбрать, о чём…
              </UiButton>
              <!-- Ролик про этот стенд уже есть: главное действие — открыть его,
                   а не завести второй такой же; второй остаётся тихой кнопкой. -->
              <template v-if="existingOf(target)">
                <UiButton
                  variant="ghost"
                  :data-testid="`showcase-create-${choiceKey(target)}`"
                  :loading="busy"
                  @click="emit('create', { ref: { ...target.ref } })"
                >
                  Снять новый
                </UiButton>
                <UiButton
                  variant="solid"
                  tone="accent"
                  :data-testid="`showcase-open-${choiceKey(target)}`"
                  @click="emit('open', existingOf(target)?.id ?? '')"
                >
                  Открыть ролик
                </UiButton>
              </template>
              <UiButton
                v-else
                variant="solid"
                tone="accent"
                :data-testid="`showcase-create-${choiceKey(target)}`"
                :loading="busy"
                @click="emit('create', { ref: { ...target.ref } })"
              >
                Снять ролик
              </UiButton>
            </div>
          </div>

          <p
            v-if="target.screenCount === 0"
            class="picker__limits"
            data-testid="showcase-create-screens-warning"
          >
            <template v-if="target.profileBinding === 'inferred'">
              Привязка профиля к песочнице не подтверждена. Можно безопасно записать
              начальный экран; вход, переходы, действия и подготовка данных отключены.
            </template>
            <template v-else>
              Карта экранов не настроена. Можно записать начальный экран; переходы и
              автоматические действия пока недоступны.
            </template>
          </p>
        </li>
      </ul>

      <!-- Недоступная цель остаётся видимой с причиной: пропавший из списка стенд
           выглядел бы как «его не существует», а не «идёт попытка». -->
      <ul v-if="blockedTargets.length" class="picker__blocked" role="status">
        <li v-for="target in blockedTargets" :key="choiceKey(target)">
          <strong>{{ target.label }}</strong>
          <span>{{ target.reason || 'Цель сейчас недоступна.' }}</span>
        </li>
      </ul>

      <div class="picker__foot">
        <UiActionLink href="#/sandboxes" variant="ghost">Открыть песочницы</UiActionLink>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import StandLink from '../../shared/browser/StandLink.vue';
import { UiSkeletonLayout } from '../../ui';

import { computed } from 'vue';

import {
  UiActionLink,
  UiButton,
  vTooltip,
  UiLoadingState,
} from '../../ui';
import { sandboxUrl } from '../../shared/sandbox.ts';
import type {
  ShowcaseOverview,
  ShowcaseProjectSummary,
  ShowcaseSelectableTargetRef,
} from '../../../../shared/plugins/showcase/showcaseContracts';

type TargetChoice = ShowcaseOverview['targets'][number];

const props = defineProps<{
  targets: ShowcaseOverview['targets'];
  // Уже заведённые ролики: строка цели подсказывает, что ролик про неё есть.
  projects: ShowcaseProjectSummary[];
  busy: boolean;
  loaded: boolean;
  loading: boolean;
  error: string;
}>();

const emit = defineEmits<{
  create: [payload: { ref: ShowcaseSelectableTargetRef }];
  // Завести ролик без запуска и открыть блок «О чём ролик».
  configure: [payload: { ref: ShowcaseSelectableTargetRef }];
  open: [projectId: string];
}>();

const KIND_TEXT: Record<TargetChoice['ref']['kind'], string> = {
  project: 'постоянный стенд',
  sandbox: 'песочница',
};

interface FilmChip {
  tone: 'none' | 'good' | 'warn' | 'accent';
  label: string;
}

// Состояние ролика словами списка роликов: чип у стенда и чип у ролика обязаны
// называть одно и то же одинаково.
const FILM_STATE: Record<ShowcaseProjectSummary['state'], FilmChip> = {
  draft: { tone: 'warn', label: 'ролик без сцен' },
  ready: { tone: 'good', label: 'сцены готовы' },
  building: { tone: 'accent', label: 'идёт сборка' },
  blocked: { tone: 'warn', label: 'ролику нужен человек' },
  done: { tone: 'good', label: 'ролик собран' },
};

const NO_FILM: FilmChip = { tone: 'none', label: 'ролика нет' };

const supportedTargets = computed(() => props.targets.filter((target) => (
  target.ref.kind === 'project' || target.ref.kind === 'sandbox'
)));

const readyTargets = computed(() => (
  supportedTargets.value.filter((target) => target.status === 'ready')
));

const blockedTargets = computed(() => (
  supportedTargets.value.filter((target) => target.status === 'blocked')
));

function choiceKey(target: TargetChoice): string {
  return `${target.ref.kind}:${target.ref.id}`;
}

// Постоянный стенд публикует готовую ссылку; у песочницы хост задаёт профиль.
// Ответ старого сервера сохраняет локальный fallback общего генератора ссылок.
function urlOf(target: TargetChoice): string | null {
  return target.ref.kind === 'sandbox'
    ? sandboxUrl(target.viewPort, target.serviceHost)
    : target.viewUrl;
}

// Первая строка цели: название задачи, когда портал его дал; иначе — подпись стенда.
function titleOf(target: TargetChoice): string {
  return target.taskTitle || target.label;
}

/**
 * Вторая строка цели: что это за стенд и насколько подробно профиль описал его
 * экраны. Число экранов решает, о чём выйдет ролик, поэтому оно названо до выбора.
 * Когда первой строкой стоит название задачи, подпись стенда (профиль, номер,
 * состояние попытки) переезжает сюда.
 */
function metaOf(target: TargetChoice): string {
  const screens = target.screenCount
    ? `карта: ${target.screenCount} экр.`
    : 'только начальный экран';

  if (target.taskTitle) {
    return `${target.label} · ${screens}`;
  }

  return `${KIND_TEXT[target.ref.kind]} · профиль ${target.profile} · ${screens}`;
}

function existingOf(target: TargetChoice): ShowcaseProjectSummary | null {
  return props.projects.find((project) => (
    project.ref.kind === target.ref.kind && project.ref.id === target.ref.id
  )) ?? null;
}

function filmChipOf(target: TargetChoice): FilmChip {
  const existing = existingOf(target);

  return existing ? FILM_STATE[existing.state] : NO_FILM;
}
</script>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.picker__state {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 14px;
  border: 1px dashed var(--line-2);
  border-radius: 11px;
  background: color-mix(in srgb, var(--surface-2) 28%, transparent);
}

.picker__mark {
  display: grid;
  flex: none;
  width: 36px;
  height: 36px;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-weight: 700;
}

.picker__mark svg {
  width: 18px;
  height: 18px;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.picker__state-copy {
  min-width: 0;
}

.picker__state-copy strong {
  font-size: 14px;
}

.picker__state-copy p {
  max-width: 640px;
  margin: 4px 0 0;
  color: var(--ink-mid);
  font-size: 12.5px;
  line-height: 1.5;
}

.picker__list,
.picker__blocked {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.picker__item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 12px 13px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: color-mix(in srgb, var(--ground) 52%, transparent);
}

.picker__row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex-wrap: wrap;
}

.picker__dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--good);
}

.picker__copy {
  display: flex;
  flex: 1 1 260px;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.picker__line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.picker__label {
  min-width: 0;
  overflow: hidden;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker__chip {
  flex: none;
  padding: 1px 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--ink-mid);
  font-size: 10.5px;
  white-space: nowrap;
}

.picker__chip[data-tone='good'] {
  border-color: color-mix(in srgb, var(--good) 32%, var(--line));
  color: var(--good);
}

.picker__chip[data-tone='warn'] {
  border-color: color-mix(in srgb, var(--warn) 38%, var(--line));
  color: var(--warn);
}

.picker__chip[data-tone='accent'] {
  border-color: color-mix(in srgb, var(--accent) 38%, var(--line));
  color: var(--accent);
}

.picker__meta {
  color: var(--ink-mid);
  font-size: 12px;
}

.picker__actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.picker__limits {
  margin: 0;
  padding-left: 18px;
  color: var(--warn);
  font-size: 12px;
  line-height: 1.45;
}

.picker__blocked li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  padding: 6px 13px;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.4;
}

.picker__blocked li strong {
  color: var(--ink);
  font-size: inherit;
}

.picker__foot {
  display: flex;
  justify-content: flex-end;
}

@media (max-width: 640px) {
  .picker__actions {
    width: 100%;
    margin-left: 0;
  }
}
</style>
