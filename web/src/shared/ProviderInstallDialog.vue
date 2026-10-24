<template>
  <UiDialog
    v-if="install.visible"
    :open="install.visible"
    :label="heading"
    size="compact"
    :body-inset="false"
    mobile-fullscreen
    data-role="provider-install-dialog"
    @close="install.visible = false"
  >
    <div class="provider-install" :data-tone="tone">
      <header class="provider-install-head">
        <span class="provider-install-logo" :style="brandStyle" aria-hidden="true">
          <ProviderIcon :provider="iconProvider" :size="20" />
        </span>
        <div class="provider-install-titles">
          <h2 class="provider-install-heading">{{ heading }}</h2>
          <code v-if="job" class="provider-install-command">{{ job.command }}</code>
        </div>
      </header>
      <UiProgress v-if="job?.status === 'running'" size="line" indeterminate :label="currentStage" />

      <div class="provider-install-body">
        <template v-if="job">
          <p v-if="job.status !== 'running'" class="provider-install-status" role="status">
            <svg class="provider-install-status-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <path :d="tone === 'success' ? STATUS_CHECK_PATH : STATUS_ALERT_PATH" />
            </svg>
            <span class="provider-install-status-text">
              {{ resultLines[0] }}
              <span v-if="resultLines[1]" class="provider-install-status-detail">{{ resultLines[1] }}</span>
            </span>
          </p>
          <ol class="provider-install-steps">
            <li
              v-for="entry in stages"
              :key="entry.stage"
              :data-state="entry.state"
              :aria-current="entry.state === 'current' ? 'step' : undefined"
            >
              <span class="provider-install-mark" aria-hidden="true">
                <UiSpinner v-if="entry.state === 'current'" decorative />
                <svg v-else viewBox="0 0 24 24"><path :d="STAGE_ICONS[entry.state]" /></svg>
              </span>
              {{ entry.label }}
            </li>
          </ol>
          <p
            v-if="job.status === 'running' && job.stage === 'download-install' && job.retry"
            class="provider-install-note"
            role="status"
          >
            {{ t('settings.providerInstallationRetry', job.retry) }}
          </p>
          <section v-if="job.outputTail" class="provider-install-log">
            <UiDisclosureButton
              v-if="job.status === 'succeeded'"
              v-model:open="outputOpen"
              class="provider-install-log-toggle"
              density="compact"
              :controls="outputId"
            >{{ t('settings.providerInstallationOutput') }}</UiDisclosureButton>
            <pre
              v-show="outputVisible"
              :id="outputId"
              ref="outputElement"
              class="provider-install-output"
              :aria-label="t('settings.providerInstallationOutput')"
            >{{ job.outputTail }}</pre>
          </section>
          <p v-if="job.status === 'succeeded' && job.operation === 'install'" class="provider-install-note">
            {{ t('settings.providerInstallationOldTerminal') }}
          </p>
        </template>

        <UiInlineMessage v-if="install.uncertain" tone="warning">
          {{ t('settings.providerInstallationUnknown') }}
        </UiInlineMessage>
        <UiInlineMessage v-if="install.selectedFailure" tone="danger">
          {{ install.selectedFailure.message }}
        </UiInlineMessage>
        <UiInlineMessage v-if="install.snapshot.blockedReason" tone="danger">
          {{ providerInstallNoticeText(install.snapshot.blockedReason) }}
        </UiInlineMessage>
        <UiInlineMessage v-if="install.error" tone="danger">{{ install.error }}</UiInlineMessage>
      </div>

      <footer class="provider-install-foot">
        <p v-if="job?.status === 'running'" class="provider-install-note provider-install-foot-note">
          {{ t('settings.providerInstallationBackground') }}
        </p>
        <UiButton
          v-if="install.error || install.uncertain"
          @click="install.load()"
        >{{ t('settings.providerInstallationRefresh') }}</UiButton>
        <UiButton variant="ghost" @click="install.visible = false">
          {{ t('settings.providerInstallationClose') }}
        </UiButton>
        <UiButton
          v-if="fallbackCommand"
          variant="solid"
          tone="accent"
          @click="openTerminal(fallbackCommand)"
        >{{ t('settings.providerInstallationTerminal') }}</UiButton>
        <UiButton
          v-if="loginCommand"
          variant="solid"
          tone="accent"
          @click="openTerminal(loginCommand)"
        >{{ t('settings.providerInstallationLogin') }}</UiButton>
      </footer>
    </div>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue';

