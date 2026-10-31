<template>
  <span class="stand-link">
    <UiActionLink
        v-bind="$attrs" :href="href" target="_blank" rel="noopener noreferrer"
        @click="click" @auxclick="aux">
      <slot>{{ href }}</slot>
    </UiActionLink>
    <UiPopover v-if="browser.available" :trigger-label="t('core.browserOpenWith')">
      <template #default="{ close }">
        <UiButton @click="override('internal', close)">{{ t('settings.browserInternal') }}</UiButton>
        <UiButton @click="override('external', close)">{{ t('settings.browserExternal') }}</UiButton>
      </template>
    </UiPopover>
    <span v-if="failed" role="alert">{{ t('core.browserRequestFailed') }}</span>
  </span>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { UiActionLink, UiButton, UiPopover, t } from '../../ui.ts';
import { useBrowserStore } from '../../stores/browser.ts';
import { openStand } from './openStand.ts';

const props = defineProps<{ href: string }>();

defineOptions({ inheritAttrs: false });

const browser = useBrowserStore();
const router = useRouter();
const failed = ref(false);

/**
 * Только наличие main bridge позволяет отменить обычный переход ссылки.
 * Контракт открытия один — openStand шага 8; Native отказ не вызывает
 * второй внешний запуск или browser fallback.
 */
async function open(target: 'internal' | 'external', deduplicate = true): Promise<void> {
  failed.value = false;

  try {
    await openStand({
      available: browser.available,
      preferences: browser.preferences,
      native: (value) => browser.control(value),
    }, props.href, target, deduplicate);

    if (target === 'internal') {
      await router.push('/browser');
    }
  } catch {
    failed.value = true;
  }
}

function click(event: MouseEvent): void {
  if (browser.available && event.button === 0) {
    event.preventDefault();
    void open(browser.preferences.open);
  }
}

function aux(event: MouseEvent): void {
  if (browser.available && event.button === 1) {
    event.preventDefault();
    void open(browser.preferences.open, false);
  }
}

function override(target: 'internal' | 'external', close: () => void): void {
  close();
  void open(target);
}
</script>

<style scoped>
.stand-link {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
</style>
