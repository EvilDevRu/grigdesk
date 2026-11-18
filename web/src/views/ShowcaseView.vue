<template>
  <UiWorkspacePage data-ui-workspace aria-labelledby="showcase-title">
    <template v-if="!store.opened" #title><h1 id="showcase-title">{{ t('core.navShowcase') }}</h1></template>
    <template v-if="!store.opened" #actions>
      <UiButton variant="solid" tone="accent" :loading="creating"
        data-testid="showcase-new-film" @click="createFree">
        <span aria-hidden="true">＋</span> {{ t('core.showcaseNovyyRolik') }}
      </UiButton>
      <UiIconButton :label="t('core.trackerUpdate')" data-context="workspace-toolbar"
        :loading="store.loading" @click="loadShowcase(store)">
        <UiRefreshIcon />
      </UiIconButton>
    </template>
    <h1 v-if="store.opened" id="showcase-title" class="ui-visually-hidden">{{ t('core.navShowcase') }}</h1>
    <div class="showcase" :class="{ 'showcase--film': store.opened }">
      <p v-if="!store.opened" class="ui-workspace-intro"> {{ t('core.showcaseRolikiOGotovoyRabote') }} </p>

      <UiInlineMessage v-if="store.error" tone="danger">{{ store.error }}</UiInlineMessage>

      <!-- Экран следует за состоянием ролика на сервере, а не за памятью вкладки:
         открытый ролик живёт в адресе, и после F5 человек видит его же. -->
      <ShowcaseFilm
        ref="film"
        v-if="store.opened"
        :project="store.opened"
        :targets="store.targets"
        :seed="seed"
        :jobs="store.jobsOf(store.opened.id)"
        :build-run="store.latestBuildOf(store.opened.id)"
        :manifest="store.currentManifest"
        :manifest-status="store.manifestStatus"
        :busy="store.isBusy(store.opened.id) || store.analyzing === store.opened.id || applyingSource || adapting"
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
        @apply-source="applySource"
        @attach-target="attachTarget"
        @reshoot-scene="reshootScene"
      >
        <template #voice>
          <ShowcaseVoicePanel
            mode="choice"
            :catalog="store.voices"
            :dictionary="store.dictionary"
            :busy="store.voiceBusy || store.isBusy(store.opened.id) || store.analyzing === store.opened.id || adapting"
            :voice-ref="projectVoiceRef"
            :pace="projectPace"
            :load-preview="loadShowcaseVoicePreview"
            @install="installVoice"
            @cancel="cancelVoiceInstall"
            @change="changeVoice"
            :can-adapt="store.opened.scenes.some((scene) => scene.audioSource.kind === 'tts')"
            @adapt="adaptNarration"
            @save-dictionary="saveDictionary"
          />
        </template>
      </ShowcaseFilm>

      <template v-else>
        <!-- Готовность установки показывается только когда она мешает: зелёный список
           «всё готово» ничего не решает, а красная строка называет, что чинить. -->
        <UiInlineMessage v-if="doctorBlockers.length" tone="warning">
          <span class="showcase__blockers">
            <strong>{{ t('core.showcaseZapisiMeshaet') }}</strong>
            <span v-for="operation in doctorBlockers" :key="operation.id">
              {{ operation.title }} — {{ operation.reason }}
            </span>
            <UiButton variant="ghost" @click="openSettings({ pageId: 'tools.showcase' })"> {{ t('core.showcaseOtkrytNastroyki') }} </UiButton>
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

        <section class="showcase__library" aria-labelledby="showcase-list-title">
          <div class="showcase__library-head">
            <div class="showcase__block-head">
              <h2 id="showcase-list-title">{{ t('core.showcaseRoliki') }}</h2>
              <span class="showcase__count">{{ store.projects.length }}</span>
            </div>
            <div v-if="store.projects.length" class="showcase__search">
              <UiSearchInput v-model="search" :aria-label="t('core.showcaseSearchFilms')"
                :placeholder="t('core.showcaseSearchFilms')" data-testid="showcase-search" />
            </div>
          </div>

          <div v-if="!store.projects.length" class="showcase__empty">
            <svg class="showcase__empty-icon" viewBox="0 0 48 48" fill="none"
              stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <rect x="7" y="10" width="34" height="28" rx="3" />
              <path d="m20 18 11 6-11 6z M7 16h34 M7 32h34 M14 10v6m10-6v6m10-6v6" />
            </svg>
            <strong>{{ store.loaded ? t('core.showcaseRolikovEscheNet') : t('core.showcaseChitaemSostoyanie') }}</strong>
            <p v-if="store.loaded">{{ t('core.showcaseCreateFirstHint') }}</p>
            <UiButton v-if="store.loaded" variant="solid" tone="accent" :loading="creating"
              @click="createFree">{{ t('core.showcaseNovyyRolik') }}</UiButton>
          </div>
          <div v-else-if="!visibleProjects.length" class="showcase__empty" role="status">
            <strong>{{ t('core.showcaseNoSearchResults') }}</strong>
            <UiButton variant="ghost" @click="search = ''">{{ t('core.clearSearch') }}</UiButton>
          </div>
          <div v-else class="showcase__list">
            <ShowcaseProjectRow
              v-for="project in visibleProjects"
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
    </div>
  </UiWorkspacePage>