import type { ProviderInstallStage } from '../../../shared/chat/providerInstallContracts.ts';
import type { MessageKey } from '../../../shared/i18n/catalogs.ts';
import {
  UiButton,
  UiDialog,
  UiDisclosureButton,
  UiInlineMessage,
  UiProgress,
  UiSpinner,
  t,
  uiLocale,
  resolveUiText,
} from '../ui.ts';
import { useSse } from '../composables/useSse.ts';
import {
  useProviderInstallStore,
  providerInstallResultText,
  providerInstallNoticeText,
} from '../stores/providerInstall.ts';
import { useProvidersStore } from '../stores/providers.ts';
import { useAuthStore } from '../stores/auth.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { createSettingsActions } from '../features/settings/actions.ts';
import { useToolLauncher } from './tools/launcher.ts';
import ProviderIcon from './ProviderIcon.vue';

type StageState = 'done' | 'current' | 'warning' | 'failed' | 'pending';

const STATUS_CHECK_PATH = 'M7.5 12.3l3 3 6-6.3';
const STATUS_ALERT_PATH = 'M12 7.5v5.5M12 16.5v.01';
const STAGE_ICONS: Readonly<Record<Exclude<StageState, 'current'>, string>> = {
  done: 'M5 12.5l4.5 4.5L19 7.5',
  warning: 'M12 6.5v7M12 17.5v.01',
  failed: 'M12 6.5v7M12 17.5v.01',
  pending: 'M12 5a7 7 0 1 1 0 14a7 7 0 1 1 0-14',
};
const STAGES: readonly ProviderInstallStage[] = ['download-install', 'version', 'models'];
const STAGE_LABELS: Readonly<Record<ProviderInstallStage, MessageKey>> = {
  'download-install': 'settings.providerInstallationDownloadInstall',
  version: 'settings.providerInstallationVersion',
  models: 'settings.providerInstallationModels',
};

const install = useProviderInstallStore();
const providers = useProvidersStore();
const settings = useSettingsStore();
const auth = useAuthStore();
const launcher = useToolLauncher();
const outputId = `provider-install-output-${useId().replaceAll(':', '')}`;
const outputElement = ref<HTMLElement | null>(null);
const outputOpen = ref(false);

const job = computed(() => install.selectedJob);
const provider = computed(() => providers.providers.find((entry) => entry.id === install.providerId));
const iconProvider = computed(() => ({
  id: install.providerId,
  name: provider.value?.name || install.providerId || '?',
}));
const brandStyle = computed(() => provider.value?.color
  ? { '--provider-install-brand': provider.value.color } : undefined);
const fallbackCommand = computed(() => install.selectedFailure?.fallbackCommand
  || (job.value && ['failed', 'interrupted'].includes(job.value.status) ? job.value.fallbackCommand : ''));
