<template>
  <div
    class="settings-speech"
    :data-settings-speech-page="settings.pageId"
    :data-ready="loaded"
  >
    <SettingsScope />
    <p v-if="error || operations.message.value" role="alert">{{ error || operations.message.value }}</p>
    <p v-if="!loaded">Загрузка речи…</p>
    <template v-else>
      <template v-if="settings.pageId === 'speech.dictation'">
        <SettingsField :address="address('engine')">
          <UiSelect :model-value="text('engine')" @update:model-value="edit('engine', $event)">
            <option value="browser">Браузер</option>
            <option value="whisper">Whisper на сервере</option>
          </UiSelect>
        </SettingsField>
        <SettingsField :address="address('browserProcessing')">
          <UiSelect
            :model-value="text('browserProcessing')"
            @update:model-value="edit('browserProcessing', $event)"
          >
            <option value="auto">Способ обработки выбирает браузер</option>
            <option value="local">Только локально в браузере</option>
          </UiSelect>
        </SettingsField>
        <SettingsField :address="address('quality')">
          <UiSelect :model-value="text('quality')" @update:model-value="edit('quality', $event)">
            <option
              v-for="quality in SPEECH_QUALITIES"
              :key="quality"
              :value="quality"
            >
              {{ qualityLabel(quality) }} · {{ QUALITY_MODELS[quality] }}
            </option>
          </UiSelect>
        </SettingsField>
        <SettingsSection heading="Как обрабатывается речь">
          <p>{{ effectivePath }}</p>
          <p>Локальная модель браузера: {{ browserStatusLabel }}.</p>
          <p>Согласие на браузерную обработку: {{ view.browserAutoConsent ? 'получено' : 'не получено' }}.</p>
          <p>Диктовка: {{ dictationModel }} · видео: {{ videoModel }}.</p>
        </SettingsSection>
      </template>
      <template v-else-if="settings.pageId === 'speech.video'">
        <SettingsField :address="address('videoQuality')">
          <UiSelect :model-value="text('videoQuality')" @update:model-value="edit('videoQuality', $event)">
            <option
              v-for="quality in SPEECH_QUALITIES"
              :key="quality"
              :value="quality"
            >
              {{ qualityLabel(quality) }} · {{ QUALITY_MODELS[quality] }}
            </option>
          </UiSelect>
        </SettingsField>
        <SettingsField :address="address('videoInitialPrompt')">
          <UiTextarea
            :model-value="text('videoInitialPrompt')"
            :maxlength="600"
            :rows="4"
            @update:model-value="edit('videoInitialPrompt', $event)"
          />
        </SettingsField>
        <UiButton @click="edit('videoInitialPrompt', null)">Вернуть стандартную подсказку</UiButton>
        <p v-if="value('videoInitialPrompt') === null">
          После применения сервер подставит свой текст по умолчанию.
        </p>
      </template>
      <template v-else-if="settings.pageId === 'speech.language'">
        <SettingsField :address="address('language')">
          <UiSelect :model-value="text('language')" @update:model-value="edit('language', $event)">
            <option value="auto">Автоматически</option>
            <option value="ru">Русский</option>
            <option value="en">Английский</option>
          </UiSelect>
        </SettingsField>
        <SettingsField :address="address('dictionary')">
          <UiTextarea
            :model-value="text('dictionary')"
            :maxlength="800"
            :rows="8"
            @update:model-value="edit('dictionary', $event)"
          />
        </SettingsField>
        <UiButton @click="edit('dictionary', GRIGDESK_DICTIONARY)">Подставить термины GrigDesk</UiButton>
        <p v-if="view.capabilities.lastDictionaryMeasure">
          Последний замер словаря: {{ view.capabilities.lastDictionaryMeasure.hotwordsTokens }} токенов
          {{ view.capabilities.lastDictionaryMeasure.hotwordsTruncated ? '· словарь обрезан' : '' }}.
        </p>
      </template>
      <template v-else-if="settings.pageId === 'speech.models'">
        <p>Скачивание, копирование и отмена выполняются сразу. Они продолжаются после ухода со страницы.</p>
        <p v-if="!view.capabilities.models.length">Сервер пока не сообщил каталог моделей.</p>
        <SettingsSection
          v-for="model in view.capabilities.models"
          :key="model.modelId"
          class="settings-speech-model"
          :heading="model.modelId"
        >
          <p>
            {{ model.repo }} · {{ model.cached ? 'В кэше' : 'Не скачана' }} · {{ modelSize(model.sizeMb) }}
          </p>
          <div class="settings-speech-actions">
            <UiButton
              :data-download="model.modelId"
              :disabled="model.cached || modelBusy(model.modelId)"
              @click="operations.start('download', model.modelId)"
            >
              Скачать
            </UiButton>
            <UiButton
              v-if="!model.cached"
              :data-copy="model.modelId"
              :disabled="modelBusy(model.modelId)"
              @click="operations.start('copy', model.modelId)"
            >
              Скопировать из общего кэша
            </UiButton>
            <UiButton
              v-if="operations.isActive(operations.jobFor(model.modelId))"
              :data-cancel="model.modelId"
              :disabled="operations.busy.value.includes(`cancel:${operations.jobFor(model.modelId)?.jobId}`)"
              @click="operations.cancel(operations.jobFor(model.modelId))"
            >
              Отменить
            </UiButton>
          </div>
          <p v-if="operations.jobFor(model.modelId)">
            {{ operations.jobFor(model.modelId)?.kind === 'copy' ? 'Копирование' : 'Скачивание' }}:
            {{ jobLabel(operations.jobFor(model.modelId)) }}
          </p>
          <UiProgress
            v-if="operations.jobFor(model.modelId)?.percent != null"
            label="Прогресс модели"
            :value="operations.jobFor(model.modelId)?.percent ?? undefined"
          />
          <p v-if="operations.jobFor(model.modelId)?.error" role="alert">
            {{ operations.jobFor(model.modelId)?.error }}
          </p>
        </SettingsSection>
      </template>
      <template v-else-if="settings.pageId === 'speech.advanced'">
        <SettingsSection heading="Модели распознавания">
          <SettingsField
            v-for="key in ['model', 'videoModel']"
            :key="key"
            :address="address(key)"
          >
            <UiSelect :model-value="text(key)" @update:model-value="edit(key, $event === '' ? null : $event)">
              <option value="">По пресету</option>
              <option
                v-for="model in SPEECH_MODELS"
                :key="model"
                :value="model"
              >
                {{ model }}
              </option>
            </UiSelect>
          </SettingsField>
        </SettingsSection>
        <SettingsSection heading="Обработка на сервере">
          <SettingsField :address="address('device')">
            <UiSelect :model-value="text('device')" @update:model-value="edit('device', $event)">
              <option value="auto">Автоматически</option>
              <option value="cpu">CPU</option>
              <option value="cuda" :disabled="!cudaReady">CUDA</option>
            </UiSelect>
          </SettingsField>
          <SettingsField :address="address('computeType')">
            <UiSelect
              :model-value="text('computeType')"
              @update:model-value="edit('computeType', $event === '' ? null : $event)"
            >
              <option value="">По устройству</option>
              <option
                v-for="type in ['int8', 'int8_float16', 'float16', 'float32']"
                :key="type"
                :value="type"
              >
                {{ type }}
              </option>
            </UiSelect>
          </SettingsField>
          <SettingsField :address="address('beamSize')">
            <UiNumberInput
              :model-value="number('beamSize')"
              :min="1"
              :max="10"
              placeholder="По пресету"
              @update:model-value="edit('beamSize', $event === '' ? null : $event)"
            />
          </SettingsField>
          <SettingsField :address="address('vadSilenceMs')">
            <UiNumberInput
              :model-value="number('vadSilenceMs')"
              :min="100"
              :max="5000"
              @update:model-value="edit('vadSilenceMs', $event)"
            />
          </SettingsField>
          <SettingsField :address="address('conditionOnPreviousText')">
            <UiSwitch
              :model-value="value('conditionOnPreviousText') === true"
              @update:model-value="edit('conditionOnPreviousText', $event)"
            />
          </SettingsField>
        </SettingsSection>
        <SettingsSection heading="Окружение и замер">
          <p>
            Whisper:
            {{ view.capabilities.local.ready ? 'Готов' : view.capabilities.local.reason || 'Не готов' }}.
          </p>
          <ul>
            <li v-for="check in view.capabilities.local.checks" :key="check.name">
              {{ check.name }} · {{ check.ok ? 'готово' : check.fix || 'требует исправления' }}
            </li>
          </ul>
          <p>CUDA: {{ cudaReason }}.</p>
          <p v-if="!cudaReady">
            Установка библиотек:
            <code>deploy/install.sh --with-cuda</code>
            .
          </p>
          <UiButton :disabled="refreshing" @click="refresh">Перепроверить окружение и кэш</UiButton>
        </SettingsSection>
        <SettingsSection heading="Замер на эталонной записи">
          <p>
            Модель {{ benchmarkParameters.modelId }} · {{ benchmarkParameters.language }} ·
            {{ benchmarkParameters.device }} · {{ benchmarkParameters.computeType }}.
          </p>
          <UiButton
            data-benchmark
            :disabled="benchmarkDisabled"
            @click="operations.start('benchmark')"
          >
            Замерить
          </UiButton>
          <p v-if="!view.capabilities.benchmark.available">
            {{ view.capabilities.benchmark.reason }} Эталонный WAV задаётся через
            <code>GRIGDESK_SPEECH_BENCHMARK_AUDIO</code>
            .
          </p>
          <template v-if="benchmarkJob">
            <p>{{ jobLabel(benchmarkJob) }}</p>
            <UiProgress
              v-if="benchmarkJob.percent !== null"
              label="Прогресс замера"
              :value="benchmarkJob.percent"
            />
            <UiButton v-if="operations.isActive(benchmarkJob)" @click="operations.cancel(benchmarkJob)">
              Отменить замер
            </UiButton>
            <p v-if="benchmarkJob.error" role="alert">{{ benchmarkJob.error }}</p>
            <p v-if="benchmarkJob.status === 'done'">{{ speechBenchmarkText(benchmarkJob) }}</p>
          </template>
        </SettingsSection>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import SettingsScope from '../SettingsScope.vue';
