<template>
  <section class="film" aria-labelledby="showcase-film-title">
    <header class="film__head">
      <div class="film__crumbs">
        <UiButton variant="ghost" @click="emit('close')">← Ролики</UiButton>
      </div>
      <div class="film__heading">
        <div class="film__title-row">
          <h2 id="showcase-film-title">{{ project.title }}</h2>
          <UiIconButton
            label="Переименовать ролик"
            title="Переименовать"
            variant="ghost"
            :disabled="busy"
            @click="emit('rename')"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z M13.5 6.5l3 3" />
            </svg>
          </UiIconButton>
        </div>
        <p class="film__target">{{ targetText }}</p>
      </div>
      <div class="film__head-actions">
        <UiActionLink
          v-if="targetUrl"
          :href="targetUrl"
          variant="ghost"
          target="_blank"
          rel="noopener noreferrer"
        >
          Открыть стенд <span aria-hidden="true">↗</span>
        </UiActionLink>
        <UiButton variant="ghost" tone="danger" :disabled="busy" @click="emit('remove-project')">
          Удалить ролик
        </UiButton>
      </div>
    </header>

    <UiInlineMessage v-if="blockedReason" tone="warning">
      {{ blockedReason }}
      <template v-if="nextAction"> — {{ nextAction }}</template>
    </UiInlineMessage>

    <ShowcaseBuildBar
      v-if="!analyzing"
      :project="project"
      :jobs="jobs"
      :build-run="buildRun"
      :busy="busy"
      :unsaved-count="changedIds.length"
      @build="build"
      @cancel-build="emit('cancel-build', $event)"
      @cancel-job="emit('cancel', $event)"
    />

    <!-- Разбор идёт минутами: экран говорит, что именно читается, и ничего не
         предлагает править, пока плана нет. -->
    <section v-if="analyzing" class="film__analysis" role="status" aria-live="polite">
      <div class="film__analysis-head">
        <UiSpinner decorative role="standalone" />
        <strong>Разбираю задачу</strong>
      </div>
      <p class="film__analysis-copy">
        Читаю постановку из портала, изменения в репозиториях стенда и карту экранов
        профиля. Модель предложит план и сцены — обычно это занимает несколько минут.
      </p>
    </section>

    <section v-else-if="!orderedScenes.length" class="film__empty" aria-labelledby="showcase-empty-title">
      <div class="film__empty-copy">
        <strong id="showcase-empty-title">Сцен пока нет</strong>
        <p>
          Разбор не дал сцен. Можно повторить его — постановка и изменения читаются
          заново — или добавить сцены руками.
        </p>
      </div>
      <UiButton variant="solid" tone="accent" :loading="busy" @click="emit('analyze')">
        Разобрать заново
      </UiButton>
      <ShowcaseScriptGaps :gaps="project.scriptGaps" />
      <ShowcaseSceneForm :screens="screens" :busy="busy" @add="emit('add-scene', $event)" />
    </section>

    <template v-else>
      <slot name="voice" />

      <!-- Карта экранов изменилась после разбора. Сборка переснимет прежние действия
           честно, но человек хотел бы увидеть новые элементы — и узнать об этом ДО
           записи, а не после просмотра ролика. -->
      <UiInlineMessage v-if="scriptOutdated" tone="warning">
        {{ SCRIPT_OUTDATED_TEXT }}
        <UiButton variant="ghost" :loading="busy" @click="emit('analyze')">Разобрать заново</UiButton>
      </UiInlineMessage>

      <div class="film__stage">
        <div class="film__main">
          <section v-if="project.latestFinal" class="film__final" aria-labelledby="showcase-final-title">
            <div class="film__block-head">
              <h3 id="showcase-final-title">
                {{ rebuilding ? 'Предыдущая сборка' : 'Готовый ролик' }}
              </h3>
              <span class="film__meta">
                <span v-if="!project.latestFinal.current" class="film__stale">предыдущая сборка</span>
                {{ finalText }}
              </span>
            </div>
            <UiInlineMessage v-if="rebuilding" tone="neutral" data-role="previous-build">
              Идёт пересборка. Здесь пока предыдущий ролик; новый появится после завершения сборки.
            </UiInlineMessage>
            <UiVideo
              :key="project.latestFinal.video.id"
              ref="player"
              :src="finalUrl"
              :label="rebuilding ? 'Предыдущая сборка' : 'Готовый ролик'"
            />
            <UiInlineMessage
              v-if="manifestUnavailable"
              tone="warning"
              data-role="manifest-unavailable"
            >
              Точная навигация по сценам и фразам недоступна: шкала ролика не прочиталась.
            </UiInlineMessage>
            <nav v-if="manifestPhrases.length" class="film__phrases" aria-label="Переход по фразе">
              <span>Перейти к фразе</span>
              <div class="film__phrase-list">
                <UiButton
                  v-for="phrase in manifestPhrases"
                  :key="phrase.id"
                  variant="ghost"
                  @click="seekTo(phrase.startMs)"
                >
                  {{ timecode(phrase.startMs) }} · {{ phrase.text }}
                </UiButton>
              </div>
            </nav>
            <div class="film__downloads">
              <UiActionLink :href="finalUrl" download="showcase.mp4">Скачать mp4</UiActionLink>
              <UiActionLink v-if="subtitlesUrl" :href="subtitlesUrl" download="showcase.srt">
                Скачать субтитры
              </UiActionLink>
            </div>
          </section>

          <section class="film__scenes" aria-labelledby="showcase-scenes-title">
            <div class="film__block-head">
              <h3 id="showcase-scenes-title">Сцены</h3>
              <span class="film__meta">{{ orderedScenes.length }} из {{ maxScenes }}</span>
            </div>

            <ShowcaseStoryboard
              :scenes="orderedScenes"
              :screens="screens"
              :selected-id="selectedId"
              :changed-ids="changedIds"
              :starts-ms="startsMs"
              @select="select"
            />

            <UiDisclosureButton v-model:open="addOpen" controls="showcase-add-scene" density="compact">
              {{ addOpen ? 'Скрыть форму сцены' : 'Добавить сцену' }}
            </UiDisclosureButton>
            <div v-show="addOpen" id="showcase-add-scene">
              <ShowcaseSceneForm :screens="screens" :busy="busy" @add="emit('add-scene', $event)" />
            </div>
          </section>

          <section class="film__brief" aria-labelledby="showcase-brief-title">
            <div class="film__block-head">
              <UiDisclosureButton v-model:open="briefOpen" controls="showcase-brief-body" density="compact">
                <span id="showcase-brief-title">{{ briefTitle }}</span>
              </UiDisclosureButton>
              <UiButton variant="ghost" :loading="busy" @click="emit('analyze')">Разобрать заново</UiButton>
            </div>
            <div v-show="briefOpen" id="showcase-brief-body">
              <ol v-if="project.brief.length" class="film__brief-list">
                <li v-for="(point, index) in project.brief" :key="index">{{ point }}</li>
              </ol>
              <p v-else class="film__note">
                План собирается по тексту связанной задачи и изменениям в репозиториях стенда.
              </p>
            </div>
            <!-- Чего карта экранов не дала показать — справка при плане, а не
                 предупреждение над роликом: решать это оператору не нужно. -->
            <ShowcaseScriptGaps :gaps="project.scriptGaps" />
          </section>

          <ShowcaseStandPanel
            :project="project"
            :seed="seed"
            :busy="busy"
            @seed="emit('seed', $event)"
            @data-updated="emit('data-updated')"
          />
        </div>

        <aside class="film__side">
          <ShowcaseSceneEditor
            v-if="selectedScene"
            :key="selectedScene.id"
            :scene="selectedScene"
            :index="selectedIndex + 1"
            :total="orderedScenes.length"
            :screen-title="screenTitleOf(selectedScene)"
            :draft="draftFor(selectedScene)"
            :changed="changedIds.includes(selectedScene.id)"
            :busy="busy"
            :first="selectedIndex === 0"
            :last="selectedIndex === orderedScenes.length - 1"
            :clip-url="selectedScene.clip ? artifactUrl(selectedScene.clip.id) : ''"
            :audio-url="selectedScene.audio ? artifactUrl(selectedScene.audio.id) : ''"
            :can-jump="Boolean(startsMs?.has(selectedScene.id))"
            :continues="continuesPrevious(orderedScenes, selectedScene.id)"
            :voice-ref="voiceRef"
            :voice-capabilities="voiceCapabilities"
            :load-preview="loadScenePreview"
            @change="drafts.set(selectedScene.id, $event)"
            @save="save(selectedScene)"
            @remove="emit('remove-scene', selectedScene.id)"
            @move="emit('move-scene', { id: selectedScene.id, delta: $event })"
            @audio="emit('scene-audio', { id: selectedScene.id, file: $event })"
            @jump="jump(selectedScene.id)"
            @continue="emit('scene-continues', { id: selectedScene.id, value: $event })"
            @generate-bindings="generateBindings"
          />
        </aside>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';

