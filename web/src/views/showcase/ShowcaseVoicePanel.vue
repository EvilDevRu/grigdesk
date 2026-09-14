<template>
  <section class="voice" :data-mode="mode" aria-labelledby="showcase-voice-title">
    <!-- Выбор голоса — один на весь ролик: сцены, говорящие разными голосами,
         читаются как ошибка. Образец слушается одним нажатием: по имени голос не
         выбрать, а тембр — единственное, что здесь важно. -->
    <template v-if="mode === 'choice'">
      <div class="voice__choice">
        <UiField label="Голос ролика" class="voice__field">
          <UiSelect
            data-testid="showcase-voice-select"
            :model-value="currentVoice"
            :disabled="busy || !availableVoiceRefs.length"
            @update:model-value="onVoice"
          >
            <option v-if="!groups.length" value="">голос ещё не установлен</option>
            <option v-if="missingCurrentVoice" :value="currentVoice" disabled>
              {{ currentVoice }} — сохранённый голос недоступен
            </option>
            <optgroup v-for="group in groups" :key="group.engineId" :label="group.name">
              <option
                v-for="voice in group.voices"
                :key="voice.ref"
                :value="voice.ref"
                :disabled="!voice.available"
              >
                {{ voice.name }}{{ voice.available ? '' : ' — недоступен' }}
              </option>
            </optgroup>
          </UiSelect>
        </UiField>
        <UiButton
          class="voice__preview"
          variant="outline"
          data-testid="showcase-voice-preview"
          :disabled="!currentVoiceAvailable || busy"
          :loading="previewing"
          @click="preview"
        >
          Прослушать
        </UiButton>
        <!-- Пять ступеней вокруг обычного темпа на ползунке; в свою шкалу их
             переводит выбранный голос. Возможности берём у диктора, а старый
             ответ без них показываем как unknown, не как обещание поддержки. -->
        <UiField class="voice__pace" :label="paceSupported ? `Темп речи — ${paceLabel}` : 'Темп речи'">
          <UiDiscreteSlider
            v-if="paceSupported"
            data-testid="showcase-voice-pace"
            :model-value="paceIndex"
            :min="0"
            :max="PACES.length - 1"
            :step="1"
            :labels="PACE_POINTS"
            :disabled="busy"
            aria-label="Темп речи"
            @update:model-value="onPaceIndex"
          />
          <span v-else class="voice__pace-note" data-testid="showcase-voice-pace-note">
            {{ paceSupportText }}
          </span>
        </UiField>
      </div>

      <p
        v-if="currentVoice"
        class="voice__capabilities"
        data-testid="showcase-voice-capabilities"
        aria-label="Возможности выбранного голоса"
      >
        <span :data-state="capabilityState(currentCapabilities?.pace)">
          Темп: {{ capabilityLabel(currentCapabilities?.pace) }}
        </span>
        <span :data-state="capabilityState(currentCapabilities?.pause)">
          Паузы: {{ capabilityLabel(currentCapabilities?.pause) }}
        </span>
        <span :data-state="capabilityState(currentCapabilities?.stress)">
          Ударения: {{ capabilityLabel(currentCapabilities?.stress) }}
        </span>
      </p>

      <p id="showcase-voice-title" class="voice__note">
        Один голос на все сцены. После смены голоса или темпа звук устареет, и следующая
        сборка переозвучит их.
        <!-- Пока образец готовится, человек видит, чего ждёт: первый запрос синтезирует
             фразу, и у тяжёлого движка это десятки секунд. -->
        <span v-if="previewing" class="voice__preview-note" role="status">{{ previewNote }}</span>
        <span v-if="previewError" class="voice__error" role="alert">{{ previewError }}</span>
      </p>

      <div class="voice__more">
        <UiDisclosureButton v-model:open="setupOpen" controls="showcase-voice-setup" density="compact">
          {{ setupOpen ? 'Скрыть установку голосов' : 'Установить другие голоса' }}
        </UiDisclosureButton>
        <UiDisclosureButton v-model:open="stressOpen" controls="showcase-voice-stress" density="compact">
          {{ stressOpen ? 'Скрыть словарь ударений' : 'Ударения и словарь' }}
        </UiDisclosureButton>
      </div>
    </template>

    <header v-else class="voice__head">
      <p class="voice__kicker">Озвучка</p>
      <h3 id="showcase-voice-title">Голос для озвучки не установлен</h3>
      <p class="voice__note">
        Без голоса сборка не озвучит сцены; свой звук файлом загрузить можно. Установка —
        одним нажатием, размер назван до него. Облако Microsoft говорит без ключа, как
        только сервер видит сеть; облачный голос Яндекса включается ключом в корневом
        .env сервера.
      </p>
    </header>

    <div v-show="mode === 'setup' || setupOpen" id="showcase-voice-setup" class="voice__setup">
      <ul v-if="catalog && pendingEngines.length" class="voice__engines">
        <li v-for="engine in pendingEngines" :key="engine.id">
          <span class="voice__dot" :data-status="engine.doctor.status" aria-hidden="true" />
          <div class="voice__engine-copy">
            <div class="voice__engine-line">
              <strong>{{ engine.name }}</strong>
              <span class="voice__engine-state" :data-status="engine.doctor.status">
                {{ engineState(engine.doctor.status) }}
              </span>
            </div>
            <span class="voice__reason">{{ engine.doctor.reason }}</span>
            <span v-if="engine.doctor.install" class="voice__install">
              {{ engine.doctor.install }}
            </span>
          </div>
        </li>
      </ul>

      <div
        v-if="job"
        class="voice__job"
        :data-state="job.state"
        role="status"
        aria-live="polite"
      >
        <strong>{{ jobTitle }}</strong>
        <span class="voice__job-label">{{ job.label }}</span>
        <span v-if="job.error" class="voice__job-error">{{ job.error }}</span>
        <UiButton
          v-if="job.state === 'running'"
          variant="ghost"
          :loading="busy"
          @click="emit('cancel')"
        >
          Отменить
        </UiButton>
      </div>

      <ul v-if="catalog?.install.available.length" class="voice__packages">
        <li v-for="item in catalog.install.available" :key="item.id">
          <span class="voice__avatar" aria-hidden="true">{{ item.name.slice(0, 1) }}</span>
          <div class="voice__package-copy">
            <strong>{{ item.name }}</strong>
            <span class="voice__package-about">{{ packageAbout(item) }}</span>
          </div>
          <UiButton
            v-if="!item.installed"
            :data-testid="`showcase-voice-install-${item.id}`"
            :loading="busy"
            :disabled="installing"
            @click="emit('install', item.id)"
          >
            Установить
          </UiButton>
          <span v-else class="voice__package-done">
            <i aria-hidden="true"></i>Установлен
          </span>
        </li>
      </ul>
    </div>

    <!-- Ударения: знак в тексте сцены и словарь установки. Словарь общий для всех
         роликов, и править его логично там же, где выбирают голос. -->
    <div v-show="mode === 'choice' && stressOpen" id="showcase-voice-stress" class="voice__stress">
      <p class="voice__note">
        Ударение в тексте сцены — знак «+» перед гласной: з+амок, зам+ок. Слова, в которых
        движок ошибается всегда, лучше записать в словарь: одно слово со знаком на строку,
        строки с «#» — комментарии. Словарь действует на все ролики; сцены с этими словами
        переозвучатся при следующей сборке. Числа и латиницу пишите словами.
        <strong class="voice__stress-support" :data-state="capabilityState(currentCapabilities?.stress)">
          {{ stressSupportText }}
        </strong>
      </p>

      <UiField label="Словарь ударений" :hint="dictionaryHint">
        <UiTextarea
          v-model="dictionaryDraft"
          data-testid="showcase-voice-dictionary"
          :disabled="busy || !dictionary"
          rows="5"
          placeholder="дин+амика"
        />
      </UiField>

      <ul v-if="dictionary?.errors.length" class="voice__dictionary-errors" role="alert">
        <li v-for="error in dictionary.errors" :key="error.line">
          Строка {{ error.line }}: «{{ error.text }}» — {{ error.reason }}.
        </li>
      </ul>

      <div class="voice__row">
        <UiButton
          variant="solid"
          tone="accent"
          data-testid="showcase-voice-dictionary-save"
          :disabled="!dictionaryChanged || busy || !dictionary"
          :loading="busy"
          @click="emit('save-dictionary', dictionaryDraft)"
        >
          Сохранить словарь
        </UiButton>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import {
  UiButton,
  UiDisclosureButton,
  UiDiscreteSlider,
  UiField,
  UiSelect,
  UiTextarea,
} from '../../ui';
import type {
  ShowcasePace,
  ShowcaseVoiceCatalog,
  ShowcaseVoiceDictionary,
  ShowcaseVoicePackage,
} from '../../../../shared/showcaseContracts';

