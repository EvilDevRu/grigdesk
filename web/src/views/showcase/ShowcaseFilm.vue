<template>
  <section class="film" :class="{ 'film--empty': !orderedScenes.length }"
    aria-labelledby="showcase-film-title">
    <header class="film__head">
      <div class="film__crumbs">
        <UiButton variant="ghost" @click="emit('close')">{{ t('core.showcaseRoliki2') }}</UiButton>
      </div>
      <div class="film__heading">
        <div class="film__title-row">
          <h2 id="showcase-film-title">{{ project.title }}</h2>
          <UiIconButton
            :label="t('core.showcasePereimenovatRolik')"
            v-tooltip="t('core.machineRename')"
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
        <StandLink
          v-if="targetUrl"
          :href="targetUrl"
          variant="ghost"
          > {{ t('core.showcaseOtkrytStend') }} <span aria-hidden="true">↗</span>
        </StandLink>
        <UiButton variant="ghost" tone="danger" :disabled="busy" @click="emit('remove-project')"> {{ t('core.showcaseUdalitRolik') }} </UiButton>
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

    <div class="film__workspace">
      <aside class="film__setup" :aria-label="t('core.showcaseFilmSettings')">
        <div class="film__setup-head">
          <h3>{{ t('core.showcaseFilmSettings') }}</h3>
          <span class="film__meta">{{ t('core.showcaseForWholeFilm') }}</span>
        </div>
        <ShowcaseStandPicker
          :project="project"
          :targets="targets"
          :busy="busy"
          :target-url="targetUrl"
          @attach="emit('attach-target', $event)"
        />
        <div class="film__voice"><slot name="voice" /></div>
        <section class="film__source" aria-labelledby="showcase-source-title">
          <div class="film__block-head">
            <UiDisclosureButton v-if="orderedScenes.length" v-model:open="sourceOpen" controls="showcase-source-body" density="compact">
              <span id="showcase-source-title">{{ t('core.showcaseOChemRolik') }}</span>
            </UiDisclosureButton>
            <h3 v-else id="showcase-source-title">{{ t('core.showcaseOChemRolik') }}</h3>
            <span class="film__meta">{{ project.source ? t('core.showcaseSvoyVybor') : t('settings.diagnosticSourceDefault') }}</span>
          </div>
          <div id="showcase-source-body">
            <ShowcaseSourcePanel
              v-show="!orderedScenes.length || sourceOpen"
              :project="project"
              :busy="busy"
              @apply="emit('apply-source', $event)"
            />
          </div>
          <UiButton v-if="!orderedScenes.length" variant="ghost" :loading="busy" @click="emit('analyze')">
            {{ t('core.showcaseRazobratZanovo') }}
          </UiButton>
        </section>

        <section v-if="orderedScenes.length" class="film__brief" aria-labelledby="showcase-brief-title">
          <div class="film__block-head">
            <UiDisclosureButton v-model:open="briefOpen" controls="showcase-brief-body" density="compact">
              <span id="showcase-brief-title">{{ briefTitle }}</span>
            </UiDisclosureButton>
            <UiButton variant="ghost" :loading="busy" @click="emit('analyze')">{{ t('core.showcaseRazobratZanovo') }}</UiButton>
          </div>
          <div v-show="briefOpen" id="showcase-brief-body">
            <ol v-if="project.brief.length" class="film__brief-list">
              <li v-for="(point, index) in project.brief" :key="index">{{ point }}</li>
            </ol>
            <p v-else class="film__note"> {{ t('core.showcasePlanSobiraetsyaPoTekstu') }} </p>
          </div>
          <!-- Чего карта экранов не дала показать — справка при плане, а не
                 предупреждение над роликом: решать это оператору не нужно. -->
          <ShowcaseScriptGaps :gaps="project.scriptGaps" />
        </section>

        <ShowcaseStandPanel
          v-if="project.target?.status === 'ready'"
          :project="project"
          :seed="seed"
          :busy="busy"
          @seed="emit('seed', $event)"
          @data-updated="emit('data-updated')"
        />
      </aside>

      <div class="film__canvas">
        <section v-if="analyzing" class="film__analysis" role="status" aria-live="polite">
          <div class="film__analysis-head">
            <UiSpinner decorative role="standalone" />
            <strong>{{ t('core.showcaseRazbirayuZadachu') }}</strong>
          </div>
          <p class="film__analysis-copy"> {{ t('core.showcaseChitayuPostanovkuIzPortala') }} </p>
        </section>

        <section v-else-if="!orderedScenes.length" class="film__empty"
          aria-labelledby="showcase-empty-title">
          <div class="film__empty-copy">
            <h3 id="showcase-empty-title">{{ t('core.showcaseStsenPokaNet') }}</h3>
            <p>{{ t('core.showcaseEditorStartHint') }}</p>
          </div>
          <ShowcaseScriptGaps :gaps="project.scriptGaps" />
          <div class="film__manual">
            <h3>{{ t('core.showcaseDobavitStsenu') }}</h3>
            <ShowcaseSceneForm :screens="screens" :busy="busy" @add="emit('add-scene', $event)" />
          </div>
        </section>

        <template v-else>
          <!-- Карта экранов изменилась после разбора. Сборка переснимет прежние действия
           честно, но человек хотел бы увидеть новые элементы — и узнать об этом ДО
           записи, а не после просмотра ролика. -->
          <UiInlineMessage v-if="scriptOutdated" tone="warning">
            {{ SCRIPT_OUTDATED_TEXT }}
            <UiButton variant="ghost" :loading="busy" @click="emit('analyze')">{{ t('core.showcaseRazobratZanovo') }}</UiButton>
          </UiInlineMessage>

          <!-- Выбор «О чём ролик» сменили после разбора, а новый разбор не прошёл: сцены
           рассказывают о прежнем, и человек должен узнать это до сборки. -->
          <UiInlineMessage v-if="sourceOutdated" tone="warning" data-role="source-outdated">
            {{ SOURCE_OUTDATED_TEXT }}
            <UiButton variant="ghost" :loading="busy" @click="emit('analyze')">{{ t('core.showcaseRazobratZanovo') }}</UiButton>
          </UiInlineMessage>

          <section v-if="project.latestFinal" class="film__final" aria-labelledby="showcase-final-title">
            <div class="film__block-head">
              <h3 id="showcase-final-title">
                {{ rebuilding ? t('core.showcasePredyduschayaSborka') : t('core.showcaseGotovyyRolik') }}
              </h3>
              <span class="film__meta">
                <span v-if="!project.latestFinal.current" class="film__stale">{{ t('core.showcasePredyduschayaSborka2') }}</span>
                {{ finalText }}
              </span>
            </div>
            <UiInlineMessage v-if="rebuilding" tone="neutral" data-role="previous-build"> {{ t('core.showcaseIdetPeresborkaZdesPoka') }} </UiInlineMessage>
            <UiVideo
              :key="project.latestFinal.video.id"
              ref="player"
              :src="finalUrl"
              :label="rebuilding ? t('core.showcasePredyduschayaSborka') : t('core.showcaseGotovyyRolik')"
            />
            <UiInlineMessage
              v-if="manifestUnavailable"
              tone="warning"
              data-role="manifest-unavailable"
            > {{ t('core.showcaseTochnayaNavigatsiyaPoStsenam') }} </UiInlineMessage>
            <nav v-if="manifestPhrases.length" class="film__phrases" :aria-label="t('core.showcasePerehodPoFraze')">
              <span>{{ t('core.showcasePereytiKFraze') }}</span>
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
              <UiActionLink :href="finalUrl" download="showcase.mp4">{{ t('core.showcaseSkachatMp4') }}</UiActionLink>
              <UiActionLink v-if="subtitlesUrl" :href="subtitlesUrl" download="showcase.srt"> {{ t('core.showcaseSkachatSubtitry') }} </UiActionLink>
            </div>
          </section>

          <section class="film__scenes" aria-labelledby="showcase-scenes-title">
            <div class="film__block-head">
              <h3 id="showcase-scenes-title">{{ t('core.showcaseStseny') }}</h3>
              <span class="film__meta">{{ orderedScenes.length }} {{ t('settings.from') }} {{ maxScenes }}</span>
            </div>

            <ShowcaseTimeline
              :scenes="orderedScenes"
              :selected-id="selectedScene?.id ?? null"
              :changed-ids="changedIds"
              :busy="busy"
              :frame-url="artifactUrl"
              :starts-ms="startsMs"
              @select="select"
              @reshoot="emit('reshoot-scene', $event)"
            />

            <UiDisclosureButton v-model:open="addOpen" controls="showcase-add-scene" density="compact">
              {{ addOpen ? t('core.showcaseSkrytFormuStseny') : t('core.showcaseDobavitStsenu') }}
            </UiDisclosureButton>
            <div v-show="addOpen" id="showcase-add-scene">
              <ShowcaseSceneForm :screens="screens" :busy="busy" @add="emit('add-scene', $event)" />
            </div>
          </section>

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
        </template>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import StandLink from '../../shared/browser/StandLink.vue';
