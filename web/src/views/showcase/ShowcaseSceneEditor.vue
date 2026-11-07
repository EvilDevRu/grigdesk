<template>
  <section class="scene" :data-stale="scene.stale ? 'yes' : 'no'" aria-labelledby="showcase-scene-title">
    <header class="scene__head">
      <div class="scene__heading">
        <p class="scene__kicker">Сцена {{ index }} из {{ total }}</p>
        <h3 id="showcase-scene-title">{{ scene.title || `Сцена ${index}` }}</h3>
      </div>
      <span class="scene__state" :data-tone="state.tone">{{ state.label }}</span>
    </header>

    <!-- Что запись покажет на экране. Действия задаёт карта профиля через разбор:
         править их руками здесь нельзя, но видеть — обязательно. -->
    <p class="scene__plan" :data-static="actions ? 'no' : 'yes'">
      <span v-if="continues" class="scene__plan-chain">{{ CONTINUATION_LABEL }}</span>
      <span class="scene__plan-screen">{{ screenTitle }}</span>
      <span>{{ actions || 'без действий — неподвижный экран' }}</span>
    </p>

    <!-- Откуда сцена начинается: со своего экрана или там, где закончилась
         предыдущая. Это решение о записи, а не текст, поэтому уходит сразу, без
         черновика и кнопки «Сохранить». -->
    <div class="scene__start">
      <UiSwitch
        :model-value="continues"
        :disabled="busy || first"
        data-role="scene-continues"
        @update:model-value="emit('continue', Boolean($event))"
      >
        Начинать там, где закончилась предыдущая сцена
      </UiSwitch>
      <p class="scene__hint">{{ startHint }}</p>
    </div>

    <!-- Запись и звук самой сцены: увидеть, что сняли, можно без просмотра всего
         ролика. Пока записи нет, место честно говорит, когда она появится. -->
    <div class="scene__preview">
      <UiVideo v-if="clipUrl" :src="clipUrl" :label="`Запись сцены «${scene.title}»`" />
      <div v-else class="scene__placeholder">
        <strong>Записи ещё нет</strong>
        <span>Запись экрана появится после сборки ролика.</span>
      </div>
      <UiAudio v-if="audioUrl" :src="audioUrl" :label="`Звук сцены «${scene.title}»`" />
      <div v-if="canJump" class="scene__jump">
        <UiButton variant="outline" @click="emit('jump')">Смотреть в ролике</UiButton>
      </div>
    </div>

    <UiField label="Название сцены">
      <UiInput
        :model-value="draft.title"
        :disabled="busy"
        @update:model-value="patch('title', $event)"
      />
    </UiField>

    <UiField
      label="Текст озвучки"
      hint="Ударение — «+» перед гласной: з+амок. Числа и латиницу — словами."
    >
      <UiTextarea
        :model-value="draft.narration"
        :disabled="busy"
        rows="4"
        @update:model-value="patch('narration', $event)"
      />
    </UiField>

    <section
      class="scene__pronunciation"
      data-role="scene-pronunciation"
      aria-labelledby="scene-pronunciation-title"
    >
      <div class="scene__pronunciation-head">
        <div>
          <strong id="scene-pronunciation-title">Как звучит реплика</strong>
          <p class="scene__hint">
            Прослушивание использует несохранённый текст и те же настройки, что сборка.
          </p>
        </div>
        <UiButton
          variant="outline"
          data-role="preview-narration"
          :disabled="busy || !voiceRef || !canonicalNarration"
          :loading="previewing"
          @click="previewNarration"
        >
          Прослушать реплику
        </UiButton>
      </div>

      <p class="scene__voice-support" :data-state="capabilityState(voiceCapabilities?.stress)">
        {{ stressSupportText }}
      </p>

      <UiField
        label="Фрагмент для явного произношения"
        hint="Выделите слово или фразу в каноническом тексте; экранное написание не изменится."
      >
        <UiTextarea
          :model-value="canonicalNarration"
          :disabled="busy"
          readonly
          rows="3"
          data-role="pronunciation-narration"
          @select="rememberPronunciationSelection"
        />
      </UiField>

      <p class="scene__selection">
        {{ pronunciationSelectedText
          ? `Выбрано: «${pronunciationSelectedText}»`
          : 'Фрагмент ещё не выбран.' }}
      </p>

      <div class="scene__pronunciation-controls">
        <UiField label="Произнести как">
          <UiInput
            :model-value="pronunciationDraft"
            :disabled="busy || !voiceRef"
            placeholder="например, зам+ок"
            data-role="pronunciation-value"
            @update:model-value="pronunciationDraft = String($event ?? '')"
          />
        </UiField>
        <UiButton
          :disabled="busy || !canAddPronunciation"
          data-role="add-pronunciation"
          @click="addPronunciation"
        >
          {{ replacingPronunciation ? 'Заменить исправление' : 'Добавить исправление' }}
        </UiButton>
      </div>

      <p
        v-if="pronunciationError || pronunciationConflict"
        class="scene__pronunciation-error"
        role="alert"
      >
        {{ pronunciationError || 'Выбранный фрагмент пересекается с другим исправлением.' }}
      </p>

      <ul v-if="draft.pronunciationOverrides.length" class="scene__pronunciation-list">
        <li
          v-for="(entry, entryIndex) in draft.pronunciationOverrides"
          :key="pronunciationKey(entry, entryIndex)"
          :data-status="pronunciationStatus(entry)"
        >
          <span>
            <strong>«{{ pronunciationSource(entry) }}» → «{{ entry.pronunciation }}»</strong>
            <small>{{ pronunciationStatusText(entry) }}</small>
          </span>
          <UiButton
            variant="ghost"
            tone="danger"
            :disabled="busy"
            @click="removePronunciation(entryIndex)"
          >
            Удалить
          </UiButton>
        </li>
      </ul>

      <p v-if="previewNote" class="scene__preview-note" role="status">{{ previewNote }}</p>
      <p v-if="previewError" class="scene__pronunciation-error" role="alert">
        {{ previewError }}
      </p>
    </section>

    <section class="scene__bindings" data-role="scene-bindings" aria-labelledby="scene-bindings-title">
      <div class="scene__bindings-head">
        <div>
          <strong id="scene-bindings-title">Речь и действия</strong>
          <p class="scene__hint">Связь выбирается по фрагменту речи, без миллисекунд.</p>
        </div>
        <UiButton
          variant="ghost"
          :disabled="busy"
          data-role="generate-bindings"
          @click="emit('generate-bindings')"
        >
          Построить привязки
        </UiButton>
      </div>

      <p class="scene__binding-state" :data-status="visibleBindingStatus">
        {{ bindingStatusText }}
      </p>

      <template v-if="bindableActions.length && canonicalNarration">
        <UiField
          label="Фрагмент речи"
          hint="Выделите слова в каноническом тексте: знаки ударения здесь уже скрыты."
        >
          <UiTextarea
            :model-value="canonicalNarration"
            :disabled="busy"
            readonly
            rows="3"
            data-role="binding-narration"
            @select="rememberSelection"
          />
        </UiField>

        <p class="scene__selection">
          {{ selectedText ? `Выбрано: «${selectedText}»` : 'Фрагмент ещё не выбран.' }}
        </p>

        <div class="scene__binding-controls">
          <UiField label="Действие">
            <UiSelect v-model.number="bindingActionIndex" :disabled="busy">
              <option v-for="item in bindableActions" :key="item.index" :value="item.index">
                {{ item.label }}
              </option>
            </UiSelect>
          </UiField>
          <UiField label="Связь">
            <UiSelect v-model="bindingKind" :disabled="busy">
              <option
                v-for="item in BINDING_KIND_OPTIONS"
                :key="item.value"
                :value="item.value"
                :disabled="!kindAllowed(item.value, bindingActionIndex)"
              >
                {{ item.label }}
              </option>
            </UiSelect>
          </UiField>
          <UiButton :disabled="busy || !canAddBinding" @click="addBinding">
            {{ boundAction ? 'Заменить связь' : 'Добавить связь' }}
          </UiButton>
        </div>
      </template>
      <p v-else class="scene__hint">
        У сцены нет действия, которое можно связать с речью.
      </p>

      <ul v-if="draft.syncCues.length" class="scene__binding-list">
        <li v-for="cue in draft.syncCues" :key="cue.id ?? cueKey(cue)">
          <span>
            <strong>«{{ cueText(cue) }}»</strong>
            <small>
              {{ bindingKindLabel(cue.kind) }} · {{ actionLabel(cue.actionIndex) }} ·
              {{ cue.origin === 'manual' ? 'вручную' : 'автоматически' }}
            </small>
          </span>
          <UiButton variant="ghost" tone="danger" :disabled="busy" @click="removeBinding(cue)">
            Удалить
          </UiButton>
        </li>
      </ul>
    </section>

    <UiField label="Подпись на экране" hint="Короткая, не дословный субтитр.">
      <UiInput
        :model-value="draft.caption"
        :disabled="busy"
        @update:model-value="patch('caption', $event)"
      />
    </UiField>

    <ul v-if="speechChecks.length" class="scene__checks">
      <li v-for="check in speechChecks" :key="check.id" :data-status="check.status">
        <span class="scene__check-dot" aria-hidden="true"></span>
        <span>{{ CHECK_TEXT[check.status] }}: {{ check.reason }}</span>
        <span v-for="hint in check.suggestions" :key="hint" class="scene__hint">{{ hint }}</span>
      </li>
    </ul>

    <UiDisclosureButton v-model:open="moreOpen" :controls="`${scene.id}-more`" density="compact">
      {{ moreOpen ? 'Скрыть субтитр и свой звук' : 'Субтитр и свой звук' }}
    </UiDisclosureButton>

    <div v-show="moreOpen" :id="`${scene.id}-more`" class="scene__more">
      <UiField label="Субтитр" hint="Тот же смысл, что в речи, обычной письменной формой.">
        <UiTextarea
          :model-value="draft.subtitleText"
          :disabled="busy"
          rows="2"
          @update:model-value="patch('subtitleText', $event)"
        />
      </UiField>

      <div class="scene__media-block">
        <span class="scene__media-title">Свой звук вместо синтеза</span>
        <p class="scene__hint">
          Загруженную запись озвучка не трогает: правка текста её не переозвучит.
        </p>
        <UiFilePicker
          accept="audio/wav,audio/x-wav,.wav"
          :disabled="busy"
          :label="scene.audioSource.kind === 'recorded' ? 'Заменить звук' : 'Загрузить звук'"
          @change="pickAudio"
        />
      </div>
    </div>

    <footer class="scene__actions">
      <UiButton variant="solid" tone="accent" :disabled="!changed || busy" @click="emit('save')">
        Сохранить
      </UiButton>
      <span v-if="changed" class="scene__unsaved">не сохранено</span>
      <span class="scene__spacer" aria-hidden="true"></span>
      <UiButton variant="ghost" :disabled="busy || first" @click="emit('move', -1)">Выше</UiButton>
      <UiButton variant="ghost" :disabled="busy || last" @click="emit('move', 1)">Ниже</UiButton>
      <UiButton variant="ghost" tone="danger" :disabled="busy" @click="emit('remove')">
        Удалить сцену
      </UiButton>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';