import SettingsSection from '../SettingsSection.vue';
import { UiButton, UiSelect, UiTextarea, UiNumberInput, UiSwitch, UiProgress } from '../../../ui.ts';
import { api, failureText } from '../../../shared/apiClient.ts';
import { useSettingsStore } from '../../../stores/settings.ts';
import { useChatStore } from '../../../stores/chat.js';
import { sseSubscribe } from '../../../composables/useSse.ts';
import { SETTINGS_FIELDS } from '../../../features/settings/catalog.ts';
import type { FieldAddress, JsonValue } from '../../../features/settings/contracts.ts';
import {
  createSpeechResource,
  SPEECH_MODELS,
  SPEECH_QUALITIES,
  QUALITY_MODELS,
  GRIGDESK_DICTIONARY,
} from '../../../features/settings/resources/speech.ts';
import {
  createSpeechOperations,
  speechBenchmarkText,
  type SpeechJob,
} from '../../../features/settings/speechOperations.ts';
import { browserSpeechRecognition, probeLocalSpeech } from '../../../features/settings/speechBrowser.ts';
import SettingsField from '../SettingsField.vue';

const props = defineProps<{ active: boolean }>();
const settings = useSettingsStore();
const error = ref('');
const refreshing = ref(false);
const browserStatus = ref('unknown');
const fields = SETTINGS_FIELDS.filter((field) => field.resourceId === 'speech');
const service = settings.sessionService('speech', () => {
  const opening = settings.snapshot.sessionId;
  const controller = new AbortController();
  const resource = createSpeechResource(api, (snapshot) => {
    if (!settings.isOpen || settings.snapshot.sessionId !== opening) {
      return;
    }

    view.value = snapshot;
    settings.acceptSnapshot('speech', snapshot.values, opening);
    useChatStore().setSpeechSnapshot({
      settings: {
        ...snapshot.values,
        local: snapshot.capabilities.local,
        browserAutoConsent: snapshot.browserAutoConsent,
      },
      revision: snapshot.revision,
      capabilities: snapshot.capabilities,
    });
  });
  const view = shallowRef(resource.getSnapshot());
  const operations = createSpeechOperations(api, () => {
    const device = String(settings.getValue('speech', 'device') ?? 'auto');
    const effectiveDevice = device === 'auto'
      ? view.value.capabilities.cuda.state === 'ready' ? 'cuda' : 'cpu' : device;

    return {
      modelId: String(settings.getValue('speech', 'model')
        || QUALITY_MODELS[String(settings.getValue('speech', 'quality'))] || 'medium'),
      language: String(settings.getValue('speech', 'language') ?? 'auto'),
      device: effectiveDevice,
      computeType: String(settings.getValue('speech', 'computeType')
        || (effectiveDevice === 'cuda' ? 'float16' : 'int8')),
    };
  }, () => resource.refresh(controller.signal));

  settings.registerResource(resource.adapter, fields);
  settings.bindSession('speech', () => {
    const off = sseSubscribe((name, payload) => {
      if (name === 'speech-settings') {
        resource.accept(payload);
      } else if (name === 'hello') {
        void resource.refresh(controller.signal).catch(() => undefined);
      }
    });

    return () => {
      controller.abort();
      off();
      operations.dispose();
      resource.dispose();
    };
  });

  return {
    resource,
    view,
    operations,
  };
});
const operations = service.operations;
const view = computed(() => service.view.value);
const loaded = computed(() => settings.snapshot.resources.some((item) =>
  item.id === 'speech' && item.loaded));