const loginCommand = computed(() => {
  const finished = job.value?.status === 'succeeded' ? job.value : null;
  const needsLogin = finished?.operation === 'install' || provider.value?.available === false;

  return finished && needsLogin ? finished.loginCommand : '';
});
const outputVisible = computed(() => job.value?.status !== 'succeeded' || outputOpen.value);
const heading = computed(() => {
  const name = provider.value?.name;
  const operation = job.value?.operation || install.selectedFailure?.operation;

  if (name && operation) {
    return t(operation === 'install'
      ? 'settings.providerInstallationHeadingInstall'
      : 'settings.providerInstallationHeadingUpdate', { name });
  }

  return `${t('settings.providerInstallationTitle')}${name ? ` · ${name}` : ''}`;
});
const tone = computed(() => {
  if (!job.value) {
    return install.selectedFailure || install.snapshot.blockedReason || install.error ? 'danger' : 'neutral';
  }
  if (job.value.status === 'running') {
    return 'running';
  }
  if (job.value.status === 'succeeded') {
    return job.value.warnings.length ? 'warning' : 'success';
  }

  return job.value.status === 'interrupted' ? 'warning' : 'danger';
});
const stages = computed(() => {
  const current = job.value ? STAGES.indexOf(job.value.stage) : -1;

  return STAGES.map((stage, index) => ({
    stage,
    label: t(STAGE_LABELS[stage]),
    state: stageState(index, current),
  }));
});
const modelsWarning = computed(() => Boolean(job.value?.warnings.some((warning) =>
  typeof warning !== 'string' && warning.code === 'models_refresh_failed')));
const currentStage = computed(() => t(STAGE_LABELS[job.value?.stage || 'download-install']));
// Первая строка — итог операции, остальное (предупреждения, длинная причина) — пояснение под ним.
const resultLines = computed(() => {
  const [head = '', ...rest] = (job.value ? providerInstallResultText(job.value) : '').split('\n');

  return [head, rest.join('\n')];
});
const actions = createSettingsActions({
  requestAction: (run) => settings.isOpen ? settings.requestAction(run) : run(),
  notify: (text) => {
    install.error = resolveUiText(text);
  },
  openTerminal: launcher.openTerminal,
  openChat: async () => false,
}, uiLocale);

/**
 * Сервер сообщает только текущую фазу: предыдущие считаются пройденными, следующие — ждущими.
 * Успех закрывает все фазы, кроме каталога моделей с предупреждением об отказе обновления;
 * отказ или перезапуск отмечает фазу, на которой операция остановилась.
 */
function stageState(index: number, current: number): StageState {
  if (job.value?.status === 'succeeded') {
    return STAGES[index] === 'models' && modelsWarning.value ? 'warning' : 'done';
  }
  if (index < current) {
    return 'done';
  }
  if (index > current) {
    return 'pending';
  }

  return job.value?.status === 'running' ? 'current' : 'failed';
}

/**
 * Общий dirty-переход может отказаться от открытия терминала без потери окна.
 * Launcher получает только вставку команды: установка и Enter здесь не выполняются.
 */
async function openTerminal(command: string): Promise<void> {
  if (await actions.openTerminal(command)) {
    install.visible = false;
  }
}

useSse((name, data) => {
  if (name === 'provider-install') {
    install.applySnapshot(data);
  } else if (name === 'hello') {
    void install.load();
  }
});

onMounted(() => {
  if (auth.authenticated) {
    void install.load();
  }
});

watch(() => [auth.clientScope, auth.authenticated], () => {
  if (auth.authenticated) {
    void install.load();
  }
});

// Свёрнутый после успеха вывод не наследует раскрытие от прошлой операции.
watch(() => job.value?.id, () => {
  outputOpen.value = false;
});

/**
 * Хвост вывода показывает последние строки при открытии, раскрытии и новых строках.
 * Положение меряется до обновления DOM: отмотанный вверх вывод новые строки не сдёргивают.
 */
watch([() => job.value?.outputTail, outputElement, outputVisible], async (current, previous) => {
  const [, element, visible] = current;
  const follow = !element || element !== previous[1] || visible !== previous[2]
    || element.scrollHeight - element.scrollTop - element.clientHeight < 24;

  await nextTick();

  if (follow && element) {
    element.scrollTop = element.scrollHeight;
  }
});
</script>

<style scoped>
.provider-install {
  --provider-install-tone: var(--ink-mid);

  display: flex;
  flex: 1;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  min-height: 0;
  font-size: 0.875rem;
  line-height: 1.5;
}

.provider-install[data-tone='success'] {
  --provider-install-tone: var(--good);
}