import {
  UiActionLink,
  UiButton,
  UiDisclosureButton,
  UiIconButton,
  UiInlineMessage,
  UiSpinner,
  UiVideo,
} from '../../ui';
import { continuesPrevious } from '../../../../shared/showcaseChains';
import type {
  ShowcaseBuildRun,
  ShowcaseJob,
  ShowcaseProject,
  ShowcaseScene,
  ShowcaseVoiceInfo,
} from '../../../../shared/showcaseContracts';
import { sceneStartsMs } from '../../../../shared/showcaseTimeline';
import type { ShowcaseFinalManifest } from '../../../../shared/showcaseTimeline';
import type { SeedStatus } from '../../actions/showcase';
import { SCRIPT_OUTDATED_TEXT, showcaseScriptOutdated } from '../../actions/showcase';
import ShowcaseBuildBar from './ShowcaseBuildBar.vue';
import ShowcaseSceneEditor from './ShowcaseSceneEditor.vue';
import ShowcaseSceneForm from './ShowcaseSceneForm.vue';
import ShowcaseScriptGaps from './ShowcaseScriptGaps.vue';
import ShowcaseStandPanel from './ShowcaseStandPanel.vue';
import ShowcaseStoryboard from './ShowcaseStoryboard.vue';
import {
  draftChanged,
  draftOf,
  payloadOf,
  reconcilePronunciationHashes,
} from './sceneDraft';
import { timecode } from './sceneText';
import type {
  SceneDraft,
  SceneNarrationPreviewInput,
  SceneTextPayload,
} from './sceneDraft';