import {
  UiAudio,
  UiButton,
  UiDisclosureButton,
  UiField,
  UiFilePicker,
  UiInput,
  UiSelect,
  UiSwitch,
  UiTextarea,
  UiVideo,
} from '../../ui';
import type {
  ShowcaseCheck,
  ShowcaseScene,
  ShowcaseVoiceInfo,
} from '../../../../shared/plugins/showcase/showcaseContracts';
import type { ShowcaseSyncCueKind } from '../../../../shared/plugins/showcase/showcaseContracts';
import { parseNarration } from '../../../../shared/plugins/showcase/showcaseNarration';
import { SHOWCASE_SYNC_ACTIONS_BY_CUE } from '../../../../shared/plugins/showcase/showcaseSync';
import { actionsText, CONTINUATION_LABEL, sceneStateOf } from './sceneText';
import {
  bindingStatusOf,
  narrationTextHash,
  syncCuesChanged,
} from './sceneDraft';
import type {
  SceneBindingStatus,
  SceneDraft,
  SceneNarrationPreviewInput,
  ScenePronunciationDraft,
  SceneSyncCueDraft,
} from './sceneDraft';

type VoiceCapabilities = NonNullable<ShowcaseVoiceInfo['capabilities']>;

const props = withDefaults(defineProps<{
  scene: ShowcaseScene;
  index: number;
  total: number;
  // Название экрана сцены из карты цели: сама сцена хранит только идентификатор.
  screenTitle: string;
  // Черновик принадлежит родителю: переход к другой сцене не теряет правки, а
  // список сцен видит, где они есть.
  draft: SceneDraft;
  changed: boolean;
  busy: boolean;
  first: boolean;
  last: boolean;
  // Сцена начинает там, где закончилась предыдущая. Считает родитель по цепочке:
  // у первой сцены ролика флаг не в счёт.
  continues: boolean;
  clipUrl: string;
  audioUrl: string;
  // Ролик собран из этих сцен — к сцене можно перейти в готовом видео.
  canJump: boolean;
  // Эффективный голос совпадает с тем, который выбрала общая панель или возьмёт
  // сервер по умолчанию. Возможности могут отсутствовать у старого backend.
  voiceRef?: string | null;
  voiceCapabilities?: VoiceCapabilities | null;
  loadPreview?: (input: SceneNarrationPreviewInput, signal?: AbortSignal) => Promise<Blob>;
}>(), {
  voiceRef: null,
  loadPreview: async () => new Blob(),
});