type Pace = ShowcasePace;

const props = withDefaults(defineProps<{
  catalog: ShowcaseVoiceCatalog | null;
  busy: boolean;
  // Режим «установка» живёт на списке роликов, пока говорить нечем; «выбор» — на
  // экране ролика, где голос уже есть и его надо услышать и сменить.
  mode?: 'setup' | 'choice';
  voiceRef?: string | null;
  pace?: Pace | null;
  // Образец приносит вид: у панели нет доступа к сети, и стаб в тестах ей не нужен.
  // Отказ приходит ошибкой с причиной для человека.
  loadPreview?: (voiceRef: string) => Promise<Blob>;
  // Словарь ударений установки; null — ещё не прочитан, и править нечего.
  dictionary?: ShowcaseVoiceDictionary | null;
}>(), {
  mode: 'setup',
  voiceRef: null,
  pace: null,
  loadPreview: async () => new Blob(),
  dictionary: null,
});

const emit = defineEmits<{
  install: [voiceId: string];
  cancel: [];
  change: [choice: { voiceRef: string | null; pace: Pace | null }];
  'save-dictionary': [text: string];
}>();

const PACES: { value: Pace; label: string }[] = [
  { value: 'slowest', label: 'Медленно' },
  { value: 'slow', label: 'Помедленнее' },
  { value: 'normal', label: 'Обычный' },
  { value: 'fast', label: 'Побыстрее' },
  { value: 'fastest', label: 'Быстро' },
];

