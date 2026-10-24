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
      <div class="provider-install-scroll">
        <div class="provider-install-hero">
          <span class="provider-install-logo" aria-hidden="true">
            <ProviderIcon :provider="iconProvider" :size="30" />
            <span v-if="badge" class="provider-install-badge">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path :d="badge" />
              </svg>
            </span>
          </span>
          <h2 class="provider-install-heading">{{ heading }}</h2>
          <code v-if="job" class="provider-install-command">{{ job.command }}</code>
        </div>

        <template v-if="job">
          <p v-if="job.status !== 'running'" class="provider-install-result" role="status">
            {{ resultText }}
          </p>
          <ol class="provider-install-stages">
            <li
              v-for="entry in stages"
              :key="entry.stage"
              :data-state="entry.state"
              :aria-current="entry.state === 'current' ? 'step' : undefined"
            >
              <span class="provider-install-mark" aria-hidden="true">
                <UiSpinner v-if="entry.state === 'current'" decorative />
                <svg
                  v-else-if="entry.state !== 'pending'"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="3"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path :d="entry.state === 'done' ? CHECK_PATH : ALERT_PATH" />
                </svg>
                <template v-else>{{ entry.number }}</template>
              </span>
              {{ entry.label }}
            </li>
          </ol>
          <UiProgress v-if="job.status === 'running'" indeterminate :label="currentStage" />
          <section v-if="job.outputTail" class="provider-install-log" :aria-labelledby="outputLabelId">
            <p :id="outputLabelId" class="provider-install-log-label">
              {{ t('settings.providerInstallationOutput') }}
            </p>
            <pre ref="outputElement" class="provider-install-output">{{ job.outputTail }}</pre>
          </section>
          <p v-if="job.status === 'succeeded' && job.operation === 'install'" class="provider-install-hint">
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

        <div v-if="hasActions" class="provider-install-actions">
          <UiButton
            v-if="install.error || install.uncertain"
            @click="install.load()"
          >{{ t('settings.providerInstallationRefresh') }}</UiButton>
          <UiButton
            v-if="fallbackCommand"
            @click="openTerminal(fallbackCommand)"
          >{{ t('settings.providerInstallationTerminal') }}</UiButton>
          <UiButton
            v-if="loginCommand"
            variant="solid"
            tone="accent"
            @click="openTerminal(loginCommand)"
          >{{ t('settings.providerInstallationLogin') }}</UiButton>
        </div>
      </div>

      <!-- Крестик стоит в разметке последним: первый фокус получает действие итога, а не закрытие. -->
      <div class="provider-install-close">
        <UiIconButton :label="t('settings.providerInstallationClose')" @click="install.visible = false">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            aria-hidden="true"
          >
            <path d="m6 6 12 12M6 18 18 6" />
          </svg>
        </UiIconButton>
      </div>
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
  UiIconButton,
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

const CHECK_PATH = 'M5 12.5l4.5 4.5L19 7.5';
const ALERT_PATH = 'M12 6.5v7M12 17.5v.01';
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
const outputLabelId = `provider-install-output-${useId().replaceAll(':', '')}`;
const outputElement = ref<HTMLElement | null>(null);

const job = computed(() => install.selectedJob);
const provider = computed(() => providers.providers.find((entry) => entry.id === install.providerId));
const iconProvider = computed(() => ({
  id: install.providerId,
  name: provider.value?.name || install.providerId || '?',
}));
const fallbackCommand = computed(() => install.selectedFailure?.fallbackCommand
  || (job.value && ['failed', 'interrupted'].includes(job.value.status) ? job.value.fallbackCommand : ''));
const loginCommand = computed(() => job.value?.status === 'succeeded' ? job.value.loginCommand : '');
const hasActions = computed(() => Boolean(fallbackCommand.value || loginCommand.value
  || install.error || install.uncertain));
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
const badge = computed(() => {
  if (tone.value === 'success') {
    return CHECK_PATH;
  }

  return tone.value === 'warning' || tone.value === 'danger' ? ALERT_PATH : '';
});
const stages = computed(() => {
  const current = job.value ? STAGES.indexOf(job.value.stage) : -1;

  return STAGES.map((stage, index) => ({
    stage,
    number: index + 1,
    label: t(STAGE_LABELS[stage]),
    state: stageState(index, current),
  }));
});
const modelsWarning = computed(() => Boolean(job.value?.warnings.some((warning) =>
  typeof warning !== 'string' && warning.code === 'models_refresh_failed')));
const currentStage = computed(() => t(STAGE_LABELS[job.value?.stage || 'download-install']));
const resultText = computed(() => job.value ? providerInstallResultText(job.value) : '');
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

/**
 * Хвост вывода показывает последние строки при открытии и следует за новыми строками.
 * Положение меряется до обновления DOM: отмотанный вверх вывод новые строки не сдёргивают.
 */