const emit = defineEmits<{
  change: [draft: SceneDraft];
  save: [];
  remove: [];
  move: [delta: number];
  audio: [file: File];
  jump: [];
  continue: [value: boolean];
  'generate-bindings': [];
}>();

// Пропущенная проверка показывается наравне с пройденной, но своим словом: место,
// которое никто не слушал, зелёным быть не должно.
const CHECK_TEXT: Record<ShowcaseCheck['status'], string> = {
  passed: 'речь проверена',
  warning: 'спорное место',
  blocked: 'проверка не пускает дальше',
  skipped: 'проверка пропущена',
};

const moreOpen = ref(false);
const selectedRange = ref({ from: 0, to: 0 });
const pronunciationRange = ref({ from: 0, to: 0 });
const pronunciationDraft = ref('');
const pronunciationError = ref('');
const currentTextHash = ref<string | null>(null);
const textHashKnown = ref(false);
const previewing = ref(false);
const previewNote = ref('');
const previewError = ref('');
const bindingActionIndex = ref('');
const bindingKind = ref<ShowcaseSyncCueKind>('align-start');
const savedBindingStatus = ref<SceneBindingStatus>('missing');

let previewController: AbortController | null = null;
let previewAudio: HTMLAudioElement | null = null;
let previewUrl = '';