import { computed, reactive, ref, watch } from 'vue';

import {
  UiActionLink, UiButton, UiDisclosureButton, UiIconButton, UiInlineMessage, UiSpinner, UiVideo,
  vTooltip, t, uiLocale
} from '../../ui';
import { continuesPrevious } from '../../../../shared/plugins/showcase/showcaseChains';
import type {
  ShowcaseBuildRun,
  ShowcaseJob,
  ShowcaseProject,
  ShowcaseTargetOption,
  ShowcaseScene,
  ShowcaseStorySource,
  ShowcaseVoiceInfo,
} from '../../../../shared/plugins/showcase/showcaseContracts';
import { sceneStartsMs } from '../../../../shared/plugins/showcase/showcaseTimeline';
import type { ShowcaseFinalManifest } from '../../../../shared/plugins/showcase/showcaseTimeline';
import type { SeedStatus } from '../../actions/showcase';
import {
  SCRIPT_OUTDATED_TEXT,
  SOURCE_OUTDATED_TEXT,
  showcaseScriptOutdated,
  showcaseSourceOutdated,
} from '../../actions/showcase';
import ShowcaseBuildBar from './ShowcaseBuildBar.vue';
import ShowcaseSceneEditor from './ShowcaseSceneEditor.vue';
import ShowcaseSceneForm from './ShowcaseSceneForm.vue';
import ShowcaseScriptGaps from './ShowcaseScriptGaps.vue';
import ShowcaseSourcePanel from './ShowcaseSourcePanel.vue';
import ShowcaseStandPanel from './ShowcaseStandPanel.vue';
import ShowcaseStandPicker from './ShowcaseStandPicker.vue';
import ShowcaseTimeline from './ShowcaseTimeline.vue';
import {
  draftChanged,
  draftOf,
  payloadOf,
  reconcilePronunciationHashes,
} from './sceneDraft';
import { screenLabelOf, timecode } from './sceneText';
import type {
  SceneDraft,
  SceneNarrationPreviewInput,
  SceneTextPayload,
} from './sceneDraft';

