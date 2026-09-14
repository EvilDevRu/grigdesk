<template>
  <section class="showcase" :class="{ 'showcase--film': store.opened }" aria-labelledby="showcase-title">
    <header v-if="!store.opened" class="showcase__head">
      <div class="showcase__intro">
        <h1 id="showcase-title">Презентации</h1>
        <p>
          Короткий ролик о готовой задаче: выберите стенд, проверьте сцены и голос —
          и получите mp4 с озвучкой и субтитрами.
        </p>
      </div>
      <UiButton
        class="showcase__refresh"
        variant="ghost"
        :loading="store.loading"
        @click="loadShowcase(store)"
      >
        Обновить
      </UiButton>
    </header>
    <h1 v-else id="showcase-title" class="ui-visually-hidden">Презентации</h1>

    <UiInlineMessage v-if="store.error" tone="danger">{{ store.error }}</UiInlineMessage>

    <!-- Экран следует за состоянием ролика на сервере, а не за памятью вкладки:
         открытый ролик живёт в адресе, и после F5 человек видит его же. -->
    <ShowcaseFilm
      v-if="store.opened"
      :project="store.opened"
      :seed="seed"
      :jobs="store.jobsOf(store.opened.id)"
      :build-run="store.latestBuildOf(store.opened.id)"
      :manifest="store.currentManifest"
      :manifest-status="store.manifestStatus"
      :busy="store.isBusy(store.opened.id) || store.analyzing === store.opened.id"
      :analyzing="store.analyzing === store.opened.id"
      :max-scenes="store.limits.maxScenes"
      :target-url="openedTargetUrl"
      :artifact-url="artifactUrl"
      :voice-ref="effectiveVoiceRef"
      :voice-capabilities="effectiveVoiceCapabilities"
      :load-scene-preview="loadShowcaseNarrationPreview"
      @close="close"
      @build="build"
      @generate-bindings="generateBindings"
      @analyze="analyze"
      @rename="rename"
      @remove-project="remove(store.opened.id)"
      @seed="prepareData"
      @data-updated="markDataUpdated"
      @cancel="cancel"
      @cancel-build="cancelBuild"
      @add-scene="addScene"
      @save-scene="saveScene"
      @remove-scene="removeScene"
      @move-scene="moveScene"
      @scene-continues="setSceneContinues"
      @scene-audio="uploadAudio"
      @select-scene="selectedSceneId = $event"
    >
      <template #voice>
        <ShowcaseVoicePanel
          mode="choice"
          :catalog="store.voices"
          :dictionary="store.dictionary"
          :busy="store.voiceBusy || store.isBusy(store.opened.id) || store.analyzing === store.opened.id"
          :voice-ref="projectVoiceRef"
          :pace="projectPace"
          :load-preview="loadShowcaseVoicePreview"
          @install="installVoice"
          @cancel="cancelVoiceInstall"
          @change="changeVoice"
          @save-dictionary="saveDictionary"
        />
      </template>
    </ShowcaseFilm>

    <template v-else>
      <section class="showcase__panel" aria-labelledby="showcase-create-title">
        <div class="showcase__panel-head">
          <h2 id="showcase-create-title">Новый ролик</h2>
          <p>Выберите стенд, о котором рассказать: адрес и профиль подставятся сами.</p>
        </div>
        <ShowcaseTargetPicker
          :targets="store.targets"
          :projects="store.projects"
          :busy="creating"
          :loaded="store.loaded"
          :loading="store.loading"
          :error="store.error"
          @create="create"
          @open="open"
        />
      </section>

      <!-- Готовность установки показывается только когда она мешает: зелёный список
           «всё готово» ничего не решает, а красная строка называет, что чинить. -->
      <UiInlineMessage v-if="doctorBlockers.length" tone="warning">
        <span class="showcase__blockers">
          <strong>Записи мешает:</strong>
          <span v-for="operation in doctorBlockers" :key="operation.id">
            {{ operation.title }} — {{ operation.reason }}
          </span>
          <UiActionLink href="#/settings" variant="ghost">Открыть настройки</UiActionLink>
        </span>
      </UiInlineMessage>

      <ShowcaseVoicePanel
        v-if="store.voices && !voiceReady"
        mode="setup"
        :catalog="store.voices"
        :busy="store.voiceBusy"
        @install="installVoice"
        @cancel="cancelVoiceInstall"
      />

      <section class="showcase__block" aria-labelledby="showcase-list-title">
        <div class="showcase__block-head">
          <h2 id="showcase-list-title">Ролики</h2>
          <span v-if="store.projects.length" class="showcase__count">
            {{ store.projects.length }}
          </span>
        </div>

        <div v-if="!store.projects.length" class="showcase__empty">
          <strong>{{ store.loaded ? 'Роликов ещё нет' : 'Читаем состояние…' }}</strong>
          <p v-if="store.loaded">
            Нажмите «Снять ролик» у стенда: разбор задачи и сцены появятся здесь.
          </p>
        </div>
        <div v-else class="showcase__list">
          <ShowcaseProjectRow
            v-for="project in store.projects"
            :key="project.id"
            :project="project"
            :jobs="store.jobsOf(project.id)"
            :busy="store.isBusy(project.id)"
            @open="open"
            @remove="remove"
            @cancel="cancel"
          />
        </div>
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  UiActionLink,
  UiButton,
  UiInlineMessage,
  confirmDialog,
  promptDialog,
} from '../ui';
import {
  addShowcaseScene,
  analyzeShowcase,
  buildShowcaseFilm,
  cancelShowcaseBuild,
  cancelShowcaseJob,
  cancelShowcaseVoiceInstall,
  closeShowcaseProject,
  createShowcaseProject,
  deleteShowcaseProject,
  generateShowcaseBindings,
  importShowcaseAudio,
  installShowcaseVoice,
  loadSeedStatus,
  loadShowcase,
  loadShowcaseDictionary,
  loadShowcaseManifest,
  loadShowcaseNarrationPreview,
  loadShowcaseVoicePreview,
  loadShowcaseVoices,
  markShowcaseDataUpdated,
  openShowcaseProject,
  prepareShowcaseData,
  removeShowcaseScene,
  renameShowcaseProject,
  reorderShowcaseScenes,
  saveShowcaseDictionary,
  setShowcaseVoice,
  updateShowcaseScene,
  useShowcaseStore,
  watchShowcase,
} from '../actions/showcase';
import { useUiContextSource } from '../composables/useUiContextSource.ts';
import { sandboxUrl } from '../shared/sandbox.js';
import { showcaseApi } from '../shared/showcaseApi';
import type { SeedStatus, ShowcaseVoiceChoice } from '../actions/showcase';
import type { ShowcaseDoctor, ShowcaseSelectableTargetRef } from '../../../shared/showcaseContracts';
import ShowcaseFilm from './showcase/ShowcaseFilm.vue';
import ShowcaseProjectRow from './showcase/ShowcaseProjectRow.vue';
import ShowcaseTargetPicker from './showcase/ShowcaseTargetPicker.vue';
import ShowcaseVoicePanel from './showcase/ShowcaseVoicePanel.vue';
import type { SceneTextPayload } from './showcase/sceneDraft';

