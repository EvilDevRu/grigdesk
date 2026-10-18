<template>
  <UiDialog
    :open="open"
    size="content"
    :body-inset="false"
    data-role="plugin-install-dialog"
    :data-mode="mode"
    :data-view="view"
    :label="heading"
    @update:open="onOpenChange"
  >
    <template #header>
      <div class="install-header">
        <div class="install-head-row">
          <span class="install-brand-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9 8-4.5M12 12 4 7.5M12 12v9M8 5.3l8 4.5" />
            </svg>
          </span>
          <div class="install-head-copy">
            <p>Плагины Cockpit</p>
            <h2 class="install-heading" data-role="install-heading">{{ heading }}</h2>
          </div>
          <UiIconButton label="Закрыть окно установки" @click="onOpenChange(false)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
              <path d="m6 6 12 12M6 18 18 6" />
            </svg>
          </UiIconButton>
        </div>
        <ol class="install-steps" aria-label="Этапы установки">
          <li
            v-for="(step, index) in ['Источник', 'Проверка', 'Установка']"
            :key="step"
            :data-current="activeStep === index && !completed"
            :data-complete="completed || activeStep > index"
            :aria-current="activeStep === index && !completed ? 'step' : undefined"
          >
            <span class="install-step-number" aria-hidden="true">
              {{ completed || activeStep > index ? '✓' : index + 1 }}
            </span>
            {{ step }}
          </li>
        </ol>
      </div>
    </template>
    <div class="install-workspace">
      <div ref="contentElement" class="install-content" data-role="install-scroll">
        <div class="install-stage-heading" :data-tone="stageTone" role="status">
          <span class="install-stage-icon" aria-hidden="true">
            <UiSpinner v-if="view === 'loading' || view === 'progress'" decorative />
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
              <path :d="stageIcon" />
            </svg>
          </span>
          <div class="install-stage-copy">
            <h3>{{ stageHeading }}</h3>
            <p>{{ stageDescription }}</p>
          </div>
        </div>
        <div v-if="view === 'loading'" class="install-bootstrap" data-role="install-loading" role="status">
          <div class="install-skeleton" aria-hidden="true"></div>
          <div class="install-skeleton" aria-hidden="true"></div>
          <div class="install-skeleton install-skeleton-short" aria-hidden="true"></div>
        </div>
        <form v-else-if="view === 'source'" class="install-source" @submit.prevent="findVersions">
          <template v-if="mode === 'install'">
            <UiField id="plugin-install-url" label="Адрес репозитория">
              <div class="install-repository-input">
                <UiInput
                  v-model="url"
                  data-role="install-url"
                  placeholder="https://github.com/owner/plugin"
                  autocomplete="off"
                  spellcheck="false"
                  :disabled="locked"
                />
                <UiButton
                  data-role="install-find"
                  :disabled="locked || !url.trim() || store.versionsLoading"
                  :loading="store.versionsLoading"
                  loading-label="Ищем версии"
                  @click="findVersions"
                >
                  Найти версии
                </UiButton>
              </div>
            </UiField>
          </template>
          <template v-else-if="plugin?.install">
            <p class="install-current-version">
              Установлена v{{ plugin.install.version }} из <span>{{ plugin.install.source.url }}</span>
            </p>
            <template v-if="plugin.install.localChanges">
              <UiInlineMessage tone="warning">В установленной копии есть ручные правки.</UiInlineMessage>
              <UiCheckbox v-model="replaceModified" data-role="install-replace-modified" :disabled="locked">
                Отложить правки в резерв и поставить версию начисто
              </UiCheckbox>
            </template>
          </template>
          <div class="install-version-block" :aria-busy="store.versionsLoading">
            <UiField id="plugin-install-version" label="Версия">
              <UiSelect
                v-model="selectedVersion"
                data-role="install-version"
                aria-describedby="plugin-install-version-status"
                :disabled="locked || store.versionsLoading || !store.versions.length"
              >
                <option value="">— выберите версию —</option>
                <option v-for="version in store.versions" :key="version.tag" :value="version.version">
                  v{{ version.version }}
                </option>
              </UiSelect>
            </UiField>
            <div id="plugin-install-version-status" class="install-version-status" role="status">
              <p v-if="store.versionsLoading" class="install-loading-label">
                <UiSpinner decorative /> Ищем версии в репозитории…
              </p>
              <UiInlineMessage v-else-if="store.versionsError" tone="danger">
                {{ store.versionsError }}
              </UiInlineMessage>
              <p v-else-if="store.versionsUrl && !store.versions.length">В источнике нет тегов вида vX.Y.Z.</p>
              <p v-else-if="store.versions.length">Выберите релиз. По умолчанию выбрана самая новая версия.</p>
              <p v-else>Укажите адрес и нажмите «Найти версии».</p>
            </div>
            <UiButton
              v-if="mode === 'update'"
              :disabled="locked || store.versionsLoading"
              :loading="store.versionsLoading"
              @click="findVersions"
            >
              Обновить список версий
            </UiButton>
          </div>
          <template v-if="mode === 'install'">
            <UiDisclosureButton v-model:open="sourceHelpOpen" controls="plugin-install-source-help">
              SSH и приватные репозитории
            </UiDisclosureButton>
            <p v-if="sourceHelpOpen" id="plugin-install-source-help" class="install-source-help">
              Поддерживаются https://…, ssh://…, git@хост:путь и file:///путь.
              Для приватного репозитория настройте доступ Git на машине, где запущен Cockpit.
            </p>
          </template>
        </form>
        <section v-else-if="view === 'progress'" class="install-preparation">
          <div v-if="store.job" class="install-job-source" data-role="install-job-source">
            <span>{{ store.job.source.kind }} · {{ store.job.source.url }}</span>
            <code data-role="install-job-id">{{ store.job.pluginId ?? '' }}</code>
          </div>
          <ol v-if="store.job" class="install-stage-list" data-role="install-stages">
            <li
              v-for="row in installStageRows(store.job)"
              :key="row.id"
              :data-stage="row.id"
              :data-state="row.state"
            >
              <span class="install-stage-mark" aria-hidden="true">
                <UiSpinner v-if="row.state === 'current'" decorative />
                <template v-else>{{ row.state === 'done' ? '✓' : '·' }}</template>
              </span>
              {{ row.label }}
              <span class="install-stage-status">{{ row.state === 'done' ? 'Готово' : '' }}</span>
            </li>
          </ol>
          <div class="install-progress-area">
            <UiProgress
              v-if="progress"
              data-role="install-progress"
              label="Ход установки"
              :value="progress.value"
              :indeterminate="progress.indeterminate"
            />
            <p v-if="progress && !progress.indeterminate" class="install-percent">{{ progress.value }}%</p>
          </div>
        </section>
        <PluginInstallPreview v-else-if="view === 'ready' && preview" :preview="preview" />
        <section v-else-if="view === 'result' && store.job" class="install-result-layout">
          <div v-if="store.job.preview" class="install-package-summary">
            <div class="install-package-title">
              <h4>{{ store.job.preview.name }}</h4>
              <span>v{{ store.job.preview.version }}</span>
            </div>
            <p class="install-package-id">{{ store.job.preview.id }}</p>
            <dl>
              <dt>Репозиторий</dt>
              <dd>{{ store.job.source.url }}</dd>
              <dt>Коммит</dt>
              <dd class="install-package-sha">{{ shortSha(store.job.preview.target.sha) }}</dd>
            </dl>
          </div>
          <p v-if="completed" class="install-result-message" data-role="install-result">
            {{ installResultText(store.job) }}
          </p>
          <UiInlineMessage v-else data-role="install-result" :tone="resultTone">
            {{ installResultText(store.job) }}
          </UiInlineMessage>
        </section>
      </div>
      <div v-if="store.error || store.recoveryError" class="install-alerts" data-role="install-alerts">
        <UiInlineMessage v-if="store.error" tone="danger" data-role="install-error">
          {{ store.error }}
        </UiInlineMessage>
        <UiInlineMessage v-if="store.recoveryError" tone="danger" data-role="install-recovery">
          {{ store.recoveryError.message }}
        </UiInlineMessage>
      </div>
    </div>
    <template #footer>
      <div class="install-footer">
        <p class="install-footer-hint">{{ footerHint }}</p>
        <div class="install-actions">
          <div class="install-secondary">
            <UiButton
              v-if="view === 'source' || view === 'loading' || view === 'unavailable'"
              block
              data-role="install-dismiss"
              @click="onOpenChange(false)"
            >
              Отмена
            </UiButton>
            <UiButton
              v-else-if="view === 'ready' || view === 'progress' && !clarifying && store.job?.status === 'running'"
              block
              data-role="install-cancel"
              :disabled="locked"
              @click="store.cancel()"
            >
              Отменить
            </UiButton>
            <UiButton
              v-else-if="view === 'result' && store.job?.status === 'failed'"
              block
              data-role="install-close"
              @click="onOpenChange(false)"
            >
              Закрыть
            </UiButton>
          </div>
          <div class="install-primary">
            <UiButton v-if="view === 'loading'" block disabled loading>Проверяем состояние</UiButton>
            <UiButton
              v-else-if="view === 'unavailable'"
              block
              variant="solid"
              tone="accent"
              data-role="install-reload"
              @click="loadCurrent"
            >
              Повторить загрузку
            </UiButton>
            <UiButton
              v-else-if="view === 'source'"
              block
              variant="solid"
              tone="accent"
              data-role="install-start"
              :disabled="!canStart"
              :loading="store.busy"
              @click="start"
            >
              Скачать и проверить
            </UiButton>
            <UiButton
              v-else-if="view === 'ready'"
              block
              variant="solid"
              tone="accent"
              data-role="install-apply"
              :disabled="locked"
              @click="confirmApply"
            >
              {{ store.job?.kind === 'update' || preview?.replaces.kind === 'managed' ? 'Обновить' : 'Установить' }}
            </UiButton>
            <UiButton
              v-else-if="view === 'result' && store.job?.status === 'failed'"
              block
              variant="solid"
              tone="accent"
              data-role="install-retry"
              :disabled="locked"
              @click="retry"
            >
              Попробовать снова
            </UiButton>
            <UiButton
              v-else
              block
              :variant="completed ? 'solid' : 'outline'"
              :tone="completed ? 'accent' : 'neutral'"
              :data-role="view === 'result' ? 'install-close' : 'install-dismiss'"
              @click="onOpenChange(false)"
            >
              {{ completed ? 'Готово' : 'Закрыть' }}
            </UiButton>
          </div>
        </div>
      </div>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue';