const cudaReady = computed(() => view.value.capabilities.cuda.state === 'ready');
const cudaReason = computed(() => {
  const cuda = view.value.capabilities.cuda;

  return cuda.state === 'ready' ? 'Готово' : cuda.reason
    || (cuda.state === 'no_device' ? 'NVIDIA GPU не обнаружен'
      : cuda.state === 'missing_library' ? 'Библиотеки CUDA не установлены' : 'Не удалось проверить CUDA');
});
const browserStatusLabel = computed(() => ({
  available: 'готова',
  downloadable: 'можно скачать при первом запуске',
  downloading: 'скачивается',
  unavailable: 'недоступна',
  unknown: 'проверяется',
} as Record<string, string>)[browserStatus.value] ?? browserStatus.value);
const dictationModel = computed(() => text('model') || QUALITY_MODELS[text('quality')] || 'medium');
const videoModel = computed(() => text('videoModel') || QUALITY_MODELS[text('videoQuality')] || 'medium');
const benchmarkParameters = computed(() => {
  const device = text('device') === 'auto' ? cudaReady.value ? 'cuda' : 'cpu' : text('device');

  return {
    modelId: dictationModel.value,
    language: text('language'),
    device,
    computeType: text('computeType') || (device === 'cuda' ? 'float16' : 'int8'),
  };
});
const benchmarkJob = computed(() => operations.jobFor('', true));
const benchmarkDisabled = computed(() => !view.value.capabilities.benchmark.available
  || text('device') === 'cuda' && !cudaReady.value || operations.isActive(benchmarkJob.value)
  || operations.busy.value.includes('benchmark:'));