const store = useShowcaseStore();
const route = useRoute();
const router = useRouter();
const showcaseContext = useUiContextSource('showcase', { layer: 'page', active: false });

const creating = ref(false);
const doctor = ref<ShowcaseDoctor | null>(null);
const seed = ref<SeedStatus | null>(null);
const selectedSceneId = ref('');

// Без этого записи не будет вовсе. Голос и распознавание сюда не входят: без
// голоса остаётся свой звук, а проверка речи рекомендательная.
const BLOCKING_OPERATIONS = new Set(['browser', 'media', 'storage']);

const doctorBlockers = computed(() => (doctor.value?.operations ?? []).filter((operation) => (
  BLOCKING_OPERATIONS.has(operation.id) && operation.status === 'blocked'
)));

// Готовый движок есть — установка голосов со списка уходит: ставить другие
// голоса можно с экрана ролика, где их и выбирают.
const voiceReady = computed(() => (
  Boolean(store.voices?.engines.some((engine) => engine.doctor.status === 'ready'))
));

// Голос и темп ролика — у его сцен: первая синтезируемая сцена говорит за все,
// потому что сервер меняет их только разом.
const projectVoiceRef = computed(() => (
  store.opened?.scenes.find((scene) => scene.audioSource.kind === 'tts')?.audioSource.voiceRef
    ?? null
));