import {
  UiDialog,
  UiButton,
  UiIconButton,
  UiInput,
  UiSelect,
  UiInlineMessage,
  UiProgress,
  UiCheckbox,
  UiDisclosureButton,
  UiField,
  UiSpinner,
} from '../../ui';
import PluginInstallPreview from './PluginInstallPreview.vue';
import { usePluginInstallStore } from '../../stores/pluginInstall.ts';
import { deriveInstallDialogView } from '../../shared/pluginInstallView.ts';
import {
  isTerminalInstallJob,
  installStageRows,
  installResultText,
  shortSha,
} from '../../shared/pluginInstall.ts';
import type { PluginListItem } from '../../../../shared/plugins/pluginsContracts.ts';

const props = defineProps<{
  open: boolean;
  mode: 'install' | 'update';
  plugin: PluginListItem | null;
}>();
const emit = defineEmits<{ 'update:open': [value: boolean] }>();
const store = usePluginInstallStore();
const url = ref('');
const selectedVersion = ref('');
const replaceModified = ref(false);
const sourceHelpOpen = ref(false);
const bootLoading = ref(false);
const bootFailed = ref(false);
const contentElement = ref<HTMLElement | null>(null);
let openingEpoch = 0;
let disposed = false;

const dialogView = computed(() => deriveInstallDialogView({
  job: store.job,
  mode: props.mode,
  pluginName: props.plugin?.name ?? null,
  pluginLocalChanges: Boolean(props.plugin?.install?.localChanges),
  bootLoading: bootLoading.value,
  bootFailed: bootFailed.value,
  error: store.error,
  recoveryError: store.recoveryError,
  pendingAction: store.pendingAction,
  reconciling: store.reconciling,
  busy: store.busy,
  versionsLoading: store.versionsLoading,
  versionsInputKey: store.versionsInputKey,
  versionsUrl: store.versionsUrl,
  url: url.value,
  selectedVersion: selectedVersion.value,
  replaceModified: replaceModified.value,
}));