</template>

<script setup lang="ts">
import { openSettings } from '../shared/settingsNavigation.ts';
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  UiButton, UiInlineMessage, UiIconButton, UiWorkspacePage, UiRefreshIcon, UiSearchInput,
  confirmDialog, promptDialog, t, messageRef,
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
  attachShowcaseTarget,
  showcaseProjectOwner,
  adaptShowcaseNarration,
  beginShowcaseNavigation,
  captureShowcaseNavigation,
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
  reshootShowcaseScene,
  saveShowcaseDictionary,
  saveShowcaseSource,
  setShowcaseVoice,
  updateShowcaseScene,
  useShowcaseStore,
  watchShowcase,
} from '../actions/showcase';
import { useUiContextSource } from '../composables/useUiContextSource.ts';
import { sandboxUrl } from '../shared/sandbox.ts';
import { showcaseApi } from '../shared/showcaseApi';
import type { SeedStatus, ShowcaseVoiceChoice } from '../actions/showcase';
import type {
  ShowcaseDoctor,
  ShowcaseSelectableTargetRef,
  ShowcaseStorySource,
} from '../../../shared/plugins/showcase/showcaseContracts';
import ShowcaseFilm from './showcase/ShowcaseFilm.vue';
import ShowcaseProjectRow from './showcase/ShowcaseProjectRow.vue';
import ShowcaseVoicePanel from './showcase/ShowcaseVoicePanel.vue';
import type { SceneTextPayload } from './showcase/sceneDraft';

const store = useShowcaseStore();
const route = useRoute();
const router = useRouter();
const showcaseContext = useUiContextSource('showcase', { layer: 'page', active: false });

const creating = ref(false);
const search = ref('');
const visibleProjects = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();

  return store.projects.filter((project) => (
    `${project.title} ${project.targetLabel ?? ''}`.toLocaleLowerCase().includes(query)
  ));
});
const doctor = ref<ShowcaseDoctor | null>(null);
const seed = ref<SeedStatus | null>(null);
let seedRequest = 0;
const selectedSceneId = ref('');
// «О чём ролик»: живая история репозиториев открытого ролика и её отказ — у блока.
// Цепочка «подтверждение → сохранение → разбор или сборка» одна на вид: повторный клик
// не запускает вторую, пока идёт первая.
const applyingSource = ref(false);
// Билет чтения списка: поздний ответ прежнего запроса не меняет ни список, ни подпись.

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
  store.opened?.voiceRef
    ?? store.opened?.scenes.find((scene) => scene.audioSource.kind === 'tts')?.audioSource.voiceRef
    ?? null
));

const projectPace = computed(() => store.opened?.pace ?? store.opened?.scenes[0]?.direction.pace ?? null);

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
// наружу идёт только порт из каталога целей, и адрес строится по хосту GrigDesk.
const openedTargetUrl = computed(() => {
  const opened = store.opened;

  if (!opened || opened.target?.status !== 'ready') {
    return null;
  }

  if (opened.target.scope.viewUrl) {
    return opened.target.scope.viewUrl;
  }

  const option = store.targets.find((target) => (
    target.ref.kind === opened.ref?.kind && target.ref.id === opened.ref?.id
  ));

  return option ? sandboxUrl(option.viewPort, option.serviceHost) : null;
});

let stopWatching: (() => void) | null = null;
let mounted = false;

// Ролик, перечитанный с сервера в ЭТОМ монтировании. Память стора переживает уход в
// другой раздел, а подписка на события — нет: сцены, звук и запись, опубликованные
// сборкой за это время, в снимке стора отсутствуют, и по возвращении человек видел
// «Сцен пока нет» над идущей по восьми сценам сборкой.
let refreshedId = '';

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
  const current = beginShowcaseNavigation(store);

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

  const known = store.opened?.id === id;

  if (known && refreshedId === id) {
    return;
  }

  refreshedId = id;

  // Известный ролик при неудаче остаётся на экране с ошибкой: уводить к списку
  // есть смысл только когда показывать нечего.
  const loaded = await openShowcaseProject(store, id, current);

  if (!current()) {
    return;
  }

  if (!loaded && !known) {
    refreshedId = '';
    await router.replace('/showcase');
  }
}, { immediate: true });

