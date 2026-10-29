<template>
  <section>
    <h2>{{ t('core.onboardingConnectAi') }}</h2>
    <UiInlineMessage v-if="!ready" tone="warning">{{ t('core.onboardingNoAi') }}</UiInlineMessage>
    <UiInlineMessage v-if="failed" tone="warning">{{ t('core.onboardingProviderFailed') }}</UiInlineMessage>
    <div class="providers">
      <article v-for="provider in providers.providers" :key="provider.id" class="provider">
        <h3>{{ provider.name }}</h3>
        <p>{{ t(provider.installed ? 'core.onboardingInstalled' : 'core.onboardingNotInstalled') }}</p>
        <p>{{ localizeProviderAuthLabel(provider, uiLocale) }}</p>
        <p>{{ t(provider.available && provider.chatEnabled !== false
          ? 'core.onboardingReady' : 'core.onboardingNotReady') }}</p>
        <UiButton wrap v-if="!provider.installed && provider.installation?.canInstall"
          :disabled="installer.busy" @click="installer.requestInstall(provider.id, 'install')">
          {{ t('core.onboardingInstall', { name: provider.name }) }}
        </UiButton>
        <UiButton wrap v-if="provider.installed && !provider.available && provider.installation?.loginCommand"
          @click="login(provider.installation.loginCommand)">
          {{ t('core.onboardingLogin', { name: provider.name }) }}
        </UiButton>
      </article>
    </div>
    <UiButton wrap :disabled="checking" @click="refresh(true)">{{ t('core.onboardingCheckAgain') }}</UiButton>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { t, uiLocale, UiButton, UiInlineMessage } from '../../ui';
import { useProvidersStore } from '../../stores/providers.ts';
import { useProviderInstallStore } from '../../stores/providerInstall.ts';
import { useOnboardingStore } from '../../stores/onboarding.ts';
import { localizeProviderAuthLabel } from '../../features/providers/providerLocale.ts';
import { useToolLauncher } from '../../shared/tools/launcher.ts';

const emit = defineEmits<{ ready: [value: boolean] }>();
const providers = useProvidersStore();
const installer = useProviderInstallStore();
const onboarding = useOnboardingStore();
const launcher = useToolLauncher();
const checking = ref(false);
const failed = ref(false);
const ready = computed(() => providers.providers.some((item) =>
  item.available && item.chatEnabled !== false));

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
  gap: 16px;
  margin: 20px 0;
}

.provider {
  min-width: 0;
}
</style>