const heading = computed(() => dialogView.value.heading);
const clarifying = computed(() => dialogView.value.clarifying);
const locked = computed(() => dialogView.value.locked);
const view = computed(() => dialogView.value.screen);
const progress = computed(() => dialogView.value.progress);
const preview = computed(() => dialogView.value.preview);
const stageLabel = computed(() => dialogView.value.stageLabel);
const progressHeading = computed(() => dialogView.value.progressHeading);
const activeStep = computed(() => dialogView.value.activeStep);
const completed = computed(() => dialogView.value.completed);
const footerHint = computed(() => dialogView.value.footerHint);
const resultHeading = computed(() => dialogView.value.resultHeading);
const resultTone = computed(() => dialogView.value.resultTone);
const stageHeading = computed(() => dialogView.value.stageHeading);
const stageDescription = computed(() => dialogView.value.stageDescription);
const stageTone = computed(() => dialogView.value.stageTone);
const stageIcon = computed(() => dialogView.value.stageIcon);
const canStart = computed(() => dialogView.value.canStart);

/**
 * Поиск привязан к текущему input key, а не изменённому сервером canonical URL.
 * Выбор берётся из принятого списка, поэтому поздний ответ не возвращает старую версию.
 */
async function findVersions(): Promise<void> {
  if (disposed || !props.open || locked.value || store.versionsLoading || !url.value.trim()) {
    return;
  }

  const epoch = openingEpoch;

  await store.listVersions(url.value);

  if (!disposed && props.open && epoch === openingEpoch && store.versionsInputKey === url.value.trim()) {
    selectedVersion.value = store.versions[0]?.version ?? '';
  }
}

