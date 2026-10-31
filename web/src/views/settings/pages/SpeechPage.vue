<template>
  <div
    class="settings-speech"
    :data-settings-speech-page="settings.pageId"
    :data-ready="loaded"
  >
    <SettingsScope />
    <p v-if="error || operations.message.value" role="alert">{{ error || operations.message.value }}</p>
    <UiLoadingState v-if="!loaded && !error" :label="t('settings.loadingSpeechSettings')"
      variant="document" >
      <UiSkeletonLayout layout="form" :header="false" />
    </UiLoadingState>
    <template v-else-if="loaded">
      <template v-if="settings.pageId === 'speech.dictation'">
        <SettingsField :address="address('engine')">
          <UiSelect :model-value="text('engine')" @update:model-value="edit('engine', $event)">
            <option value="browser">{{ t('settings.browser') }}</option>
            <option value="whisper">{{ t('settings.whisperOnServer') }}</option>
          </UiSelect>
        </SettingsField>
        <SettingsField :address="address('browserProcessing')">
          <UiSelect
            :model-value="text('browserProcessing')"
            @update:model-value="edit('browserProcessing', $event)"
          >
            <option value="auto">{{ t('settings.browserSelectsProcessing') }}</option>
            <option value="local">{{ t('settings.localBrowserOnly') }}</option>
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
        <SettingsSection :heading="t('settings.sectionHowSpeechIsProcessed')">
          <SettingsFacts :items="speechFacts" />
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
        <UiButton
          data-context="workspace-form-wrap"
          data-speech-prompt-reset
          @click="edit('videoInitialPrompt', null)"
        >
          {{ t('settings.restoreDefaultPrompt') }}
        </UiButton>
        <p v-if="value('videoInitialPrompt') === null">
          {{ t('settings.afterApplyingTheServerWillUseIts') }}
        </p>
      </template>
      <template v-else-if="settings.pageId === 'speech.language'">
        <SettingsField :address="address('language')">
          <UiSelect :model-value="text('language')" @update:model-value="edit('language', $event)">
            <option value="auto">{{ t('settings.automatic') }}</option>
            <option value="ru">{{ t('settings.russian') }}</option>
            <option value="en">{{ t('settings.english') }}</option>
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
        <UiButton data-context="workspace-form-wrap" @click="edit('dictionary', GRIGDESK_DICTIONARY)">{{ t('settings.insertGrigDeskTerms') }}</UiButton>
        <p v-if="view.capabilities.lastDictionaryMeasure">
          {{ t('settings.lastDictionaryMeasurement') }} {{ view.capabilities.lastDictionaryMeasure.hotwordsTokens }} {{ t('settings.tokens') }}
          {{ view.capabilities.lastDictionaryMeasure.hotwordsTruncated ? t('settings.dictionaryTruncated') : '' }}.
        </p>
      </template>
      <template v-else-if="settings.pageId === 'speech.models'">
        <p>{{ t('settings.downloadsCopiesAndCancellationsTakeEffectImmediately') }}</p>
        <p v-if="!view.capabilities.models.length">{{ t('settings.theServerHasNotReportedTheModel') }}</p>
        <ul v-if="view.capabilities.models.length" class="settings-speech-models">
          <SpeechModelRow
            v-for="model in view.capabilities.models"
            :key="model.modelId"
            :model="model"
            :job="operations.jobFor(model.modelId)"
            :busy="modelBusy(model.modelId)"
            :active="operations.isActive(operations.jobFor(model.modelId))"
            :cancelling="operations.busy.value.includes(`cancel:${operations.jobFor(model.modelId)?.jobId}`)"
            :verified="modelCacheVerified"
            :can-download="canDownloadModels"
            @start="operations.start"
            @cancel="operations.cancel"
          />
        </ul>
      </template>
      <template v-else-if="settings.pageId === 'speech.advanced'">
        <SettingsSection :heading="t('settings.sectionRecognitionModels')">
          <SettingsField
            v-for="key in ['model', 'videoModel']"
            :key="key"
            :address="address(key)"
          >
            <UiSelect :model-value="text(key)" @update:model-value="edit(key, $event === '' ? null : $event)">
              <option value="">{{ t('settings.presetDefault') }}</option>
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
        <SettingsSection :heading="t('settings.sectionServerProcessing')">
          <SettingsField :address="address('device')">
            <UiSelect :model-value="text('device')" @update:model-value="edit('device', $event)">
              <option value="auto">{{ t('settings.automatic') }}</option>
              <option value="cpu">CPU</option>
              <option value="cuda" :disabled="!cudaReady">CUDA</option>
            </UiSelect>
          </SettingsField>
          <SettingsField :address="address('computeType')">
            <UiSelect
              :model-value="text('computeType')"
              @update:model-value="edit('computeType', $event === '' ? null : $event)"
            >
              <option value="">{{ t('settings.deviceDefault') }}</option>
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
              :placeholder="t('settings.presetDefault')"
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
        <SettingsSection :heading="t('settings.sectionEnvironmentAndBenchmark')">
          <p>
            Whisper:
            {{ view.capabilities.local.ready ? t('settings.ready2') : view.capabilities.local.reason || t('settings.notReady') }}.
          </p>
          <ul>
            <li v-for="check in view.capabilities.local.checks" :key="check.name">
              {{ speechCheckName(check.name, uiLocale) }} ·
              {{ check.ok ? t('settings.done2') : check.fix || t('settings.needsAttention') }}
            </li>
          </ul>
          <p>CUDA: {{ cudaReason }}.</p>
          <p v-if="!cudaReady">
            {{ t('settings.libraryInstallation') }}
            <code>deploy/install.sh --with-cuda</code>
            .
          </p>
          <UiButton data-context="workspace-form-wrap" :disabled="refreshing" @click="refresh">{{ t('settings.recheckEnvironmentAndCache') }}</UiButton>
        </SettingsSection>
        <SettingsSection :heading="t('settings.sectionReferenceRecordingBenchmark')">
          <p>
            {{ t('settings.model') }} {{ benchmarkParameters.modelId }} · {{ benchmarkParameters.language }} ·
            {{ benchmarkParameters.device }} · {{ benchmarkParameters.computeType }}.
          </p>
          <UiButton data-context="workspace-form-wrap"
            data-benchmark
            :disabled="benchmarkDisabled"
            @click="operations.start('benchmark')"
          >
            {{ t('settings.benchmark') }}
          </UiButton>
          <p v-if="!view.capabilities.benchmark.available">
            {{ view.capabilities.benchmark.reason }} {{ t('settings.referenceWAVIsConfiguredThrough') }}
            <code>GRIGDESK_SPEECH_BENCHMARK_AUDIO</code>
            .
          </p>
          <template v-if="benchmarkJob">
            <p>{{ speechJobLabel(benchmarkJob, uiLocale) }}</p>
            <UiProgress
              v-if="benchmarkJob.percent !== null"
              :label="t('settings.benchmarkProgress')"
              :value="benchmarkJob.percent"
            />
            <UiButton data-context="workspace-form-wrap" v-if="operations.isActive(benchmarkJob)" @click="operations.cancel(benchmarkJob)">
              {{ t('settings.cancelBenchmark') }}
            </UiButton>
            <p v-if="benchmarkJob.error" role="alert">{{ benchmarkJob.error }}</p>
            <p v-if="benchmarkJob.status === 'done'">{{ speechBenchmarkText(benchmarkJob, uiLocale) }}</p>
          </template>
        </SettingsSection>
      </template>
      <SettingsSection
        v-if="['speech.dictation', 'speech.video'].includes(settings.pageId)"
        data-speech-server-setup
        :heading="t('settings.speechSetupHeading')"
        :description="t('settings.speechSetupDescription')"
      >
        <SettingsFacts :items="serverFacts" />
        <div
          v-for="check in missingEnvironmentChecks"
          :key="check.name"
          class="settings-speech-repair"
        >
          <strong>{{ speechCheckName(check.name, uiLocale) }}</strong>
          <code v-if="check.fix">{{ check.fix }}</code>
        </div>
        <p v-if="!canDownloadModels">{{ t('settings.speechSetupRuntimeRequired') }}</p>
        <ul v-if="selectedModel" class="settings-speech-models">
          <SpeechModelRow
            :model="selectedModel"
            :job="operations.jobFor(selectedModel.modelId)"
            :busy="modelBusy(selectedModel.modelId)"
            :active="operations.isActive(operations.jobFor(selectedModel.modelId))"
            :cancelling="operations.busy.value
              .includes(`cancel:${operations.jobFor(selectedModel.modelId)?.jobId}`)"
            :verified="modelCacheVerified"
            :can-download="canDownloadModels"
            @start="operations.start"
            @cancel="operations.cancel"
          />
        </ul>
        <p v-else>{{ t('settings.speechSetupModelUnknown', { modelId: selectedModelId }) }}</p>
        <p v-if="selectedModel && !selectedModel.cached">{{ t('settings.speechSetupDownloadImmediate') }}</p>
        <UiButton data-speech-recheck :disabled="refreshing" @click="refresh">
          {{ refreshing ? t('settings.checking') : t('settings.speechSetupRecheck') }}
        </UiButton>
      </SettingsSection>
    </template>
  </div>
