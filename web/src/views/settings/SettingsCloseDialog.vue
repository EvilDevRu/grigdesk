<template>
  <UiDialog
    :open="open"
    :title="t('settings.saveSettingsChanges')"
    layer="confirm"
    data-role="settings-close-choice"
    @close="reason => reason === 'escape' && emit('choose', 'continue')"
  >
    <p>{{ t('settings.thereAreUnappliedChangesChooseWhatTo') }}</p>
    <template #footer>
      <UiButton @click="emit('choose', 'continue')">{{ t('settings.continueEditing') }}</UiButton>
      <UiButton @click="emit('choose', 'discard')">{{ t('settings.discard') }}</UiButton>
      <UiButton
        tone="accent"
        variant="solid"
        @click="emit('choose', 'apply')"
      >
        {{ t('settings.applyAndClose') }}
      </UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { t } from '../../ui.ts';

import { UiButton, UiDialog } from '../../ui.ts';

defineProps<{ open: boolean }>();

const emit = defineEmits<{ choose: [choice: 'apply' | 'discard' | 'continue'] }>();
</script>