const state = computed(() => sceneStateOf(props.scene));

const actions = computed(() => actionsText(props.scene));

const speechChecks = computed(() => props.scene.checks.filter((check) => check.kind === 'speech'));

const canonicalNarration = computed(() => parseNarration(props.draft.narration).text);

const selectedText = computed(() => canonicalNarration.value
  .slice(selectedRange.value.from, selectedRange.value.to)
  .trim());

const pronunciationSelectedText = computed(() => canonicalNarration.value
  .slice(pronunciationRange.value.from, pronunciationRange.value.to)
  .trim());

const replacingPronunciation = computed(() => props.draft.pronunciationOverrides.some((entry) => (
  entry.voiceRef === props.voiceRef
  && entry.from === pronunciationRange.value.from
  && entry.to === pronunciationRange.value.to
)));

const pronunciationConflict = computed(() => props.draft.pronunciationOverrides.some((entry) => {
  if (
    entry.voiceRef !== props.voiceRef
    || !pronunciationAppliesToText(entry)
    || entry.from === pronunciationRange.value.from && entry.to === pronunciationRange.value.to
  ) {
    return false;
  }

  return entry.from < pronunciationRange.value.to && pronunciationRange.value.from < entry.to;
}));

const canAddPronunciation = computed(() => Boolean(
  props.voiceRef
  && pronunciationRange.value.to > pronunciationRange.value.from
  && pronunciationSelectedText.value
  && pronunciationDraft.value.trim()
  && !pronunciationConflict.value
));

const stressSupportText = computed(() => {
  if (!props.voiceRef) {
    return 'Сначала выберите голос ролика.';
  }

  if (props.voiceCapabilities?.stress === true) {
    return 'Знаки «+» и словарь ударений применятся; явную замену можно проверить здесь же.';
  }

  if (props.voiceCapabilities?.stress === false) {
    return 'Этот голос не применяет словарь ударений. Для спорного слова '
      + 'используйте явную замену и прослушайте её.';
  }

  return 'Поддержка словаря у этого голоса неизвестна. Проверьте результат прослушиванием.';
});

const ACTION_NAMES: Record<ShowcaseScene['actions'][number]['kind'], string> = {
  goto: 'переход',
  click: 'клик',
  hover: 'наведение',
  highlight: 'подсветка',
  waitVisible: 'готовность',
  scroll: 'прокрутка',
  wait: 'ожидание',
};

const BINDING_KIND_OPTIONS: { value: ShowcaseSyncCueKind; label: string }[] = [
  { value: 'align-start', label: 'начать вместе' },
  { value: 'ready-before', label: 'должно быть готово до фразы' },
  { value: 'hold-through', label: 'держать во время фразы' },
];

const bindableActions = computed(() => props.scene.actions
  .map((action, index) => ({
    action,
    index,
    label: actionLabel(index),
  }))
  .filter(({ action }) => Object.values(SHOWCASE_SYNC_ACTIONS_BY_CUE)
    .some((kinds) => (kinds as readonly string[]).includes(action.kind))));

