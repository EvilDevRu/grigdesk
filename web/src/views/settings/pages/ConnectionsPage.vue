<template>
  <section
    class="settings-connections"
    :data-connections-page="settings.pageId"
    :data-ready="ready"
  >
    <MobileAccess />
    <SettingsSection>
      <UiDisclosureButton v-model:open="help" :controls="helpId">
        {{ t('settings.loginOnThisComputer') }}
      </UiDisclosureButton>
      <div v-if="help" :id="helpId" class="settings-connection-help">
        <p>{{ t('settings.automaticLoginUsingThisComputerSLocal') }}</p>
        <p>{{ t('settings.ifTheSessionIsLostTheMain') }}</p>
      </div>
    </SettingsSection>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, useId } from 'vue';

import { t, UiDisclosureButton } from '../../../ui.ts';
import { useSettingsStore } from '../../../stores/settings.ts';
import MobileAccess from '../MobileAccess.vue';
import SettingsSection from '../SettingsSection.vue';

const props = defineProps<{ active: boolean }>();
const settings = useSettingsStore();
const help = ref(false);
const helpId = `settings-local-access-${useId()}`;
const ready = computed(() => props.active && settings.isOpen);
</script>

<style scoped>
.settings-connections {
  display: grid;
  gap: 12px;
  min-width: 0;
  align-content: start;
}
.settings-connections p {
  margin: 0;
}
.settings-connection-help {
  display: grid;
  gap: 10px;
  color: var(--ink-mid);
  line-height: 1.6;
}
</style>