const projectPace = computed(() => store.opened?.scenes[0]?.direction.pace ?? null);

const firstAvailableVoiceRef = computed(() => {
  for (const engine of store.voices?.engines ?? []) {
    const voice = engine.voices.find((item) => item.available);

    if (voice) {
      return `${engine.id}:${voice.id}`;
    }
  }

  return null;
});

// Если сцены ещё не закрепили голос, это ровно тот первый доступный голос,
// который выберет backend. Сохранённый, но недоступный голос не подменяется.
const effectiveVoiceRef = computed(() => projectVoiceRef.value ?? firstAvailableVoiceRef.value);

const effectiveVoiceCapabilities = computed(() => {
  const [engineId, voiceId] = effectiveVoiceRef.value?.split(':') ?? [];
  const engine = store.voices?.engines.find((item) => item.id === engineId);

  return engine?.voices.find((voice) => voice.id === voiceId)?.capabilities;
});

// Ссылка на стенд открытого ролика. Постоянный стенд публикует её сам; у песочницы
// наружу идёт только порт из каталога целей, и адрес строится по хосту кокпита.
const openedTargetUrl = computed(() => {
  const opened = store.opened;

  if (!opened || opened.target.status !== 'ready') {
    return null;
  }

  if (opened.target.scope.viewUrl) {
    return opened.target.scope.viewUrl;
  }

  const option = store.targets.find((target) => (
    target.ref.kind === opened.ref.kind && target.ref.id === opened.ref.id
  ));

  return option ? sandboxUrl(option.viewPort) : null;
});

let stopWatching: (() => void) | null = null;
let mounted = false;

onMounted(() => {
  stopWatching = watchShowcase(store);
  void loadShowcase(store);
  void loadShowcaseVoices(store);
  void loadShowcaseDictionary(store);
  void check();
  mounted = true;
});

/**
 * Адрес — источник правды о том, какой ролик открыт: F5 и кнопка «назад» ведут
 * туда же, куда и клик. На свежем монтировании без адреса открытый ролик
 * возвращается в адрес: человек ушёл в другой раздел и вернулся к той же работе.
 * Позже пустой адрес означает «к списку» — так работает «назад» в браузере.
 */
watch(() => String(route.params.id ?? ''), async (id) => {
  if (!id) {
    if (store.opened && !mounted) {
      await router.replace(`/showcase/${store.opened.id}`);

      return;
    }

    if (store.opened) {
      closeShowcaseProject(store);
      void loadShowcase(store);
    }

    return;
  }

  if (store.opened?.id === id) {
    return;
  }

  if (!await openShowcaseProject(store, id)) {
    await router.replace('/showcase');
  }
}, { immediate: true });

// Доступность подготовки данных зависит от ЖИВОГО состояния стенда, поэтому она
// спрашивается при появлении карточки, а не хранится в записи ролика: вчерашняя
// доступность сегодня уже ничего не значит.
watch(() => store.opened?.id, async (id) => {
  seed.value = id ? await loadSeedStatus(store) : null;
}, { immediate: true });