const boundAction = computed(() => props.draft.syncCues
  .find((cue) => cue.actionIndex === Number(bindingActionIndex.value)) ?? null);

const canAddBinding = computed(() => selectedRange.value.to > selectedRange.value.from
  && Boolean(selectedText.value)
  && Number.isSafeInteger(Number(bindingActionIndex.value))
  && kindAllowed(bindingKind.value, bindingActionIndex.value));

const visibleBindingStatus = computed(() => (
  syncCuesChanged(props.scene, props.draft) ? 'changed' : savedBindingStatus.value
));

const bindingStatusText = computed(() => {
  if (visibleBindingStatus.value === 'changed') {
    return 'Привязки изменены и ещё не сохранены.';
  }

  return {
    missing: 'Точных привязок пока нет.',
    valid: 'Привязки относятся к текущему тексту и действиям.',
    stale: 'Привязки потеряли актуальность после правки текста или действий.',
    invalid: 'Привязки требуют исправления в этой сцене.',
    unknown: 'Актуальность привязок проверит сервер при сохранении.',
  }[savedBindingStatus.value];
});

// Цена продолжения названа рядом с переключателем: пересъёмка такой сцены тянет
// за собой всю цепочку, и узнать об этом человек должен до сборки, а не по счётчику.
const startHint = computed(() => {
  if (props.first) {
    return 'Первая сцена ролика всегда открывает свой экран сама.';
  }

  return props.continues
    ? 'Открытый диалог и выбранные строки остаются на экране, путь к ним заново не '
      + 'снимается. Переснимается такая сцена вместе со всей цепочкой.'
    : 'Сцена открывает свой экран заново и от предыдущих не зависит.';
});

watch(bindableActions, (actions) => {
  if (!actions.some((item) => String(item.index) === bindingActionIndex.value)) {
    bindingActionIndex.value = actions[0] ? String(actions[0].index) : '';
  }
}, { immediate: true });

watch(bindingActionIndex, () => {
  const allowed = BINDING_KIND_OPTIONS.find((item) => kindAllowed(item.value, bindingActionIndex.value));

  if (allowed && !kindAllowed(bindingKind.value, bindingActionIndex.value)) {
    bindingKind.value = allowed.value;
  }
}, { immediate: true });

let pronunciationHashSequence = 0;

watch(() => props.draft.narration, async (narration) => {
  const sequence = pronunciationHashSequence + 1;

  pronunciationHashSequence = sequence;
  textHashKnown.value = false;

  const hash = await narrationTextHash(narration);

  if (sequence !== pronunciationHashSequence) {
    return;
  }

  currentTextHash.value = hash;
  textHashKnown.value = hash !== null;

  if (pronunciationRange.value.to > canonicalNarration.value.length) {
    pronunciationRange.value = { from: 0, to: 0 };
  }
}, { immediate: true });

let bindingCheckSequence = 0;

watch([
  () => props.scene.syncBindings,
  () => props.draft.narration,
  () => JSON.stringify(props.scene.actions),
], async () => {
  const sequence = bindingCheckSequence + 1;

  bindingCheckSequence = sequence;

  const status = await bindingStatusOf(props.scene, props.draft.narration);

  if (sequence === bindingCheckSequence) {
    savedBindingStatus.value = status;
  }
}, { immediate: true });

watch([
  () => props.draft.narration,
  () => props.voiceRef,
  () => JSON.stringify(props.draft.pronunciationOverrides),
], () => {
  if (previewController || previewAudio) {
    stopPreview();
    previewing.value = false;
    previewNote.value = '';
  }
});

onUnmounted(stopPreview);

function patch(field: 'title' | 'narration' | 'caption' | 'subtitleText', value: unknown): void {
  emit('change', { ...props.draft, [field]: String(value ?? '') });
}

// Подпись связывает порядковый номер с типом и целью действия. Пропавший индекс
// остаётся понятным во время обновления сцены, а не ломает весь список связей.
function actionLabel(index: number): string {
  const action = props.scene.actions[index];

  if (!action) {
    return `действие ${index + 1} удалено`;
  }

  const target = 'targetId' in action && action.targetId ? `: ${action.targetId}` : '';

  return `${index + 1}. ${ACTION_NAMES[action.kind]}${target}`;
}

function bindingKindLabel(kind: ShowcaseSyncCueKind): string {
  return BINDING_KIND_OPTIONS.find((item) => item.value === kind)?.label ?? kind;
}