// Доступность подготовки данных зависит от ЖИВОГО состояния стенда, поэтому она
// спрашивается при появлении карточки, а не хранится в записи ролика: вчерашняя
// доступность сегодня уже ничего не значит.
watch(() => {
  const project = store.opened;
  const scope = project?.target?.status === 'ready' ? project.target.scope : null;

  return JSON.stringify([
    project?.id, project?.ref?.kind, project?.ref?.id,
    scope?.profile, scope?.targetFingerprint, scope?.dataRevision,
  ]);
}, () => {
  seed.value = null;
  void refreshSeedStatus();
}, { immediate: true });

/**
 * Готовность данных принадлежит карточке и последнему запросу этой карточки.
 * Поздний null старого owner не должен стереть уже загруженный статус нового.
 */
async function refreshSeedStatus() {
  const request = ++seedRequest;
  const id = store.opened?.id;

  if (!id) {
    seed.value = null;

    return;
  }

  const current = showcaseProjectOwner(store, id);
  const status = await loadSeedStatus(store);

  if (current() && request === seedRequest) {
    seed.value = status;
  }
}

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
  beginShowcaseNavigation(store);
  stopWatching?.();
  stopWatching = null;
});

/**
 * Ролик создаётся свободно и открывается, пока человек не выбрал другой маршрут.
 * Уже созданная сервером запись остаётся в списке при уходе во время запроса.
 */
async function createFree(): Promise<void> {
  const current = captureShowcaseNavigation(store);

  creating.value = true;

  try {
    const id = await createShowcaseProject(store, {});

    if (id && current()) {
      await router.replace(`/showcase/${id}`);
    }
  } finally {
    creating.value = false;
  }
}



/**
 * Повторный разбор ЗАМЕНЯЕТ сцены, а вместе с ними уходят и правки текста, поэтому
 * при живых сценах спрашиваем; голос и темп остаются.
 */
async function confirmReanalyze(): Promise<boolean> {
  if (!store.opened?.scenes.length) {
    return true;
  }

  return confirmDialog(
    messageRef('core.showcaseRazobratZanovoStsenyZamenyatsya'),
    {
      title: t('core.showcasePovtornyyRazbor'),
      okText: t('core.showcaseRazobrat'),
    },
  );
}

async function analyze() {
  if (await confirmReanalyze()) {
    await analyzeShowcase(store);
  }
}



/**
 * «О чём ролик»: выбор сохраняется, затем ролик без сцен снимается целиком, а ролик со
 * сценами разбирается заново — с тем же вопросом, что и у «Разобрать заново». Ролик и
 * его редакция захватываются до вопроса: сменился ролик за время подтверждения —
 * выбор не применяется, а следующий шаг идёт только после успешного сохранения.
 */