// Manifest относится к конкретному immutable final. Смена project/revision без
// смены этой пары повторного чтения не запускает, а новый final загружается сам.
watch(() => {
  const opened = store.opened;
  const final = opened?.latestFinal;

  return final?.manifestVersion === 1 ? `${opened?.id}:${final.manifestId}` : '';
}, (key) => {
  if (key) {
    void loadShowcaseManifest(store);
  }
}, { immediate: true });

// Агент в чате знает, какой ролик и какая сцена перед человеком: «эта сцена»
// в вопросе разрешается без пересказа названия.
watch([() => store.opened?.id, () => store.opened?.title, selectedSceneId], ([id, title, sceneId]) => {
  if (!id) {
    showcaseContext.blur({ details: null });

    return;
  }

  showcaseContext.focus({
    details: {
      projectId: id,
      title: title ?? '',
      sceneId: sceneId || null,
    },
  });
}, { immediate: true });

// Подписка снимается вместе с экраном: выключенный плагин и уход со страницы не
// должны оставлять слушателя, который продолжит писать в состояние раздела.
onUnmounted(() => {
  stopWatching?.();
  stopWatching = null;
});

/**
 * «Снять ролик»: ролик заводится и одним POST уходит в полный backend-run. Вкладка
 * дальше только показывает сохранённый прогресс; закрытие страницы судьбу запуска
 * не меняет.
 */
async function create(payload: { ref: ShowcaseSelectableTargetRef }) {
  creating.value = true;

  try {
    const id = await createShowcaseProject(store, { ref: payload.ref });

    if (!id) {
      return;
    }

    await router.replace(`/showcase/${id}`);
    await buildShowcaseFilm(store);
  } finally {
    creating.value = false;
  }
}

/**
 * Разбор стенда заново. Новый сценарий ЗАМЕНЯЕТ сцены, а вместе с ними уходят и
 * правки текста, поэтому при живых сценах спрашиваем; голос и темп остаются.
 */
async function analyze() {
  if (store.opened?.scenes.length) {
    const accepted = await confirmDialog(
      'Разобрать заново? Сцены заменятся новым сценарием, и правки текста в них пропадут. '
        + 'Голос и темп ролика сохранятся.',
      {
        title: 'Повторный разбор',
        okText: 'Разобрать',
      },
    );

    if (!accepted) {
      return;
    }
  }

  await analyzeShowcase(store);
}

/**
 * Сборка ролика целиком: несохранённые правки сцен уходят первыми, затем запись,
 * озвучка и mp4 одной командой. Не сохранившаяся правка останавливает сборку —
 * снимать экраны под старый текст значило бы выдать человеку не его ролик.
 */
async function build(pending: SceneTextPayload[]) {
  for (const payload of pending) {
    const { id, ...patch } = payload;

    if (!await updateShowcaseScene(store, id, patch)) {
      return;
    }
  }

  await buildShowcaseFilm(store);
}

/**
 * Модель видит только уже сохранённую редакцию. Конфликт любого черновика
 * останавливает операцию, оставляет ввод в редакторе и не строит связи по старому
 * тексту.
 */
async function generateBindings(pending: SceneTextPayload[]) {
  for (const payload of pending) {
    const { id, ...patch } = payload;

    if (!await updateShowcaseScene(store, id, patch)) {
      return;
    }
  }

  await generateShowcaseBindings(store);
}

/**
 * Переименование: имя ролика сервер даёт по стенду, но человек вправе назвать
 * его по фиче. Пустой ответ и отмена ничего не меняют.
 */
async function rename() {
  const opened = store.opened;

  if (!opened) {
    return;
  }

  const title = await promptDialog({
    title: 'Название ролика',
    value: opened.title,
    okText: 'Сохранить',
  });

  if (title === null) {
    return;
  }

  await renameShowcaseProject(store, title);
}