/**
 * Два clicks в одном DOM tick проверяют живой store до обращения к API.
 * Disabled разметка обновится позднее, поэтому одного атрибута кнопки недостаточно.
 */
async function confirmApply(): Promise<void> {
  if (!locked.value && store.job?.status === 'ready') {
    await store.apply();
  }
}

/**
 * Подготовка отправляет только выбранную версию проверенного для этого ввода списка.
 * Ручная карточка добавляет expectedId, чтобы привязка не установила соседний пакет.
 */
async function start(): Promise<void> {
  if (!canStart.value) {
    return;
  }

  if (props.mode === 'update' && props.plugin?.install) {
    await store.startUpdate(props.plugin.id, selectedVersion.value, replaceModified.value);
  } else if (props.plugin?.id) {
    await store.startInstall(
      store.versionsUrl, selectedVersion.value, replaceModified.value, props.plugin.id,
    );
  } else {
    await store.startInstall(store.versionsUrl, selectedVersion.value, replaceModified.value);
  }
}

/**
 * Закрытие прочитанного terminal отмечает результат, но не отменяет активную работу.
 * Ready и recovery сохраняют серверное задание для повторного открытия или восстановления.
 */
function onOpenChange(open: boolean): void {
  if (!open && view.value === 'result' && isTerminalInstallJob(store.job)) {
    store.forgetJob();
  }

  emit('update:open', open);
}

watch(url, (value, old) => {
  if (value.trim() !== old.trim()) {
    selectedVersion.value = '';
    store.invalidateVersions(value);
  }
});

// Каждый новый экран начинается с общего заголовка. Прокрутка длинного diff
// не переносится на итог, а фоновое обновление того же шага сохраняет позицию.
watch(view, () => {
  if (contentElement.value) {
    contentElement.value.scrollTop = 0;
  }
}, { flush: 'post' });

/**
 * Пока current не прочитан, новая операция недоступна: сервер мог сохранить старую.
 * При повторном открытии уже известное задание остаётся на месте без загрузочной вспышки.
 */
async function loadCurrent(): Promise<void> {
  const epoch = ++openingEpoch;

  bootLoading.value = true;
  bootFailed.value = false;

  try {
    await store.loadJob();
  } finally {
    if (!disposed && props.open && epoch === openingEpoch) {
      bootLoading.value = false;
      bootFailed.value = !store.job && !!store.error;
    }
  }

  if (disposed || !props.open || epoch !== openingEpoch || bootFailed.value) {
    return;
  }

  await prepareUpdate(epoch);
}