// Подписи под ползунком: только края и середина, остальные ступени читаются по
// подписи поля — пять слов под коротким ползунком слипались бы.
const PACE_POINTS: Record<number, string> = {
  0: 'Медленно',
  2: 'Обычный',
  4: 'Быстро',
};

const PREVIEW_NOTE = 'Готовлю образец: первый раз голос синтезирует фразу, '
  + 'у тяжёлого движка это занимает до минуты.';

const previewing = ref(false);
const previewNote = ref('');
const previewError = ref('');

// Играющий образец держится ссылкой: элемент без ссылки браузер вправе собрать до
// начала звука, и кнопка осталась бы занятой навсегда.
let previewAudio: HTMLAudioElement | null = null;
let previewAudioUrl: string | null = null;
let previewGeneration = 0;
const setupOpen = ref(false);
const stressOpen = ref(false);

const dictionaryDraft = ref(props.dictionary?.text ?? '');

// Свежий словарь приходит после чтения и после сохранения: черновик подхватывает
// его, пока человек в нём ничего не менял, иначе чужое обновление стёрло бы набранное.
watch(() => props.dictionary, (next, previous) => {
  if (dictionaryDraft.value === (previous?.text ?? '')) {
    dictionaryDraft.value = next?.text ?? '';
  }
});

const dictionaryChanged = computed(() => dictionaryDraft.value !== (props.dictionary?.text ?? ''));

const job = computed(() => props.catalog?.install.job ?? null);

const installing = computed(() => job.value?.state === 'running');

// Движки, которым чего-то не хватает. Готовый движок здесь не перечисляется: его
// голоса уже стоят в выборе, а строка «готов» ничего не решает.
const pendingEngines = computed(() => (
  (props.catalog?.engines ?? []).filter((engine) => engine.doctor.status !== 'ready')
));

// Голоса, которыми можно говорить прямо сейчас, сгруппированные по движку.
// Недоступные в список выбора не попадают: выбрать голос, который молчит, нельзя.
const groups = computed(() => (props.catalog?.engines ?? [])
  .map((engine) => ({
    engineId: engine.id,
    name: engine.name,
    voices: engine.voices
      .filter((voice) => voice.available || `${engine.id}:${voice.id}` === props.voiceRef)
      .map((voice) => ({
        ref: `${engine.id}:${voice.id}`,
        name: voice.name,
        available: voice.available,
        capabilities: voice.capabilities,
      })),
  }))
  .filter((group) => group.voices.length > 0));

// Пока человек ничего не выбирал, звучит первый доступный голос первого готового
// движка — ровно тот, который возьмёт сервер. Показывать пустой выбор нельзя:
// голос у ролика есть всегда.
const availableVoiceRefs = computed(() => groups.value
  .flatMap((group) => group.voices)
  .filter((voice) => voice.available)
  .map((voice) => voice.ref));