</template>

<script setup lang="ts">
import { UiSkeletonLayout } from '../../../ui';

import { t, uiLocale } from '../../../ui.ts';

import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import SettingsScope from '../SettingsScope.vue';
import SettingsSection from '../SettingsSection.vue';
import SettingsFacts from '../SettingsFacts.vue';
import SpeechModelRow from '../SpeechModelRow.vue';
import {
  UiButton,
  UiSelect,
  UiTextarea,
  UiNumberInput,
  UiSwitch,
  UiProgress,
  UiLoadingState,
} from '../../../ui.ts';
import { api, failureText } from '../../../shared/apiClient.ts';
import { useSettingsStore } from '../../../stores/settings.ts';
import { useChatStore } from '../../../stores/chat.ts';
import { sseSubscribe } from '../../../composables/useSse.ts';
import { SETTINGS_FIELDS, getSettingsFields } from '../../../features/settings/catalog.ts';
import type { FieldAddress, JsonValue } from '../../../features/settings/contracts.ts';
import {
  createSpeechResource,
  SPEECH_MODELS,
  SPEECH_QUALITIES,
  QUALITY_MODELS,
  GRIGDESK_DICTIONARY,
  speechCheckName,
} from '../../../features/settings/resources/speech.ts';
import {
  createSpeechOperations,
  speechBenchmarkText,
  speechJobLabel,
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
  }, uiLocale);
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

  return cuda.state === 'ready' ? t('settings.done') : cuda.reason
    || (cuda.state === 'no_device' ? t('settings.nvidiaGPUNotDetected')
      : cuda.state === 'missing_library'
        ? t('settings.cudaLibrariesAreNotInstalled') : t('settings.couldNotCheckCUDA'));
});
const browserStatusLabel = computed(() => ({
  available: t('settings.ready'),
  downloadable: t('settings.canDownloadOnFirstUse'),
  downloading: t('settings.downloading2'),
  unavailable: t('settings.unavailable3'),
  unknown: t('settings.checking'),
} as Record<string, string>)[browserStatus.value] ?? browserStatus.value);
const dictationModel = computed(() => text('model') || QUALITY_MODELS[text('quality')] || 'medium');
const videoModel = computed(() => text('videoModel') || QUALITY_MODELS[text('videoQuality')] || 'medium');
const selectedModelId = computed(() => settings.pageId === 'speech.video'
  ? videoModel.value : dictationModel.value);
