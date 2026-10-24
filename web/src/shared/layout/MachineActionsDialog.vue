<template>
  <UiDialog v-if="profile" :open="open" :title="machineProfileName(profile, uiLocale)"
            size="compact" mobile-sheet :busy="busy" data-role="machine-actions"
            @update:open="$emit('update:open', $event)">
    <template #title>
      <span class="machine-actions-heading">
        <span>{{ machineProfileName(profile, uiLocale) }}</span>
        <UiIconButton :label="t('settings.close')" @click="$emit('update:open', false)">
          <MachineGlyph name="close" />
        </UiIconButton>
      </span>
    </template>
    <div class="machine-menu">
      <p>{{ t('core.machineSavedSettings') }}</p>
      <UiButton v-if="!current" block variant="ghost" data-context="machine-menu-action"
                :disabled="busy" @click="act('select')">
        <template #leading><MachineGlyph name="arrow" /></template>
        {{ t('core.connect') }}
      </UiButton>
      <UiButton block variant="ghost" data-context="machine-menu-action"
                :disabled="busy" @click="act('rename')">
        <template #leading><MachineGlyph name="edit" /></template>
        {{ t('core.machineRename') }}
      </UiButton>
      <UiButton v-if="profile.kind === 'remote'" block variant="ghost"
                data-context="machine-menu-action" :disabled="busy" @click="act('address')">
        <template #leading><MachineGlyph name="machine" /></template>
        {{ t('core.changeAddress') }}
      </UiButton>
      <UiButton v-if="current && !disconnected" block variant="ghost"
                data-context="machine-menu-action" :disabled="busy" @click="act('disconnect')">
        <template #leading><MachineGlyph name="disconnect" /></template>
        {{ t('core.disconnect') }}
      </UiButton>
      <UiButton block variant="ghost" tone="danger" data-context="machine-menu-action"
                :disabled="busy" @click="act('remove')">
        <template #leading><MachineGlyph name="trash" /></template>
        {{ t('settings.delete') }}
      </UiButton>
    </div>
  </UiDialog>
</template>

<script setup lang="ts">
import { UiButton, UiDialog, UiIconButton, t, uiLocale } from '../../ui.ts';
import { machineProfileName, type MachineProfile } from '../../../../shared/client/clientShell.ts';
import MachineGlyph from './MachineGlyph.vue';

defineProps<{
  open: boolean;
  profile: MachineProfile | null;
  current: boolean;
  disconnected: boolean;
  busy: boolean;
}>();

type MachineAction = 'select' | 'rename' | 'address' | 'disconnect' | 'remove';

const emit = defineEmits<{
  'update:open': [value: boolean];
  action: [value: MachineAction];
}>();

function act(action: MachineAction): void {
  emit('update:open', false);
  emit('action', action);
}
</script>

<style scoped>
.machine-actions-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.machine-actions-heading > span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.machine-menu {
  display: grid;
  gap: 4px;
}

.machine-menu p {
  margin: 0 0 12px;
  color: var(--ink-mid);
  font-size: 12px;
}
</style>