/**
 * Удаление необратимо и уносит записанные клипы, звук и собранный ролик, поэтому
 * спрашиваем всегда: восстановить их можно только повторной записью, а она занимает
 * то же время, что и первая.
 */
async function remove(id: string) {
  const project = store.projects.find((item) => item.id === id);
  const title = project?.title ?? store.opened?.title ?? id;
  const accepted = await confirmDialog(
    `Удалить ролик «${title}»?\n\n`
      + 'Вместе с записью будут удалены её сцены, звук и собранный файл. '
      + 'Идущие задания сначала отменяются.',
    {
      title: 'Удаление ролика',
      okText: 'Удалить',
      danger: true,
    },
  );

  if (!accepted) {
    return;
  }

  const wasOpened = store.opened?.id === id;

  if (await deleteShowcaseProject(store, id) && wasOpened) {
    await router.replace('/showcase');
  }
}

async function cancel(jobId: string) {
  await cancelShowcaseJob(store, jobId);
}

async function cancelBuild(runId: string) {
  await cancelShowcaseBuild(store, runId);
}

// Открытие идёт через адрес: ролик читает наблюдатель маршрута, и клик по строке
// ничем не отличается от ссылки или F5.
async function open(id: string) {
  await router.replace(`/showcase/${id}`);
}

/**
 * Подготовка данных меняет стенд, поэтому спрашиваем всегда и называем в вопросе
 * ровно то, что будет запущено: рецепт профиля на конкретном стенде.
 */
async function prepareData(recipeFingerprint: string) {
  const accepted = await confirmDialog(
    `Запустить подготовку данных на цели «${seed.value?.targetLabel ?? ''}»?\n\n`
      + `Рецепт профиля «${seed.value?.profile ?? ''}» изменит данные стенда. `
      + 'После этого все записанные сцены устареют и их придётся снять заново.',
    {
      title: 'Подготовка демо-данных',
      okText: 'Подготовить',
      danger: true,
    },
  );

  if (!accepted) {
    return;
  }

  await prepareShowcaseData(store, recipeFingerprint);
  seed.value = await loadSeedStatus(store);
}

async function markDataUpdated() {
  await markShowcaseDataUpdated(store);
}

// «К списку»: карточка закрывается, список перечитывается — пока она была открыта,
// роликов могло стать больше или меньше, — а адрес возвращается к разделу.
function close() {
  seed.value = null;
  closeShowcaseProject(store);
  void loadShowcase(store);
  void router.replace('/showcase');
}

async function addScene(payload: { screenId: string; narration: string }) {
  await addShowcaseScene(store, {
    title: '',
    screenId: payload.screenId,
    narration: payload.narration,
    caption: '',
    subtitleText: payload.narration,
    actions: [],
  });
}

async function saveScene(payload: SceneTextPayload) {
  const { id, ...patch } = payload;

  await updateShowcaseScene(store, id, patch);
}

// Начало сцены уходит отдельной правкой: это решение о записи, а не текст, и ждать
// кнопки «Сохранить» вместе с черновиком озвучки ему незачем.
async function setSceneContinues(payload: { id: string; value: boolean }) {
  await updateShowcaseScene(store, payload.id, { continuesPrevious: payload.value });
}

/**
 * Удаление сцены необратимо уносит её звук и запись, поэтому спрашиваем: собрать
 * их заново стоит столько же, сколько в первый раз.
 */
async function removeScene(sceneId: string) {
  const scene = store.opened?.scenes.find((item) => item.id === sceneId);
  const accepted = await confirmDialog(
    `Удалить сцену «${scene?.title ?? sceneId}»?\n\n`
      + 'Вместе со сценой удалятся её звук и запись экрана.',
    {
      title: 'Удаление сцены',
      okText: 'Удалить',
      danger: true,
    },
  );

  if (!accepted) {
    return;
  }

  await removeShowcaseScene(store, sceneId);
}