const currentVoice = computed(() => props.voiceRef ?? availableVoiceRefs.value[0] ?? '');

const missingCurrentVoice = computed(() => Boolean(
  currentVoice.value
  && !groups.value.some((group) => group.voices.some((voice) => voice.ref === currentVoice.value)),
));

const currentPace = computed<Pace>(() => props.pace ?? 'normal');

const currentVoiceInfo = computed(() => groups.value
  .flatMap((group) => group.voices)
  .find((voice) => voice.ref === currentVoice.value) ?? null);

const currentCapabilities = computed(() => currentVoiceInfo.value?.capabilities);

const currentVoiceAvailable = computed(() => currentVoiceInfo.value?.available === true);

// Только явное true открывает управление. Отсутствующее поле старого сервера —
// «неизвестно»: отправлять выбор, который может быть молча проигнорирован, нельзя.
const paceSupported = computed(() => currentCapabilities.value?.pace === true);

const paceSupportText = computed(() => currentCapabilities.value?.pace === false
  ? 'Этот голос темп не меняет — ускорить или замедлить речь можно другим голосом.'
  : 'Поддержка изменения темпа для этого голоса неизвестна; темп не меняем.');

const stressSupportText = computed(() => {
  if (currentCapabilities.value?.stress === true) {
    return 'Выбранный голос применяет знаки и словарь ударений.';
  }

  if (currentCapabilities.value?.stress === false) {
    return 'Выбранный голос не применяет знаки и словарь ударений; используйте явную замену в сцене.';
  }

  return 'Поддержка ударений у выбранного голоса неизвестна; проверьте реплику прослушиванием.';
});

// Возможность старого backend отсутствует, а не равна запрету. Отдельное unknown
// не даёт интерфейсу обещать поддержку, которую сервер ещё не объявил.
function capabilityState(value: boolean | undefined): 'yes' | 'no' | 'unknown' {
  return value === true ? 'yes' : value === false ? 'no' : 'unknown';
}

// Текстовая подпись повторяет трёхзначное состояние значка без цветовой подсказки.
// Это сохраняет различие «нет» и «неизвестно» для чтения вслух и без CSS.
function capabilityLabel(value: boolean | undefined): string {
  return value === true ? 'есть' : value === false ? 'нет' : 'неизвестно';
}

const paceIndex = computed(() => Math.max(0, PACES.findIndex((item) => item.value === currentPace.value)));

const paceLabel = computed(() => PACES[paceIndex.value]?.label ?? 'Обычный');

const JOB_TITLES: Record<string, string> = {
  running: 'Идёт установка',
  succeeded: 'Установка завершена',
  failed: 'Установка не удалась',
  cancelled: 'Установка отменена',
  interrupted: 'Установка оборвалась',
};

const jobTitle = computed(() => JOB_TITLES[job.value?.state ?? ''] ?? 'Установка');

const ENGINE_STATES: Record<string, string> = {
  ready: 'готов',
  warning: 'есть ограничение',
  blocked: 'нужна настройка',
  unknown: 'не проверен',
};

function engineState(status: string): string {
  return ENGINE_STATES[status] ?? status;
}

const MEGABYTE = 1024 * 1024;
const GIGABYTE = 1024 * MEGABYTE;

// Пакет на гигабайты называется гигабайтами: «8100 МБ» читается хуже, чем «7,9 ГБ».
function sizeLabel(bytes: number): string {
  if (bytes >= GIGABYTE) {
    return `${(bytes / GIGABYTE).toFixed(1).replace('.', ',')} ГБ`;
  }

  return `${Math.round(bytes / MEGABYTE)} МБ`;
}

/**
 * Подпись пакета: кого услышишь, сколько скачается и на каких условиях. Голоса
 * перечислены по именам — модель на пять дикторов иначе выглядела бы одним.
 */
function packageAbout(item: ShowcaseVoicePackage): string {
  const voices = item.voices.length > 1 ? `голоса: ${item.voices.join(', ')}` : item.timbre;

  return `${voices} · ${sizeLabel(item.byteSize)} · ${item.license}`;
}

/**
 * Подпись словаря: сколько записей действует. Число склоняется, потому что
 * «12 слово» под полем ввода читалось бы как ошибка самого раздела.
 */