function kindAllowed(kind: ShowcaseSyncCueKind, actionIndex: string | number): boolean {
  const action = props.scene.actions[Number(actionIndex)];
  const allowed = SHOWCASE_SYNC_ACTIONS_BY_CUE[kind] as readonly string[];

  return action ? allowed.includes(action.kind) : false;
}

function rememberSelection(event: Event): void {
  const textarea = event.target as HTMLTextAreaElement;

  selectedRange.value = {
    from: textarea.selectionStart ?? 0,
    to: textarea.selectionEnd ?? 0,
  };
}

function rememberPronunciationSelection(event: Event): void {
  const textarea = event.target as HTMLTextAreaElement;

  pronunciationRange.value = {
    from: textarea.selectionStart ?? 0,
    to: textarea.selectionEnd ?? 0,
  };
  pronunciationError.value = '';
}

// Возможность старого backend отсутствует, а не равна запрету. Отдельное unknown
// позволяет интерфейсу не обещать поддержку, которой сервер ещё не объявил.
function capabilityState(value: boolean | undefined): 'yes' | 'no' | 'unknown' {
  return value === true ? 'yes' : value === false ? 'no' : 'unknown';
}

function pronunciationAppliesToText(entry: ScenePronunciationDraft): boolean {
  return entry.textHash === null
    || !textHashKnown.value
    || entry.textHash === currentTextHash.value;
}

// Статус локальной замены учитывает сразу хеш текста и выбранный голос. Так старая
// замена остаётся видимой с причиной, но не применяется к новой реплике или голосу.
function pronunciationStatus(
  entry: ScenePronunciationDraft,
): 'active' | 'new' | 'stale' | 'voice' | 'unknown' {
  if (entry.textHash === null) {
    return entry.voiceRef === props.voiceRef ? 'new' : 'voice';
  }

  if (textHashKnown.value && entry.textHash !== currentTextHash.value) {
    return 'stale';
  }

  if (entry.voiceRef !== props.voiceRef) {
    return 'voice';
  }

  return textHashKnown.value ? 'active' : 'unknown';
}

// Человеческая подпись объясняет, почему сохранённая замена сейчас не действует.
// В строке остаётся исходный voiceRef, чтобы исправление можно было вернуть выбором.
function pronunciationStatusText(entry: ScenePronunciationDraft): string {
  const status = pronunciationStatus(entry);

  if (status === 'new') {
    return 'новое исправление · сохранится для выбранного голоса';
  }

  if (status === 'stale') {
    return 'не применяется: текст реплики изменился';
  }

  if (status === 'voice') {
    return `не применяется к выбранному голосу · сохранено для ${entry.voiceRef}`;
  }

  if (status === 'unknown') {
    return 'актуальность подтвердит сервер при сохранении';
  }

  return 'применяется к выбранному голосу';
}

function pronunciationSource(entry: ScenePronunciationDraft): string {
  return canonicalNarration.value.slice(entry.from, entry.to) || 'фрагмент потерян';
}

function pronunciationKey(entry: ScenePronunciationDraft, index: number): string {
  return `${entry.voiceRef}:${entry.from}:${entry.to}:${index}`;
}

/**
 * Диапазоны одного голоса не пересекаются, а тот же диапазон заменяется явно.
 * Новая запись ждёт серверный хеш и до сохранения помечается через textHash=null.
 */
function addPronunciation(): void {
  pronunciationError.value = '';

  if (pronunciationConflict.value) {
    pronunciationError.value = 'Выбранный фрагмент пересекается с другим исправлением.';

    return;
  }

  if (!canAddPronunciation.value || !props.voiceRef) {
    return;
  }

  const next = props.draft.pronunciationOverrides.filter((entry) => !(
    entry.voiceRef === props.voiceRef
    && entry.from === pronunciationRange.value.from
    && entry.to === pronunciationRange.value.to
  ));

  next.push({
    from: pronunciationRange.value.from,
    to: pronunciationRange.value.to,
    pronunciation: pronunciationDraft.value.trim(),
    voiceRef: props.voiceRef,
    textHash: null,
  });
  next.sort((left, right) => left.from - right.from || left.to - right.to
    || left.voiceRef.localeCompare(right.voiceRef));

  emit('change', { ...props.draft, pronunciationOverrides: next });
  pronunciationDraft.value = '';
}

function removePronunciation(index: number): void {
  emit('change', {
    ...props.draft,
    pronunciationOverrides: props.draft.pronunciationOverrides.filter((_, at) => at !== index),
  });
}