/**
 * Перестановка соседей. Порядок уходит полным списком: сервер отказывается
 * достраивать частичный, и это правильно — достроенный порядок означал бы ролик,
 * собранный не так, как виделось человеку.
 */
async function moveScene(payload: { id: string; delta: number }) {
  const opened = store.opened;

  if (!opened) {
    return;
  }

  const order = [...opened.scenes]
    .sort((left, right) => left.order - right.order)
    .map((scene) => scene.id);
  const from = order.indexOf(payload.id);
  const to = from + payload.delta;

  if (from < 0 || to < 0 || to >= order.length) {
    return;
  }

  const moved = order[from] as string;

  order.splice(from, 1);
  order.splice(to, 0, moved);

  await reorderShowcaseScenes(store, order);
}

async function uploadAudio(payload: { id: string; file: File }) {
  await importShowcaseAudio(store, payload.id, payload.file);
}

/**
 * Установка голоса. Подтверждения не спрашиваем: размер и лицензия названы прямо
 * на кнопке, а сама установка обратима — отмена рядом, скачанное лежит в каталоге
 * раздела.
 */
async function installVoice(voiceId: string) {
  await installShowcaseVoice(store, voiceId);
}

async function cancelVoiceInstall() {
  await cancelShowcaseVoiceInstall(store);
}

async function changeVoice(choice: ShowcaseVoiceChoice) {
  await setShowcaseVoice(store, choice);
}

async function saveDictionary(text: string) {
  await saveShowcaseDictionary(store, text);
}

function artifactUrl(artifactId: string): string {
  return store.opened ? showcaseApi.artifactUrl(store.opened.id, artifactId) : '';
}

/**
 * Готовность спрашивается без цели: так видно общее состояние установки — браузер,
 * ffmpeg, хранилище. Отказ проверки не становится ошибкой раздела: она справочная,
 * и красная полоса из-за неё мешала бы завести ролик.
 */
async function check() {
  try {
    doctor.value = await showcaseApi.doctor(null);
  } catch {
    doctor.value = null;
  }
}
</script>

<style scoped>
.showcase {
  width: min(100%, 1160px);
  margin-inline: auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
}

.showcase__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
}

.showcase__intro {
  min-width: 0;
}

.showcase__intro h1 {
  margin: 0;
  font-size: 24px;
  line-height: 1.2;
  letter-spacing: -0.03em;
}

.showcase__intro p {
  max-width: 620px;
  margin: 6px 0 0;
  color: var(--ink-mid);
  font-size: 13.5px;
  line-height: 1.5;
}

.showcase__refresh {
  flex: none;
}

.showcase__panel,
.showcase__block {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.showcase__panel {
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 15px;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--surface) 96%, #fff) 0%,
    var(--surface) 100%
  );
  box-shadow: inset 0 1px 0 #ffffff08;
}

.showcase__panel-head h2,
.showcase__block-head h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 660;
  letter-spacing: -0.01em;
}

.showcase__panel-head p {
  margin: 4px 0 0;
  color: var(--ink-mid);
  font-size: 12.5px;
  line-height: 1.45;
}

.showcase__block-head {
  display: flex;
  align-items: center;
  gap: 9px;
}

.showcase__count {
  display: inline-flex;
  min-width: 23px;
  min-height: 21px;
  align-items: center;
  justify-content: center;
  padding-inline: 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.showcase__blockers {
  display: flex;
  align-items: center;
  gap: 6px 12px;
  flex-wrap: wrap;
}

.showcase__empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 18px 20px;
  border: 1px dashed var(--line-2);
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface-2) 28%, transparent);
}

.showcase__empty strong {
  font-size: 14px;
}

.showcase__empty p {
  max-width: 520px;
  margin: 0;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.5;
}

.showcase__list {
  display: grid;
  gap: 8px;
}

@media (max-width: 720px) {
  .showcase__head {
    flex-direction: column;
    gap: 12px;
  }

  .showcase__panel {
    padding: 15px;
  }
}
</style>