type VoiceCapabilities = NonNullable<ShowcaseVoiceInfo['capabilities']>;

const props = defineProps<{
  project: ShowcaseProject;
  seed: SeedStatus | null;
  jobs: ShowcaseJob[];
  buildRun: ShowcaseBuildRun | null;
  manifest: ShowcaseFinalManifest | null;
  manifestStatus: 'idle' | 'loading' | 'ready' | 'failed';
  busy: boolean;
  // Разбор моделью идёт прямо сейчас: план ещё не готов, править нечего.
  analyzing: boolean;
  maxScenes: number;
  // Ссылка на стенд для человека; у песочницы её строит вид по хосту кокпита.
  targetUrl: string | null;
  artifactUrl: (artifactId: string) => string;
  voiceRef?: string | null;
  voiceCapabilities?: VoiceCapabilities | null;
  loadScenePreview?: (
    input: SceneNarrationPreviewInput,
    signal?: AbortSignal,
  ) => Promise<Blob>;
}>();

const emit = defineEmits<{
  close: [];
  // Сборка получает несохранённые правки: их надо записать до записи экранов,
  // иначе ролик снимет старый текст, а человек увидит в нём не то, что набрал.
  build: [pending: SceneTextPayload[]];
  analyze: [];
  rename: [];
  'remove-project': [];
  seed: [recipeFingerprint: string];
  'data-updated': [];
  cancel: [jobId: string];
  'cancel-build': [runId: string];
  'add-scene': [payload: { screenId: string; narration: string }];
  'save-scene': [payload: SceneTextPayload];
  'remove-scene': [id: string];
  'move-scene': [payload: { id: string; delta: number }];
  'scene-audio': [payload: { id: string; file: File }];
  // Откуда сцена начинается — решение о записи: уходит сразу, минуя черновик.
  'scene-continues': [payload: { id: string; value: boolean }];
  'generate-bindings': [pending: SceneTextPayload[]];
  'select-scene': [id: string];
}>();