.provider-install[data-tone='warning'] {
  --provider-install-tone: var(--warn);
}

.provider-install[data-tone='danger'] {
  --provider-install-tone: var(--bad);
}

.provider-install-head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
  padding: 1.125rem 1.25rem 1rem;
}

.provider-install-logo {
  --provider-install-brand: var(--ink-mid);

  display: grid;
  place-items: center;
  flex: none;
  width: 2.375rem;
  height: 2.375rem;
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--provider-install-brand) 16%, transparent);
  color: var(--provider-install-brand);
}

.provider-install-titles {
  display: grid;
  gap: 0.125rem;
  min-width: 0;
}

.provider-install-heading {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 500;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.provider-install-command {
  color: var(--ink-low);
  font-family: var(--mono);
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}

.provider-install-body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 0.875rem;
  min-height: 0;
  padding: 0.875rem 1.25rem 0;
  overflow: auto;
  overscroll-behavior: contain;
}

.provider-install-body > * {
  flex-shrink: 0;
}

.provider-install-status {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  margin: 0;
  font-weight: 500;
}

.provider-install-status-icon {
  flex: none;
  width: 1.125rem;
  height: 1.125rem;
  margin-top: 0.0625rem;
  color: var(--provider-install-tone);
}

.provider-install-status-icon circle {
  fill: currentColor;
  opacity: 0.16;
}

.provider-install-status-icon path {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.provider-install-status-text {
  max-height: 7.5em;
  min-width: 0;
  overflow: auto;
  overflow-wrap: anywhere;
}

.provider-install-status-detail {
  display: block;
  color: var(--ink-mid);
  font-size: 0.8125rem;
  font-weight: 400;
  white-space: pre-line;
}

.provider-install-steps {
  display: grid;
  gap: 0.125rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.provider-install-steps li {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  min-height: 1.625rem;
  color: var(--ink-mid);
  font-size: 0.8125rem;
}

.provider-install-steps [data-state='current'] {
  color: var(--ink);
}

.provider-install-steps [data-state='pending'] {
  color: var(--ink-low);
}

.provider-install-mark {
  display: grid;
  place-items: center;
  flex: none;
  width: 1rem;
  height: 1rem;
}

.provider-install-mark svg {
  width: 1rem;
  height: 1rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

[data-state='current'] .provider-install-mark {
  color: var(--accent);
}

[data-state='done'] .provider-install-mark {
  color: var(--good);
}

[data-state='warning'] .provider-install-mark {
  color: var(--warn);
}

[data-state='failed'] .provider-install-mark {
  color: var(--bad);
}

[data-state='pending'] .provider-install-mark {
  color: var(--line-2);
}

[data-state='pending'] .provider-install-mark svg {
  stroke-width: 1.6;
}

.provider-install-log {
  display: grid;
  justify-items: start;
  gap: 0.5rem;
  min-width: 0;
}

/* Компактная кнопка раскрытия имеет поле 4 px и рамку 1 px: текст встаёт на линию значков шагов. */
.provider-install-log-toggle {
  margin-inline-start: -0.3125rem;
}

.provider-install-output {
  justify-self: stretch;
  max-height: min(30vh, 12rem);
  margin: 0;
  padding: 0.625rem 0.75rem;
  overflow: auto;
  border-radius: var(--radius-md);
  background: var(--ground);
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 0.75rem;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.provider-install-note {
  margin: 0;
  color: var(--ink-low);
  font-size: 0.75rem;
}

.provider-install-foot {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 1.125rem 1.25rem;
}

.provider-install-foot-note {
  flex: 1 1 12rem;
}

@media (max-width: 600px) {
  .provider-install-head {
    padding-top: max(1.125rem, calc(env(safe-area-inset-top) + 0.75rem));
  }

  .provider-install-foot {
    padding-bottom: max(1.125rem, calc(env(safe-area-inset-bottom) + 0.75rem));
  }
}
</style>
