<template>
  <UiIconButton :label="t('core.searchCommands')" @click="open = true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" />
    </svg>
  </UiIconButton>
  <UiDialog v-model:open="open" :title="t('core.searchCommands')" :initial-focus="() => input?.el">
    <UiSearchInput
      ref="input"
      v-model="query"
      :aria-label="t('core.commandQuery')"
      :placeholder="t('core.commandQuery')"
      @keydown.down.prevent="selected = Math.min(selected + 1, results.length - 1)"
      @keydown.up.prevent="selected = Math.max(0, selected - 1)"
      @keydown.enter.prevent="execute(results[selected])"
    />
    <div class="command-results">
      <UiButton
        v-for="(command, index) in results"
        :key="command.id"
        variant="ghost"
        :aria-current="index === selected ? 'true' : undefined"
        @click="execute(command)"
      >
        {{ command.label }}
      </UiButton>
      <p v-if="!results.length" role="status">{{ t('core.noCommandResults') }}</p>
    </div>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { UiButton, UiDialog, UiIconButton, UiSearchInput, t, uiLocale } from '../../ui.ts';
import { sectionCommands, type SectionCommand } from '../commandCatalog.ts';
import { openSettings } from '../settingsNavigation.ts';

const props = defineProps<{ sections: SectionCommand[] }>();
const router = useRouter();
const open = ref(false);
const query = ref('');
const selected = ref(0);
const input = ref<InstanceType<typeof UiSearchInput>>();
const results = computed(() => sectionCommands(props.sections, query.value, uiLocale.value));

/**
 * Команда закрывает только палитру и использует существующий маршрут или настройки.
 * Фокус возвращает общий диалог; смена языка не затрагивает рабочий документ.
 */
async function execute(command?: SectionCommand): Promise<void> {
  if (!command) {
    return;
  }

  open.value = false;
  await nextTick();

  if (command.id === 'settings') {
    openSettings();
  } else if (command.to) {
    await router.push(command.to);
  }
}

watch(query, () => selected.value = 0);
watch(open, (visible) => {
  if (visible) {
    query.value = '';
    selected.value = 0;
  }
});
</script>

<style scoped>
.command-results {
  display: grid;
  gap: 4px;
  max-height: 50vh;
  overflow: auto;
  margin-top: 12px;
}
</style>