const effectivePath = computed(() => {
  const local = view.value.capabilities.local;

  if (text('engine') === 'whisper') {
    return local.ready ? 'Whisper на сервере GrigDesk' : `Недоступно: ${local.reason}`;
  }
  if (!browserSpeechRecognition(window)
      || text('browserProcessing') === 'local' && browserStatus.value === 'unavailable') {
    return local.ready ? 'Whisper (fallback: браузерный режим недоступен)'
      : `Недоступно: браузерный режим и Whisper не готовы. ${local.reason}`;
  }

  if (text('browserProcessing') !== 'local') {
    return 'Браузер — способ обработки выбирает сам браузер';
  }

  return browserStatus.value === 'downloadable' ? 'Браузер локально — модель скачается при первом запуске'
    : browserStatus.value === 'downloading' ? 'Браузер локально — модель скачивается'
      : 'Браузер локально на этом устройстве';
});

function value(key: string): JsonValue | undefined {
  settings.snapshot;

  return settings.getValue('speech', key);
}

function text(key: string): string {
  return String(value(key) ?? '');
}

function number(key: string): number | '' {
  const current = value(key);

  return typeof current === 'number' ? current : '';
}

function address(key: string): FieldAddress {
  return fields.find((field) => field.key === key)!.address;
}

function edit(key: string, next: JsonValue): void {
  settings.setField('speech', key, next);
}