const selectedId = ref('');
const addOpen = ref(false);
const briefOpen = ref(false);
const player = ref<InstanceType<typeof UiVideo> | null>(null);
const rebuilding = computed(() => Boolean(
  props.buildRun && ['queued', 'running', 'cancelling'].includes(props.buildRun.state),
));

// Черновики текста по сценам. Живут здесь, а не в редакторе: переход к другой
// сцене не должен терять набранное, а список сцен показывает, где правки не
// сохранены.
const drafts = reactive(new Map<string, SceneDraft>());

const screens = computed(() => (
  props.project.target.status === 'ready' ? props.project.target.scope.screens : []
));

const orderedScenes = computed(() => (
  [...props.project.scenes].sort((left, right) => left.order - right.order)
));

const selectedIndex = computed(() => (
  orderedScenes.value.findIndex((scene) => scene.id === selectedId.value)
));

const selectedScene = computed(() => orderedScenes.value[selectedIndex.value] ?? null);

const changedIds = computed(() => orderedScenes.value
  .filter((scene) => {
    const draft = drafts.get(scene.id);

    return draft ? draftChanged(scene, draft) : false;
  })
  .map((scene) => scene.id));

// v1 читает только проверенную итоговую шкалу. Формула исходных клипов остаётся
// исключительно для legacy-final без manifestVersion.
const startsMs = computed(() => (
  props.project.latestFinal?.current
    ? props.project.latestFinal.manifestVersion === 1
      ? manifestSceneStarts.value
      : sceneStartsMs(props.project.scenes)
    : null
));

const manifestSceneStarts = computed(() => {
  if (!props.manifest || props.manifest.scenes.length !== orderedScenes.value.length) {
    return null;
  }

  const starts = new Map(props.manifest.scenes.map((scene) => [scene.id, scene.startMs]));

  return orderedScenes.value.every((scene) => starts.has(scene.id)) ? starts : null;
});

const manifestPhrases = computed(() => {
  if (!props.project.latestFinal?.current || !manifestSceneStarts.value || !props.manifest) {
    return [];
  }

  return props.manifest.scenes.flatMap((scene) => scene.phrases.map((phrase) => ({
    ...phrase,
    id: `${scene.id}:${phrase.id}`,
  })));
});

const manifestUnavailable = computed(() => (
  props.project.latestFinal?.current
  && props.project.latestFinal.manifestVersion === 1
  && props.manifestStatus === 'failed'
));

const targetText = computed(() => {
  if (props.project.target.status !== 'ready') {
    return 'цель показа недоступна';
  }

  const scope = props.project.target.scope;
  const environment = scope.environment === 'isolated-demo' ? 'демо-копия' : 'только чтение';

  return `${scope.targetLabel} · ${environment}`;
});

const blockedReason = computed(() => (
  props.project.target.status === 'blocked' ? props.project.target.reason : ''
));

const nextAction = computed(() => (
  props.project.target.status === 'blocked' ? props.project.target.nextAction?.hint ?? '' : ''
));

const scriptOutdated = computed(() => showcaseScriptOutdated(props.project));

const briefTitle = computed(() => (
  props.project.brief.length ? `План ролика · ${props.project.brief.length} п.` : 'План ролика'
));