function previewOverrides() {
  return props.draft.pronunciationOverrides
    .filter((entry) => entry.voiceRef === props.voiceRef && pronunciationAppliesToText(entry))
    .map((entry) => ({
      from: entry.from,
      to: entry.to,
      pronunciation: entry.pronunciation,
      voiceRef: entry.voiceRef,
    }));
}

// Отмена прерывает и сетевой запрос, и уже играющий звук выбранной реплики.
// Blob URL освобождается здесь же, чтобы переходы между сценами не копили память.
function stopPreview(): void {
  previewController?.abort();
  previewController = null;
  previewAudio?.pause();
  previewAudio = null;

  if (previewUrl && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(previewUrl);
  }

  previewUrl = '';
}

// Полученный звук живёт ровно до завершения или нового preview. Обработчик сверяет
// ссылку на Audio, чтобы позднее событие старого звука не освободило новый Blob URL.
async function playNarrationPreview(blob: Blob): Promise<void> {
  if (typeof Audio === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return;
  }

  previewUrl = URL.createObjectURL(blob);

  const audio = new Audio(previewUrl);

  previewAudio = audio;
  audio.addEventListener('ended', () => {
    if (previewAudio !== audio) {
      return;
    }

    previewAudio = null;

    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = '';
    }
  }, { once: true });

  await audio.play();
}

/**
 * Новый клик и уход со сцены отменяют именно запрос своей реплики. Ошибка отменённого
 * запроса не показывается рядом с уже выбранной следующей сценой.
 */
async function previewNarration(): Promise<void> {
  if (!props.voiceRef || !canonicalNarration.value) {
    return;
  }

  stopPreview();

  const controller = new AbortController();

  previewController = controller;
  previewing.value = true;
  previewNote.value = 'Готовлю реплику выбранным голосом…';
  previewError.value = '';

  try {
    const blob = await props.loadPreview({
      voiceRef: props.voiceRef,
      narration: props.draft.narration,
      direction: props.scene.direction,
      pronunciationOverrides: previewOverrides(),
    }, controller.signal);

    if (!controller.signal.aborted) {
      await playNarrationPreview(blob);
    }
  } catch (error: unknown) {
    if (!controller.signal.aborted) {
      previewError.value = error instanceof Error && error.message
        ? error.message
        : 'Реплика не воспроизвелась: голосовой движок не ответил.';
    }
  } finally {
    if (previewController === controller) {
      previewController = null;
      previewing.value = false;
      previewNote.value = '';
    }
  }
}

/**
 * Одно действие получает одну связь, повторное добавление явно заменяет её.
 * Новый cue помечается ручным, чтобы модель не перезаписала выбор человека.
 */
function addBinding(): void {
  if (!canAddBinding.value) {
    return;
  }

  const actionIndex = Number(bindingActionIndex.value);
  const current = boundAction.value;
  const cue: SceneSyncCueDraft = {
    id: current?.id ?? null,
    actionIndex,
    from: selectedRange.value.from,
    to: selectedRange.value.to,
    kind: bindingKind.value,
    origin: 'manual',
  };
  const next = props.draft.syncCues.filter((item) => item.actionIndex !== actionIndex);

  emit('change', { ...props.draft, syncCues: [...next, cue] });
}

function removeBinding(cue: SceneSyncCueDraft): void {
  emit('change', {
    ...props.draft,
    syncCues: props.draft.syncCues.filter((item) => item !== cue),
  });
}

function cueText(cue: SceneSyncCueDraft): string {
  return canonicalNarration.value.slice(cue.from, cue.to) || 'фрагмент потерян';
}

function cueKey(cue: SceneSyncCueDraft): string {
  return `${cue.actionIndex}:${cue.from}:${cue.to}:${cue.kind}`;
}

function pickAudio(files: File[]): void {
  const file = files[0];

  if (file) {
    emit('audio', file);
  }
}
</script>

<style scoped>
.scene {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 12px;
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

.scene[data-stale='yes'] {
  border-color: color-mix(in srgb, var(--warn) 42%, var(--line));
}

.scene__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.scene__heading {
  min-width: 0;
}

.scene__kicker {
  margin: 0 0 3px;
  color: var(--accent);
  font-size: 9.5px;
  font-weight: 750;
  letter-spacing: 0.1em;
  line-height: 1.2;
  text-transform: uppercase;
}

.scene__head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 660;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}

.scene__state {
  flex: none;
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, var(--good) 32%, var(--line));
  border-radius: 999px;
  color: var(--good);
  font-size: 10.5px;
  white-space: nowrap;
}