/**
 * Возврат из ошибки обновления снова подбирает версии того же источника.
 * Поздний ответ закрытого диалога не начинает поиск и не сбрасывает выбор в новом открытии.
 */
async function prepareUpdate(epoch: number): Promise<void> {
  if (!store.job && !store.recoveryError && props.mode === 'update' && props.plugin?.install) {
    url.value = props.plugin.install.source.url;
    selectedVersion.value = '';
    replaceModified.value = false;
    await nextTick();

    if (disposed || !props.open || epoch !== openingEpoch) {
      return;
    }

    await findVersions();
  }
}

async function retry(): Promise<void> {
  if (!locked.value && store.forgetJob()) {
    await prepareUpdate(openingEpoch);
  }
}

watch(() => props.open, (open) => {
  if (open) {
    void loadCurrent();
  } else {
    openingEpoch += 1;
  }
}, { immediate: true });

onBeforeUnmount(() => {
  disposed = true;
  openingEpoch += 1;
});
</script>

<style scoped>
.install-header {
  display: grid;
  gap: 1rem;
  width: 100%;
  min-width: 0;
}
.install-head-row {
  display: grid;
  grid-template-columns: 2.5rem minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.75rem;
  height: 3rem;
}
.install-brand-icon,
.install-stage-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 0.75rem;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--accent);
}
.install-brand-icon svg,
.install-stage-icon svg {
  width: 1.5rem;
  height: 1.5rem;
}
.install-head-copy {
  min-width: 0;
}
.install-head-copy p {
  margin: 0 0 0.2rem;
  color: var(--ink-mid);
  font-size: 0.6875rem;
  line-height: 1.2;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.install-heading {
  overflow: hidden;
  margin: 0;
  font-size: 1rem;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.install-steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 0.75rem;
}
.install-steps li {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: 2.25rem;
  padding: 0 0.625rem;
  border-radius: 0.5rem;
  color: var(--ink-low);
}
.install-steps [data-current='true'] {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--accent);
  font-weight: 600;
}
.install-steps [data-complete='true'] {
  color: var(--good);
}
.install-step-number {
  display: grid;
  place-items: center;
  flex: none;
  width: 1.375rem;
  height: 1.375rem;
  border: 1px solid var(--line-2);
  border-radius: 50%;
  font-variant-numeric: tabular-nums;
}
[data-current='true'] .install-step-number,
[data-complete='true'] .install-step-number {
  border-color: currentColor;
}
.install-workspace {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  min-height: 0;
}
.install-alerts {
  display: grid;
  gap: 0.5rem;
  flex: none;
  max-height: 8rem;
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--line);
  overflow: auto;
  font-size: 0.8125rem;
}
.install-content {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  gap: 1rem;
  width: 100%;
  min-width: 0;
  padding: 1.25rem;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  font-size: 0.875rem;
  line-height: 1.55;
}
.install-content > * {
  flex-shrink: 0;
}
.install-content h3,
.install-content p {
  margin: 0;
}
.install-stage-heading {
  display: grid;
  grid-template-columns: 2.75rem minmax(0, 1fr);
  align-items: start;
  gap: 0.875rem;
  height: 4.5rem;
}
.install-stage-icon {
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 50%;
}
.install-stage-copy h3 {
  font-size: 1.125rem;
  line-height: 1.35;
  font-weight: 600;
}
.install-stage-copy p {
  margin-top: 0.375rem;
  color: var(--ink-mid);
  font-size: 0.8125rem;
  line-height: 1.5;
}
.install-stage-heading[data-tone='success'] .install-stage-icon {
  color: var(--good);
  background: color-mix(in srgb, var(--good) 12%, transparent);
}
.install-stage-heading[data-tone='danger'] .install-stage-icon {
  color: var(--bad);
  background: color-mix(in srgb, var(--bad) 12%, transparent);
}
.install-stage-heading[data-tone='warning'] .install-stage-icon {
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 12%, transparent);
}
.install-source,
.install-bootstrap,
.install-preparation,
.install-result-layout {
  display: grid;
  align-content: start;
  gap: 1rem;
  min-width: 0;
}
.install-repository-input {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.5rem;
}
.install-version-block {
  display: grid;
  gap: 0.5rem;
}
.install-source-help,
.install-version-status,
.install-current-version {
  color: var(--ink-mid);
  font-size: 0.8125rem;
}
.install-version-status {
  min-height: 2.75rem;
}
.install-loading-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.install-current-version,
.install-job-source,
.install-package-summary {
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--ground);
  overflow-wrap: anywhere;
}
.install-job-source {
  display: grid;
  gap: 0.35rem;
  color: var(--ink-mid);
  font-size: 0.8125rem;
}
.install-job-source code {
  height: 1.25rem;
  min-width: 0;
  overflow: hidden;
  font-family: var(--mono);
  line-height: 1.25rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.install-stage-list {
  display: grid;
  gap: 0.25rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.install-stage-list li {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 2.5rem;
  padding: 0.375rem 0.5rem;
  border-radius: 0.5rem;
  color: var(--ink-mid);
}
.install-stage-list [data-state='current'] {
  background: var(--surface-2);
  color: var(--ink);
}
.install-stage-mark {
  display: grid;
  place-items: center;
  width: 1.25rem;
  flex: none;
  color: var(--accent);
}
[data-state='done'] .install-stage-mark {
  color: var(--good);
}
.install-stage-status {
  flex: none;
  width: 3rem;
  margin-left: auto;
  color: var(--ink-low);
  font-size: 0.75rem;
  text-align: right;
}
.install-progress-area {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 3rem;
  align-items: center;
  gap: 0.75rem;
  height: 1.5rem;
}
.install-percent {
  text-align: right;
  color: var(--ink-mid);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}
.install-package-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.install-package-title h4 {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 600;
}
.install-package-title span {
  padding: 0.1rem 0.5rem;
  border-radius: 0.375rem;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 0.75rem;
}
.install-package-id,
.install-package-sha {
  font-family: var(--mono);
  font-size: 0.75rem;
  color: var(--ink-mid);
}
.install-package-summary dl {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.5rem 1rem;
  margin: 1rem 0 0;
  padding-top: 0.75rem;
  border-top: 1px solid var(--line);
  font-size: 0.8125rem;
}
.install-package-summary dt {
  color: var(--ink-mid);
}
.install-package-summary dd {
  margin: 0;
}
.install-result-message {
  color: var(--ink-mid);
  line-height: 1.7;
}
.install-skeleton {
  height: 3.5rem;
  border-radius: var(--radius);
  background: var(--surface-2);
}
.install-skeleton-short {
  width: 65%;
  height: 1rem;
}
.install-footer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 19rem;
  align-items: center;
  gap: 1rem;
  width: 100%;
}
.install-footer-hint {
  display: flex;
  align-items: center;
  height: 2.5rem;
  margin: 0;
  color: var(--ink-mid);
  font-size: 0.75rem;
  line-height: 1.5;
}
.install-actions {
  display: grid;
  grid-template-columns: 6.5rem minmax(0, 1fr);
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}
.install-secondary,
.install-primary {
  min-width: 0;
}
@media (max-width: 600px) {
  .install-footer {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.5rem;
  }
  .install-footer-hint {
    height: 2.25rem;
  }
}
@media (max-width: 420px) {
  .install-content {
    padding: 1rem;
  }
  .install-repository-input {
    grid-template-columns: minmax(0, 1fr);
  }
  .install-stage-heading {
    height: 6rem;
  }
  .install-steps {
    gap: 0.25rem;
    font-size: 0.6875rem;
  }
  .install-steps li {
    padding-inline: 0.25rem;
    gap: 0.375rem;
  }
  .install-package-summary dl {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.25rem;
  }
  .install-package-summary dt:not(:first-child) {
    margin-top: 0.5rem;
  }
}
@media (max-height: 500px) {
  .install-header { gap: 8px; }
  .install-head-copy p { display: none; }
  .install-head-row { height: auto; }
  .install-stage-heading { grid-template-columns: minmax(0, 1fr); height: auto; min-height: 0; padding-block: 8px; }
  .install-stage-icon { display: none; }
  .install-content { padding: 8px 16px; }
}
</style>