const finalUrl = computed(() => (
  props.project.latestFinal ? props.artifactUrl(props.project.latestFinal.video.id) : ''
));

const subtitlesUrl = computed(() => (
  props.project.latestFinal?.subtitles
    ? props.artifactUrl(props.project.latestFinal.subtitles.id)
    : ''
));

/**
 * Подпись готового ролика: когда собран и сколько идёт. Дата нужна, чтобы отличить
 * вчерашнюю сборку от сегодняшней, длина — чтобы понять, влезает ли ролик в лимит.
 */
const finalText = computed(() => {
  const final = props.project.latestFinal;

  if (!final) {
    return '';
  }

  const built = new Date(final.builtAt).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const duration = final.video.durationMs ? ` · ${timecode(final.video.durationMs)}` : '';

  return `собран ${built}${duration}`;
});

// Выбор следует за составом сцен: удалённая сцена уступает место соседней, новый
// сценарий открывает первую. Человек не остаётся с пустым редактором.
watch(orderedScenes, (scenes, previous) => {
  if (scenes.some((scene) => scene.id === selectedId.value)) {
    return;
  }

  const previousIndex = (previous ?? []).findIndex((scene) => scene.id === selectedId.value);
  const fallback = scenes[Math.min(Math.max(previousIndex, 0), scenes.length - 1)];

  select(fallback?.id ?? '');
}, { immediate: true });

// Черновик, догнавший сохранённую сцену, больше не черновик: его снимает ответ
// сервера, а не догадка о том, прошло ли сохранение.
watch(() => props.project.scenes, (scenes) => {
  for (const [id, draft] of drafts) {
    const scene = scenes.find((item) => item.id === id);

    if (!scene) {
      drafts.delete(id);

      continue;
    }

    const reconciled = reconcilePronunciationHashes(scene, draft);

    if (!draftChanged(scene, reconciled)) {
      drafts.delete(id);
    } else if (reconciled !== draft) {
      drafts.set(id, reconciled);
    }
  }
});

function screenTitleOf(scene: ShowcaseScene): string {
  return screens.value.find((screen) => screen.id === scene.screenId)?.title ?? scene.screenId;
}

function draftFor(scene: ShowcaseScene): SceneDraft {
  return drafts.get(scene.id) ?? draftOf(scene);
}

function select(id: string): void {
  selectedId.value = id;
  emit('select-scene', id);
}

/**
 * Сохранение сцены. Черновик заменяется тем, что реально ушло на сервер: субтитр
 * мог быть достроен по речи, и без этого правка считалась бы несохранённой вечно.
 */
function save(scene: ShowcaseScene): void {
  const payload = payloadOf(scene, draftFor(scene));

  drafts.set(scene.id, {
    ...draftFor(scene),
    title: payload.title,
    narration: payload.narration,
    caption: payload.caption,
    subtitleText: payload.subtitleText,
  });
  emit('save-scene', payload);
}

/**
 * Сборка забирает с собой несохранённые правки: каждая сначала уходит на сервер,
 * и только потом снимаются экраны. Черновики при этом фиксируются так же, как при
 * ручном сохранении.
 */
function build(): void {
  const pending = orderedScenes.value
    .filter((scene) => changedIds.value.includes(scene.id))
    .map((scene) => payloadOf(scene, draftFor(scene)));

  for (const payload of pending) {
    const scene = orderedScenes.value.find((item) => item.id === payload.id);

    if (!scene) {
      continue;
    }

    drafts.set(payload.id, {
      ...draftFor(scene),
      title: payload.title,
      narration: payload.narration,
      caption: payload.caption,
      subtitleText: payload.subtitleText,
    });
  }

  emit('build', pending);
}

/**
 * Сначала сохраняет те же черновики, затем просит модель менять только связи.
 * Так модель строит диапазоны уже по тому тексту, который видит человек.
 */