watch([() => job.value?.outputTail, outputElement], async ([, element], [, previous]) => {
  const follow = !element || element !== previous
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

  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  min-height: 0;
}

.provider-install[data-tone='running'] {
  --provider-install-tone: var(--accent);
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

.provider-install-scroll {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
  min-height: 0;
  padding: 1.75rem 1.5rem 1.5rem;
  overflow: auto;
  overscroll-behavior: contain;
  font-size: 0.875rem;
  line-height: 1.5;
}

.provider-install-scroll > * {
  flex-shrink: 0;
}

.provider-install-close {
  position: absolute;
  top: 0.625rem;
  right: 0.625rem;
}

.provider-install-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  padding-inline: 1.5rem;
  text-align: center;
}

.provider-install-logo {
  position: relative;
  display: grid;
  place-items: center;
  width: 4rem;
  height: 4rem;
  margin-bottom: 0.5rem;
  border: 1px solid color-mix(in srgb, var(--provider-install-tone) 40%, var(--line-2));
  border-radius: 1.125rem;
  background: radial-gradient(
    circle at 50% 0%,
    color-mix(in srgb, var(--provider-install-tone) 24%, var(--surface-2)),
    var(--surface-2) 75%
  );
  color: var(--ink);
  box-shadow: 0 0 0 6px color-mix(in srgb, var(--provider-install-tone) 9%, transparent);
}

.provider-install[data-tone='running'] .provider-install-logo::after {
  position: absolute;
  inset: -1px;
  border: 1px solid var(--provider-install-tone);
  border-radius: inherit;
  content: '';
  animation: provider-install-pulse 1.8s ease-out infinite;
}

.provider-install-badge {
  position: absolute;
  right: -0.375rem;
  bottom: -0.375rem;
  display: grid;
  place-items: center;
  width: 1.375rem;
  height: 1.375rem;
  border: 2px solid var(--surface);
  border-radius: 50%;
  background: var(--provider-install-tone);
  color: var(--surface);
}

.provider-install-badge svg {
  width: 0.75rem;
  height: 0.75rem;
}

.provider-install-heading {
  margin: 0;
  font-size: 1.0625rem;
  font-weight: 600;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.provider-install-command {
  max-width: 100%;
  padding: 0.125rem 0.5rem;
  border-radius: 0.375rem;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}

.provider-install-result {
  max-height: 8rem;
  margin: 0;
  padding: 0.625rem 0.875rem;
  overflow: auto;
  border: 1px solid color-mix(in srgb, var(--provider-install-tone) 35%, transparent);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--provider-install-tone) 10%, transparent);
  white-space: pre-line;
  overflow-wrap: anywhere;
}

.provider-install-stages {
  display: grid;
  gap: 0.125rem;
  margin: 0;
  padding: 0.375rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--ground);
  list-style: none;
}

.provider-install-stages li {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  min-height: 2.125rem;
  padding: 0.25rem 0.5rem;
  border-radius: 0.5rem;
  color: var(--ink-low);
}

.provider-install-stages [data-state='done'] {
  color: var(--ink-mid);
}

.provider-install-stages [data-state='current'] {
  background: var(--surface-2);
  color: var(--ink);
  font-weight: 600;
}

.provider-install-stages [data-state='failed'] {
  color: var(--bad);
}

.provider-install-mark {
  display: grid;
  place-items: center;
  flex: none;
  width: 1.25rem;
  height: 1.25rem;
  border: 1px solid var(--line-2);
  border-radius: 50%;
  font-size: 0.6875rem;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}

.provider-install-mark svg {
  width: 0.75rem;
  height: 0.75rem;
}

[data-state='current'] .provider-install-mark {
  border-color: transparent;
  color: var(--accent);
}

[data-state='done'] .provider-install-mark {
  border-color: transparent;
  background: color-mix(in srgb, var(--good) 16%, transparent);
  color: var(--good);
}

[data-state='warning'] .provider-install-mark {
  border-color: transparent;
  background: color-mix(in srgb, var(--warn) 16%, transparent);
  color: var(--warn);
}

[data-state='failed'] .provider-install-mark {
  border-color: transparent;
  background: color-mix(in srgb, var(--bad) 16%, transparent);
  color: var(--bad);
}

.provider-install-log {
  display: grid;
  gap: 0.375rem;
  min-width: 0;
}

.provider-install-log-label {
  margin: 0;
  color: var(--ink-low);
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.provider-install-output {
  max-height: min(30vh, 12rem);
  margin: 0;
  padding: 0.75rem 0.875rem;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--ground);
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 0.75rem;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.provider-install-hint {
  margin: 0;
  color: var(--ink-mid);
  font-size: 0.8125rem;
}

.provider-install-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: auto;
}

@keyframes provider-install-pulse {
  from {
    opacity: 0.8;
    transform: scale(1);
  }

  to {
    opacity: 0;
    transform: scale(1.3);
  }
}

@media (prefers-reduced-motion: reduce) {
  .provider-install[data-tone='running'] .provider-install-logo::after {
    animation: none;
  }
}

@media (max-width: 600px) {
  .provider-install-scroll {
    padding-top: max(2.5rem, calc(env(safe-area-inset-top) + 1.5rem));
    padding-bottom: max(1.5rem, calc(env(safe-area-inset-bottom) + 1rem));
  }

  .provider-install-close {
    top: max(0.625rem, env(safe-area-inset-top));
  }
}
</style>