function qualityLabel(quality: string): string {
  const labels: Record<string, string> = {
    fast: 'Быстро',
    balanced: 'Обычно',
    accurate: 'Точно',
  };

  return labels[quality] ?? quality;
}

function modelBusy(modelId: string): boolean {
  return operations.isActive(operations.jobFor(modelId))
    || operations.busy.value.some((key) => key === `download:${modelId}` || key === `copy:${modelId}`);
}

/**
 * Размер показывается в привычных единицах без ложного нуля при неизвестных данных.
 * Маленьким моделям хватает одной десятичной цифры, большим — целых мегабайт.
 */
function modelSize(sizeMb: number): string {
  return sizeMb <= 0 ? 'размер неизвестен' : sizeMb >= 1024
    ? `${(sizeMb / 1024).toFixed(1)} ГБ` : `${sizeMb.toFixed(sizeMb >= 100 ? 0 : 1)} МБ`;
}

/**
 * Статус задания и процент показываются рядом с его явными действиями.
 * Неизвестное серверное состояние остаётся видимым, а не считается успехом.
 */
function jobLabel(job?: SpeechJob): string {
  const labels: Record<string, string> = {
    queued: 'в очереди',
    running: 'выполняется',
    done: 'готово',
    failed: 'ошибка',
    cancelled: 'отменено',
    interrupted: 'прервано перезапуском',
  };

  return job ? `${labels[job.status] ?? job.status}${job.percent === null ? '' : ` · ${job.percent}%`}` : '';
}

/**
 * Проверка окружения является чтением и не применяет неприменённые параметры.
 * Проверка браузерной модели не запрашивает согласие на облачную обработку.
 */
async function refresh(): Promise<void> {
  if (refreshing.value) {
    return;
  }

  refreshing.value = true;

  try {
    await service.resource.refresh(undefined, true);
    browserStatus.value = await probeLocalSpeech(window, text('language'));
  } catch (cause) {
    error.value = failureText(cause);
  } finally {
    refreshing.value = false;
  }
}

watch(() => props.active, async (active) => {
  if (active) {
    try {
      await settings.loadResource('speech');
    } catch (cause) {
      error.value = failureText(cause);
    }
  }
}, { immediate: true });

watch([() => props.active, () => settings.pageId], ([active, page]) => {
  operations.setActive(Boolean(active && ['speech.models', 'speech.advanced'].includes(String(page))));
}, { immediate: true });

watch([() => props.active, () => text('language')], async ([active, language]) => {
  if (active) {
    browserStatus.value = await probeLocalSpeech(window, String(language));
  }
}, { immediate: true });

onBeforeUnmount(() => operations.setActive(false));
</script>

<style scoped>
.settings-speech {
  display: grid;
  align-content: start;
  min-width: 0;
  gap: 0;
}
.settings-speech > p {
  margin: 10px 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}
.settings-speech > .settings-section {
  margin-top: 24px;
}
.settings-speech > :deep(.ui-button) {
  justify-self: start;
  margin-top: 12px;
}
.settings-speech-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.settings-speech-model {
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