function generateBindings(): void {
  const pending = orderedScenes.value
    .filter((scene) => changedIds.value.includes(scene.id))
    .map((scene) => payloadOf(scene, draftFor(scene)));

  for (const payload of pending) {
    const scene = orderedScenes.value.find((item) => item.id === payload.id);

    if (scene) {
      drafts.set(payload.id, {
        ...draftFor(scene),
        title: payload.title,
        narration: payload.narration,
        caption: payload.caption,
        subtitleText: payload.subtitleText,
      });
    }
  }

  emit('generate-bindings', pending);
}

/**
 * Переход к сцене в готовом ролике: плеер перематывается на её начало и попадает в
 * область видимости — на длинной странице он мог остаться выше экрана.
 */
function jump(sceneId: string): void {
  const startMs = startsMs.value?.get(sceneId);

  if (startMs === undefined) {
    return;
  }

  seekTo(startMs);
}

// Перемотка принимает миллисекунды из manifest и переводит их в секунды плеера.
// После перехода готовый ролик возвращается в видимую область длинной страницы.
function seekTo(startMs: number): void {
  const video = player.value;

  if (!video) {
    return;
  }

  video.seek(startMs / 1000);

  const element = video.$el as { scrollIntoView?: (options: unknown) => void } | undefined;

  element?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
}
</script>

<style scoped>
.film {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

.film__head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px 16px;
  align-items: start;
  min-width: 0;
}

.film__crumbs {
  grid-column: 1 / -1;
  margin-left: -10px;
}

.film__heading {
  min-width: 0;
}

.film__title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.film__title-row h2 {
  margin: 0;
  font-size: 21px;
  line-height: 1.25;
  letter-spacing: -0.025em;
  overflow-wrap: anywhere;
}

.film__title-row svg {
  width: 15px;
  height: 15px;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.film__target,
.film__note,
.film__meta {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12.5px;
  line-height: 1.45;
}

.film__target {
  margin-top: 4px;
}

.film__head-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
}

.film__analysis,
.film__empty {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 14px;
  min-width: 0;
  padding: 18px 20px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--surface) 96%, #fff) 0%,
    var(--surface) 100%
  );
}

.film__analysis {
  gap: 6px;
}

.film__analysis-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  font-size: 15px;
}

/* Текст стоит под заголовком с тем же отступом, что и заголовок после спиннера:
   спиннер 18px + зазор 10px. */
.film__analysis-copy {
  max-width: 640px;
  margin: 0;
  padding-left: 28px;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.5;
}

.film__empty-copy {
  min-width: 0;
}

.film__empty-copy strong {
  font-size: 15px;
}

.film__empty-copy p {
  max-width: 640px;
  margin: 5px 0 0;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.5;
}

.film__stage {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
  align-items: start;
  gap: 16px;
}

.film__main {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.film__side {
  position: sticky;
  top: 12px;
  min-width: 0;
}

.film__final,
.film__scenes,
.film__brief {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--surface) 96%, #fff) 0%,
    var(--surface) 100%
  );
  box-shadow: inset 0 1px 0 #ffffff08;
}

.film__block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}

.film__block-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 660;
  letter-spacing: -0.01em;
}

.film__stale {
  margin-right: 6px;
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, var(--warn) 38%, var(--line));
  border-radius: 999px;
  background: color-mix(in srgb, var(--warn) 6%, var(--ground));
  color: var(--warn);
  font-size: 10.5px;
}

.film__downloads {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.film__phrases {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
  color: var(--ink-mid);
  font-size: 12px;
}

.film__phrase-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.film__brief-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding-left: 20px;
  font-size: 13.5px;
}

.film__brief-list li {
  padding-left: 3px;
  line-height: 1.5;
}

@media (max-width: 980px) {
  .film__stage {
    grid-template-columns: minmax(0, 1fr);
  }

  .film__side {
    position: static;
  }
}

@media (max-width: 640px) {
  .film__head {
    grid-template-columns: minmax(0, 1fr);
  }

  .film__head-actions {
    flex-wrap: wrap;
  }
}
</style>