function wordsCount(count: number): string {
  const tail = count % 10;
  const teen = count % 100 >= 11 && count % 100 <= 14;

  if (tail === 1 && !teen) {
    return `${count} слово`;
  }

  if (tail >= 2 && tail <= 4 && !teen) {
    return `${count} слова`;
  }

  return `${count} слов`;
}

const dictionaryHint = computed(() => {
  if (!props.dictionary) {
    return 'Словарь ещё не прочитан.';
  }

  const count = props.dictionary.entries.length;

  return count > 0 ? `Действует: ${wordsCount(count)}.` : 'Словарь пуст.';
});

// Смена голоса уходит наверх только когда выбор действительно изменился: сервер
// перезаписывает все сцены, и повтор того же значения старил бы их звук зря.
function onVoice(value: unknown): void {
  const voiceRef = typeof value === 'string' && value ? value : null;

  if (voiceRef !== currentVoice.value) {
    resetPreview();
    emit('change', { voiceRef, pace: currentPace.value });
  }
}

// Темп меняется вместе с текущим голосом: серверу нужен полный выбор, а не одно
// из двух полей. Ползунок отдаёт номер ступени, наверх уходит её имя.
function onPaceIndex(index: number): void {
  const value = PACES[index]?.value;

  if (value && value !== currentPace.value) {
    emit('change', { voiceRef: currentVoice.value || null, pace: value });
  }
}

/**
 * Образец воспроизводится сразу, без плеера на экране: первый запрос ещё и
 * синтезирует фразу, поэтому кнопка занята до начала звука, а не до конца.
 */
async function preview(): Promise<void> {
  if (!currentVoice.value) {
    return;
  }

  const generation = ++previewGeneration;

  previewing.value = true;
  previewNote.value = PREVIEW_NOTE;
  previewError.value = '';

  try {
    const blob = await props.loadPreview(currentVoice.value);

    if (generation !== previewGeneration) {
      return;
    }

    await playPreview(blob);
  } catch (error: unknown) {
    if (generation === previewGeneration) {
      previewError.value = error instanceof Error && error.message
        ? error.message
        : 'Образец не воспроизвёлся: движок не ответил.';
    }
  } finally {
    if (generation === previewGeneration) {
      previewing.value = false;
      previewNote.value = '';
    }
  }
}

/**
 * Останавливает образец и сразу освобождает его Blob URL. Единая точка очистки
 * используется при смене голоса, повторном preview и уходе со страницы.
 */
function stopPreviewAudio(): void {
  previewAudio?.pause();
  previewAudio = null;

  if (previewAudioUrl && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(previewAudioUrl);
  }

  previewAudioUrl = null;
}

/**
 * Смена голоса или уход со страницы делает ответ и ошибку прошлого preview
 * устаревшими. Номер поколения отсекает даже ответ уже завершившегося fetch.
 */
function resetPreview(): void {
  previewGeneration += 1;
  previewing.value = false;
  previewNote.value = '';
  previewError.value = '';
  stopPreviewAudio();
}

/**
 * Воспроизведение готового образца. Прежний образец останавливается — два голоса
 * разом не сравнить. Без Audio (тесты, редкий браузер) образец считается
 * полученным: причина отказа движка к этому моменту уже пришла бы ошибкой.
 */
async function playPreview(blob: Blob): Promise<void> {
  if (typeof Audio === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return;
  }

  stopPreviewAudio();

  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);

  previewAudio = audio;
  previewAudioUrl = url;
  audio.addEventListener('ended', () => {
    if (previewAudio === audio) {
      previewAudio = null;
    }

    if (previewAudioUrl === url) {
      previewAudioUrl = null;
    }

    URL.revokeObjectURL(url);
  }, { once: true });

  try {
    await audio.play();
  } catch (error) {
    stopPreviewAudio();

    throw error;
  }
}

onBeforeUnmount(resetPreview);
</script>

<style scoped>
.voice {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--surface) 96%, #fff) 0%,
    var(--surface) 100%
  );
  box-shadow: inset 0 1px 0 #ffffff08;
}

.voice__pace {
  flex: 1 1 260px;
  min-width: 0;
}

.voice__pace-note,
.voice__preview-note {
  color: var(--ink-mid);
  font-size: 12.5px;
  line-height: 1.45;
}

.voice__pace-note {
  display: block;
  padding-top: 6px;
}