type VoiceCapabilities = NonNullable<ShowcaseVoiceInfo['capabilities']>;

const props = defineProps<{
  project: ShowcaseProject;
  targets: ShowcaseTargetOption[];
  seed: SeedStatus | null;
  jobs: ShowcaseJob[];
  buildRun: ShowcaseBuildRun | null;
  manifest: ShowcaseFinalManifest | null;
  manifestStatus: 'idle' | 'loading' | 'ready' | 'failed';
  busy: boolean;
  // Разбор моделью идёт прямо сейчас: план ещё не готов, править нечего.
  analyzing: boolean;
  maxScenes: number;
  // Ссылка на стенд для человека; у песочницы её строит вид по хосту GrigDesk.
  targetUrl: string | null;
  artifactUrl: (artifactId: string) => string;
  voiceRef?: string | null;
  voiceCapabilities?: VoiceCapabilities | null;
  loadScenePreview?: (
    input: SceneNarrationPreviewInput,
    signal?: AbortSignal,
  ) => Promise<Blob>;
  // «О чём ролик»: список из живой истории стенда читает вид при открытии ролика.
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
  'reshoot-scene': [sceneId: string];
  'attach-target': [ref: { kind: 'project' | 'sandbox'; id: string }];
  // Выбор «О чём ролик» уходит виду: сохранить, затем снять или разобрать заново.
  'apply-source': [source: ShowcaseStorySource | null];
}>();

const selectedId = ref('');
const addOpen = ref(false);
const briefOpen = ref(false);
const sourceOpen = ref(false);
const player = ref<InstanceType<typeof UiVideo> | null>(null);
const rebuilding = computed(() => Boolean(
  props.buildRun && ['queued', 'running', 'cancelling'].includes(props.buildRun.state),
));

// Черновики текста по сценам. Живут здесь, а не в редакторе: переход к другой
// сцене не должен терять набранное, а список сцен показывает, где правки не
// сохранены.
const drafts = reactive(new Map<string, SceneDraft>());

const screens = computed(() => (
  props.project.target?.status === 'ready' ? props.project.target.scope.screens : []
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
  if (!props.project.ref) {
    return t('core.showcaseStendNeVybran');
  }

  if (props.project.target?.status !== 'ready') {
    return t('core.showcaseTselPokazaNedostupna');
  }

  const scope = props.project.target.scope;
  const environment = scope.environment === 'isolated-demo'
                ? t('core.showcaseDemoKopiya')
                : t('core.showcaseTolkoChtenie');

  return t('core.showcaseTargetlabelEnvironment', {
    targetLabel: scope.targetLabel,
    environment,
  });
});