async function applySource(source: ShowcaseStorySource | null) {
  const opened = store.opened;

  if (!opened || applyingSource.value) {
    return;
  }

  const { id, revision } = opened;
  const hasScenes = opened.scenes.length > 0;

  applyingSource.value = true;

  try {
    if (!await confirmReanalyze()) {
      return;
    }

    if (store.opened?.id !== id || store.opened.revision !== revision) {
      store.setError(t('core.showcaseChangedWhileConfirming'));

      return;
    }

    const saved = await saveShowcaseSource(store, {
      id,
      revision,
      source,
    });

    if (!saved || store.opened?.id !== id) {
      return;
    }

    await (hasScenes ? analyzeShowcase(store) : buildShowcaseFilm(store));
  } finally {
    applyingSource.value = false;
  }
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
    title: t('core.showcaseNazvanieRolika'),
      multiline: false,
    value: opened.title,
    okText: t('core.save'),
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
    messageRef('core.showcaseUdalitRolikTitleVmeste', { title }),
    {
      title: t('core.showcaseUdalenieRolika'),
      okText: t('core.taskDelete'),
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

/**
 * Пересъёмка передаёт сцену текущего ролика и сохраняет общий owner действия.
 * Цепочку продолжений выбирает сервер, вид её не разделяет.
 */
/**
 * Подключение захватывает ролик и его revision до сети, поздним ответом владеет action.
 * Вид не дописывает безусловную ошибку поверх другой открытой карточки.
 */
async function attachTarget(ref: ShowcaseSelectableTargetRef) {
  const opened = store.opened;

  if (opened) {
    await attachShowcaseTarget(store, opened.id, opened.revision, ref);
  }
}

async function reshootScene(sceneId: string) {
  if (store.opened) {
    await reshootShowcaseScene(store, store.opened.id, sceneId);
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
  const current = showcaseProjectOwner(store, store.opened?.id ?? null);
  const accepted = await confirmDialog(
    messageRef('core.showcaseZapustitPodgotovkuDannyhNa', {
      targetLabel: seed.value?.targetLabel ?? '',
      profile: seed.value?.profile ?? '',
    }),
    {
      title: t('core.showcasePodgotovkaDemoDannyh'),
      okText: t('core.showcasePodgotovit'),
      danger: true,
    },
  );

  if (!accepted || !current()) {
    return;
  }

  await prepareShowcaseData(store, recipeFingerprint);

  if (current()) {
    await refreshSeedStatus();
  }
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
    messageRef('core.showcaseUdalitStsenuTitlesceneidVmeste', { titlesceneId: scene?.title ?? sceneId }),
    {
      title: t('core.showcaseUdalenieStseny'),
      okText: t('core.taskDelete'),
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

const film = ref<InstanceType<typeof ShowcaseFilm> | null>(null);
const adaptationRequests = reactive(new Map<string, symbol>());
const adapting = computed(() => Boolean(
  store.opened && adaptationRequests.has(store.opened.id),
));

/**
 * Подтверждение относится к ролику и эпохе навигации. Action проверяет владельца
 * внутри success/error/reload, поэтому поздний save не может сам вернуть старый id.
 */
async function adaptNarration(): Promise<void> {
  const opened = store.opened;

  if (!opened || adaptationRequests.has(opened.id)) {
    return;
  }

  const token = Symbol('adapt');
  const current = showcaseProjectOwner(store, opened.id);

  adaptationRequests.set(opened.id, token);

  try {
    const accepted = await confirmDialog(
      messageRef('core.showcaseAdaptirovatReplikiPodNovyy'),
      { okText: t('core.showcasePerepisatReplikiPodGolos') },
    );

    if (!accepted || !current()) {
      return;
    }

    const pending = film.value?.prepareDrafts() ?? [];

    for (const payload of pending) {
      const { id, ...patch } = payload;

      if (!current() || !await updateShowcaseScene(store, id, patch, current)) {
        return;
      }
    }

    // Канонический title совпадает с серверным trim/fallback. Watcher снимает
    // подтверждённые drafts до нового текста; ошибка сохранения сюда не проходит.
    await nextTick();

    if (current()) {
      await adaptShowcaseNarration(store, opened.id, current);
    }
  } finally {
    if (adaptationRequests.get(opened.id) === token) {
      adaptationRequests.delete(opened.id);
    }
  }
}

/**
 * Голос сохраняется только в карточку владельца ответа. Уход в другой ролик
 * останавливает предложение модели, а смена только темпа адаптации не требует.
 */
async function changeVoice(choice: ShowcaseVoiceChoice): Promise<void> {
  const projectId = store.opened?.id;
  const current = showcaseProjectOwner(store, projectId ?? null);
  const previousEngine = effectiveVoiceRef.value?.split(':')[0];
  const saved = await setShowcaseVoice(store, choice, current);
  const opened = store.opened;

  if (
    saved
    && opened
    && current()
    && previousEngine !== effectiveVoiceRef.value?.split(':')[0]
    && opened.scenes.some((scene) => scene.audioSource.kind === 'tts')
  ) {
    await adaptNarration();
  }
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
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.showcase__library {
  min-width: 0;
}

.showcase__library-head,
.showcase__block-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.showcase__library-head {
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}

.showcase__block-head h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.showcase__count {
  color: var(--ink-mid);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.showcase__search {
  flex: 0 1 300px;
  min-width: 0;
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
  align-items: center;
  gap: 12px;
  padding: 64px 20px;
  text-align: center;
}

.showcase__empty-icon {
  width: 48px;
  height: 48px;
  margin-bottom: 4px;
  color: var(--ink-low);
}

.showcase__empty strong {
  font-size: 16px;
  font-weight: 600;
}

.showcase__empty p {
  max-width: 360px;
  margin: 0 0 8px;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.6;
}

.showcase__list {
  display: grid;
  gap: 1px;
  padding-top: 6px;
}

@media (max-width: 600px) {
  .showcase__search {
    flex-basis: 100%;
  }

  .showcase__empty {
    padding: 40px 12px;
  }
}
</style>