.scene__state[data-tone='warn'] {
  border-color: color-mix(in srgb, var(--warn) 38%, var(--line));
  color: var(--warn);
}

.scene__plan {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin: 0;
  color: var(--ink-mid);
  font-size: 12.5px;
  overflow-wrap: anywhere;
}

.scene__plan[data-static='yes'] {
  color: color-mix(in srgb, var(--warn) 70%, var(--ink-mid));
}

.scene__plan-screen {
  color: var(--ink);
  font-weight: 600;
}

.scene__plan-chain {
  color: var(--accent);
  white-space: nowrap;
}

.scene__start {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.scene__bindings,
.scene__pronunciation {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 9px;
  padding: 11px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-2) 32%, transparent);
}

.scene__bindings-head,
.scene__pronunciation-head,
.scene__binding-controls,
.scene__binding-list li,
.scene__pronunciation-controls,
.scene__pronunciation-list li {
  display: flex;
  align-items: center;
  gap: 9px;
}

.scene__bindings-head,
.scene__pronunciation-head {
  justify-content: space-between;
}

.scene__bindings-head strong,
.scene__pronunciation-head strong {
  font-size: 13px;
}

.scene__binding-state,
.scene__selection {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.4;
}

.scene__binding-state[data-status='stale'],
.scene__binding-state[data-status='invalid'],
.scene__binding-state[data-status='changed'] {
  color: var(--warn);
}

.scene__binding-controls {
  align-items: end;
  flex-wrap: wrap;
}

.scene__pronunciation-controls {
  align-items: end;
  flex-wrap: wrap;
}

.scene__binding-controls > *,
.scene__pronunciation-controls > * {
  flex: 1 1 150px;
}

.scene__binding-controls > :last-child,
.scene__pronunciation-controls > :last-child {
  flex: 0 0 auto;
}

.scene__binding-list,
.scene__pronunciation-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.scene__binding-list li,
.scene__pronunciation-list li {
  justify-content: space-between;
  min-width: 0;
  padding: 7px 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface) 64%, transparent);
}

.scene__binding-list li > span,
.scene__pronunciation-list li > span {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
  overflow-wrap: anywhere;
}

.scene__binding-list strong,
.scene__pronunciation-list strong {
  font-size: 12.5px;
}

.scene__binding-list small,
.scene__pronunciation-list small {
  color: var(--ink-mid);
  font-size: 11.5px;
}

.scene__pronunciation-list li[data-status='stale'],
.scene__pronunciation-list li[data-status='voice'] {
  border-color: color-mix(in srgb, var(--warn) 35%, var(--line));
}

.scene__pronunciation-list li[data-status='stale'] small,
.scene__pronunciation-list li[data-status='voice'] small {
  color: var(--warn);
}

.scene__voice-support,
.scene__preview-note,
.scene__pronunciation-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
}

.scene__voice-support {
  color: var(--ink-mid);
}

.scene__voice-support[data-state='yes'] {
  color: var(--good);
}

.scene__voice-support[data-state='no'],
.scene__pronunciation-error {
  color: var(--warn);
}

.scene__preview-note {
  color: var(--accent);
}

.scene__preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.scene__placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  aspect-ratio: 16 / 9;
  padding: 16px;
  border: 1px dashed var(--line-2);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-2) 28%, transparent);
  color: var(--ink-mid);
  font-size: 12.5px;
  text-align: center;
}

.scene__placeholder strong {
  color: var(--ink);
  font-size: 13px;
}

.scene__jump {
  display: flex;
  justify-content: flex-end;
}

.scene__more {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.scene__media-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 11px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface) 62%, transparent);
}

.scene__media-title {
  font-size: 12px;
  font-weight: 650;
}

.scene__hint {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12.5px;
  line-height: 1.45;
}

.scene__checks {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  font-size: 13px;
  list-style: none;
}

.scene__checks li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: color-mix(in srgb, var(--surface) 54%, transparent);
}

.scene__check-dot {
  width: 8px;
  height: 8px;
  flex: none;
  align-self: center;
  border-radius: 50%;
  background: var(--ink-mid);
}

.scene__checks li[data-status='passed'] .scene__check-dot {
  background: var(--good);
}

.scene__checks li[data-status='warning'] .scene__check-dot {
  background: var(--warn);
}

.scene__checks li[data-status='blocked'] .scene__check-dot {
  background: var(--bad);
}

.scene__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.scene__unsaved {
  color: var(--accent);
  font-size: 12px;
}

.scene__spacer {
  flex: 1 1 auto;
}
</style>
