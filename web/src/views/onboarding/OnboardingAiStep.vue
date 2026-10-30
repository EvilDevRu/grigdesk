<template>
  <section>
    <header class="onboarding-section-head">
      <h2 tabindex="-1">{{ t('core.onboardingConnectAi') }}</h2>
      <p class="onboarding-description">{{ t('core.onboardingAiHelp') }}</p>
    </header>
    <UiInlineMessage v-if="!ready && !checking" tone="warning">
      {{ t('core.onboardingNoAi') }}
    </UiInlineMessage>
    <UiInlineMessage v-if="failed" tone="warning">{{ t('core.onboardingProviderFailed') }}</UiInlineMessage>
    <UiLoadingState v-if="checking && !providers.providers.length" variant="cards" />
    <div v-else class="providers">
      <article v-for="provider in providers.providers" :key="provider.id" class="provider"
        :class="{ 'is-ready': isChatReady(provider) }">
        <header class="provider-heading">
          <span class="provider-icon"><ProviderIcon :provider="provider" :size="22" /></span>
          <h3>{{ provider.name }}</h3>
        </header>
        <p class="provider-status">
          <span aria-hidden="true">{{ isChatReady(provider) ? '✓' : '○' }}</span>
          <span>{{ t(isChatReady(provider) ? 'core.onboardingReady' : 'core.onboardingNotReady') }}</span>
        </p>
        <div class="provider-details">
          <p>{{ t(provider.installed ? 'core.onboardingInstalled' : 'core.onboardingNotInstalled') }}</p>
          <p>{{ localizeProviderAuthLabel(provider, uiLocale) }}</p>
        </div>
        <div v-if="!isChatReady(provider)" class="provider-actions">
          <UiButton wrap v-if="!provider.installed && provider.installation?.canInstall"
            :disabled="installer.busy" @click="installer.requestInstall(provider.id, 'install')">
            {{ t('core.onboardingInstall', { name: provider.name }) }}
          </UiButton>
          <UiButton wrap v-if="provider.installed && !provider.available && provider.installation?.loginCommand"
            @click="login(provider.installation.loginCommand)">
            {{ t('core.onboardingLogin', { name: provider.name }) }}
          </UiButton>
        </div>
      </article>
    </div>
    <div class="provider-refresh">
      <UiButton wrap :loading="checking" @click="refresh(true)">
        <template #leading><span aria-hidden="true">↻</span></template>
        {{ t('core.onboardingCheckAgain') }}
      </UiButton>
      <p v-if="ready" class="provider-ready-note">{{ t('core.onboardingAiContinue') }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { t, uiLocale, UiButton, UiInlineMessage, UiLoadingState } from '../../ui';
import type { ProviderEntry } from '../../../../shared/chat/providersContracts.ts';
import { useProvidersStore } from '../../stores/providers.ts';
import { useProviderInstallStore } from '../../stores/providerInstall.ts';
import { useOnboardingStore } from '../../stores/onboarding.ts';
import { localizeProviderAuthLabel } from '../../features/providers/providerLocale.ts';
import { useToolLauncher } from '../../shared/tools/launcher.ts';
import ProviderIcon from '../../shared/ProviderIcon.vue';

const emit = defineEmits<{ ready: [value: boolean] }>();
const providers = useProvidersStore();
const installer = useProviderInstallStore();
const onboarding = useOnboardingStore();
const launcher = useToolLauncher();
const checking = ref(false);
const failed = ref(false);
const ready = computed(() => providers.providers.some(isChatReady));

function isChatReady(provider: Pick<ProviderEntry, 'available' | 'chatEnabled'>): boolean {
  return Boolean(provider.available && provider.chatEnabled !== false);
}

/**
 * Принудительная проверка использует прежний refresh=1 и ждёт его реального результата.
 * Таймер реестра и общий installer продолжают работать по существующему контракту.
 */
async function refresh(force: boolean): Promise<void> {
  checking.value = true;
  await providers.load(force);
  failed.value = !(await providers.whenRegistryReady()).ok;
  checking.value = false;
}

/**
 * Команда вставляется в существующий терминал после подтверждения ответов мастера.
 * Enter не добавляется: запуск входа остаётся явным действием человека.
 */
async function login(command: string): Promise<void> {
  if (await onboarding.flush()) {
    await launcher.openTerminal({ insert: command });
  }
}

watch(ready, (value) => emit('ready', value), { immediate: true });
onMounted(() => refresh(false));
</script>

<style scoped>
.providers {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
  gap: 12px;
  margin: 16px 0 20px;
}

.provider {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
}

.provider-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.provider-icon {
  display: grid;
  place-items: center;
  flex: 0 0 32px;
  height: 32px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  color: var(--ink-mid);
  background: var(--sidebar);
}

.provider h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.provider-status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 10px;
  color: var(--ink-mid);
  font-size: 12px;
  font-weight: 500;
}

.provider.is-ready .provider-status {
  color: var(--good);
}

.provider-details {
  display: grid;
  gap: 4px;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}

.provider-details p {
  margin: 0;
}

.provider-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: auto;
  padding-top: 14px;
}

.provider-actions:empty {
  display: none;
}

.provider-refresh {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.provider-ready-note {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
}
</style>