const selectedModel = computed(() => view.value.capabilities.models.find((model) =>
  model.modelId === selectedModelId.value));
const missingEnvironmentChecks = computed(() => view.value.capabilities.environmentChecks
  .filter((check) => !check.ok));
const modelCacheVerified = computed(() => !missingEnvironmentChecks.value.some((check) =>
  check.name === 'диагностика кэша моделей' || check.name === 'диагностика media runtime'));
const canDownloadModels = computed(() => !missingEnvironmentChecks.value.some((check) =>
  check.name.startsWith('python venv') || check.name.startsWith('faster-whisper')));
const serverFacts = computed(() => [{
  label: t('settings.speechSetupEnvironment'),
  value: view.value.capabilities.environmentReady === true ? t('settings.speechSetupReady')
    : view.value.capabilities.environmentReady === false ? t('settings.speechSetupMissing')
      : t('settings.speechSetupUnknown'),
}]);
const speechFacts = computed(() => [
  { label: t('settings.speechFactPath'), value: effectivePath.value },
  { label: t('settings.speechFactBrowserModel'), value: browserStatusLabel.value },
  {
    label: t('settings.speechFactConsent'),
    value: view.value.browserAutoConsent ? t('settings.given') : t('settings.notGiven'),
  },
  {
    label: t('settings.speechFactModels'),
    value: t('settings.speechFactModelsValue', { dictation: dictationModel.value, video: videoModel.value }),
  },
]);
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
  const capabilities = view.value.capabilities;
  const ready = capabilities.environmentReady === true
    && capabilities.models.some((model) => model.modelId === dictationModel.value && model.cached);
  const localReason = missingEnvironmentChecks.value[0]?.name
    || (capabilities.environmentReady !== true
      ? capabilities.local.reason || t('settings.speechSetupUnknown')
      : t('settings.speechCheckModel', { modelId: dictationModel.value }));

  if (text('engine') === 'whisper') {
    return ready ? t('settings.whisperOnTheGrigDeskServer')
      : t('settings.unavailable4', { localReason });
  }
  if (!browserSpeechRecognition(window)
      || text('browserProcessing') === 'local' && browserStatus.value === 'unavailable') {
    return ready ? t('settings.whisperFallbackBrowserModeUnavailable')
      : t('settings.unavailableBrowserModeAndWhisperAreNot', { localReason });
  }

  if (text('browserProcessing') !== 'local') {
    return t('settings.browserProcessingIsSelectedByTheBrowser');
  }

  return browserStatus.value === 'downloadable' ? t('settings.localBrowserModelDownloadsOnFirstUse')
    : browserStatus.value === 'downloading' ? t('settings.localBrowserDownloadingModel')
      : t('settings.localBrowserOnThisDevice');
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
    fast: t('settings.fast'),
    balanced: t('settings.normal'),
    accurate: t('settings.accurate'),
  };

  return labels[quality] ?? quality;
}

function modelBusy(modelId: string): boolean {
  return operations.isActive(operations.jobFor(modelId))
    || operations.busy.value.some((key) => key === `download:${modelId}` || key === `copy:${modelId}`);
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
  error.value = '';

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
  operations.setActive(Boolean(active && [
    'speech.dictation', 'speech.video', 'speech.models', 'speech.advanced',
  ].includes(String(page))));
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
  margin-top: 16px;
}
.settings-speech > :deep(.ui-button) {
  justify-self: start;
  margin-top: 12px;
}
/* Модель — строка списка: имя и источник слева, состояние и действия справа.
   Ход операции и ошибка идут ниже на всю ширину строки. */
.settings-speech-models {
  display: grid;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}
.settings-speech-repair {
  display: grid;
  gap: 4px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.settings-speech-repair strong {
  font-weight: 500;
}
.settings-speech-repair code {
  white-space: pre-wrap;
  color: var(--ink-mid);
}
</style>