const blockedReason = computed(() => (
  props.project.target?.status === 'blocked' ? props.project.target.reason : ''
));

const nextAction = computed(() => (
  props.project.target?.status === 'blocked' ? props.project.target.nextAction?.hint ?? '' : ''
));

const scriptOutdated = computed(() => showcaseScriptOutdated(props.project));

const sourceOutdated = computed(() => showcaseSourceOutdated(props.project));

const briefTitle = computed(() => (
  props.project.brief.length
    ? t('core.showcasePlanRolikaLengthP', { length: props.project.brief.length })
    : t('core.showcasePlanRolika')
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

  const built = new Date(final.builtAt).toLocaleString(uiLocale.value, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const duration = final.video.durationMs ? ` · ${timecode(final.video.durationMs)}` : '';

  return t('core.showcaseSobranBuiltDuration', { built, duration });
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
  return screenLabelOf(screens.value, scene);
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
 * Черновики фиксируются в той же форме, которую получит сервер. Субтитр может
 * следовать за репликой; нормализация позволяет watcher снять сохранённый draft.
 */
function prepareDrafts(): SceneTextPayload[] {
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

  return pending;
}

function build(): void {
  emit('build', prepareDrafts());
}

function generateBindings(): void {
  emit('generate-bindings', prepareDrafts());
}

// Вид сохраняет ввод перед подтверждённой адаптацией тем же путём, что сборка.
// Очистка drafts по любому серверному ответу запрещена: это потеряло бы ввод.
defineExpose({ prepareDrafts });



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
  container: showcase-film / inline-size;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.film__head {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--line);
}

.film__heading,
.film__title-row {
  min-width: 0;
}

.film__title-row,
.film__head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.film__title-row h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.02em;
  overflow-wrap: anywhere;
}

.film__title-row svg {
  width: 15px;
  height: 15px;
}

.film__target,
.film__note,
.film__meta {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.film__target {
  margin-top: 2px;
}

.film__workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 310px;
  align-items: start;
  gap: 20px;
  min-width: 0;
}

.film__setup {
  grid-column: 2;
  grid-row: 1;
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface);
}

.film__setup-head,
.film__block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.film__setup-head h3,
.film__block-head h3,
.film__manual h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.film__setup-head {
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}

.film__canvas {
  grid-column: 1;
  grid-row: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.film__analysis {
  padding: 32px 20px;
  border: 1px solid var(--line);
  border-radius: 6px;
}

.film__analysis-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
}

.film__analysis-copy {
  margin: 8px 0 0;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.6;
}

.film__empty {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
}

.film__empty-copy h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.film__empty-copy p {
  max-width: 440px;
  margin: 6px 0 0;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.6;
}

.film__manual {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 20px;
  border-top: 1px solid var(--line);
}

.film__final,
.film__scenes {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface);
}

.film__voice,
.film__source,
.film__brief {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding-top: 16px;
  border-top: 1px solid var(--line);
}

.film__stale {
  margin-right: 6px;
  color: var(--warn);
}

.film__downloads,
.film__phrase-list {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.film__phrases {
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: var(--ink-mid);
  font-size: 12px;
}

.film__brief-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.5;
}

.film--empty .film__workspace {
  display: flex;
  flex-direction: column;
}

.film--empty .film__setup {
  display: grid;
  grid-template-columns: minmax(0, 0.85fr) minmax(0, 1fr) minmax(0, 1.15fr);
  gap: 20px;
  width: 100%;
}

.film--empty .film__setup-head {
  grid-column: 1 / -1;
}

.film--empty .film__voice,
.film--empty .film__source {
  padding: 0 0 0 20px;
  border-top: 0;
  border-left: 1px solid var(--line);
}

.film--empty .film__canvas {
  width: 100%;
}

@container showcase-film (max-width: 960px) {
  .film__workspace {
    grid-template-columns: minmax(0, 1fr);
  }

  .film__setup,
  .film__canvas {
    grid-column: 1;
    grid-row: auto;
  }

  .film__setup {
    order: 2;
  }

  .film--empty .film__setup {
    order: 0;
    display: flex;
  }

  .film--empty .film__voice,
  .film--empty .film__source {
    padding: 16px 0 0;
    border-left: 0;
    border-top: 1px solid var(--line);
  }
}

@container showcase-film (max-width: 600px) {
  .film__head {
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }

  .film__head-actions {
    flex-wrap: wrap;
  }

  .film__setup,
  .film__scenes,
  .film__final {
    padding: 12px;
  }
}
</style>