.voice__capabilities {
  display: flex;
  gap: 6px;
  margin: 0;
  flex-wrap: wrap;
}

.voice__capabilities span {
  padding: 3px 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--ink-mid);
  font-size: 10.5px;
}

.voice__capabilities span[data-state='yes'] {
  border-color: color-mix(in srgb, var(--good) 34%, var(--line));
  color: var(--good);
}

.voice__capabilities span[data-state='no'] {
  border-color: color-mix(in srgb, var(--warn) 38%, var(--line));
  color: var(--warn);
}

.voice__preview-note {
  display: block;
  margin-top: 2px;
  color: var(--accent);
}

.voice__choice {
  display: flex;
  align-items: flex-end;
  gap: 10px 14px;
  min-width: 0;
  flex-wrap: wrap;
}

.voice__field {
  flex: 1 1 260px;
  min-width: 0;
}

.voice__preview {
  flex: none;
}

.voice__head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.voice__kicker {
  margin: 0;
  color: var(--accent);
  font-size: 9.5px;
  font-weight: 750;
  letter-spacing: 0.1em;
  line-height: 1.2;
  text-transform: uppercase;
}

.voice__head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 660;
  letter-spacing: -0.01em;
}

.voice__more {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.voice__setup,
.voice__stress {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.voice__dictionary-errors {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 8px 11px;
  border: 1px solid color-mix(in srgb, var(--bad) 42%, var(--line));
  border-radius: 10px;
  background: color-mix(in srgb, var(--bad) 6%, var(--surface));
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.45;
  list-style: none;
}

.voice__row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.voice__error {
  display: block;
  margin-top: 2px;
  color: var(--bad);
}

.voice__note {
  max-width: 720px;
  margin: 0;
  color: var(--ink-mid);
  font-size: 12.5px;
  line-height: 1.5;
}

.voice__stress-support {
  display: block;
  margin-top: 5px;
  color: var(--ink);
  font-weight: 600;
}

.voice__stress-support[data-state='no'] {
  color: var(--warn);
}

.voice__stress-support[data-state='unknown'] {
  color: var(--ink-mid);
}

.voice__engines,
.voice__packages {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.voice__engines li {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr);
  align-items: start;
  gap: 9px;
  min-width: 0;
  padding: 10px 11px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: color-mix(in srgb, var(--ground) 58%, transparent);
}

.voice__dot {
  width: 8px;
  height: 8px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--ink-mid);
}

.voice__dot[data-status='ready'] {
  background: var(--good);
}

.voice__dot[data-status='blocked'] {
  background: var(--bad);
}

.voice__dot[data-status='warning'] {
  background: var(--warn);
}

.voice__engine-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.voice__engine-line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.voice__engine-line strong {
  font-size: 12.5px;
}

.voice__engine-state {
  flex: none;
  color: var(--ink-mid);
  font-size: 10.5px;
}

.voice__engine-state[data-status='warning'] {
  color: var(--warn);
}

.voice__engine-state[data-status='blocked'] {
  color: var(--bad);
}

.voice__reason,
.voice__install {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.45;
}

.voice__install {
  padding-top: 4px;
  border-top: 1px solid var(--line);
  font-size: 11.5px;
}

.voice__job {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line));
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 6%, var(--surface));
  font-size: 13px;
}

.voice__job[data-state='failed'],
.voice__job[data-state='interrupted'] {
  border-color: color-mix(in srgb, var(--bad) 42%, var(--line));
  background: color-mix(in srgb, var(--bad) 6%, var(--surface));
}

.voice__job-label,
.voice__job-error {
  color: var(--ink-mid);
}

.voice__packages li {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: color-mix(in srgb, var(--ground) 58%, transparent);
}

.voice__avatar {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line));
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 9%, var(--surface-2));
  color: var(--accent);
  font-size: 13px;
  font-weight: 700;
}

.voice__package-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.voice__package-about {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.4;
}

.voice__package-done {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--good);
  font-size: 11px;
}

.voice__package-done i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentcolor;
}

@media (max-width: 520px) {
  .voice__engine-line {
    align-items: flex-start;
    flex-direction: column;
  }

  .voice__packages li {
    grid-template-columns: 34px minmax(0, 1fr);
  }

  .voice__packages li > :last-child {
    grid-column: 2;
    justify-self: start;
  }
}
</style>
