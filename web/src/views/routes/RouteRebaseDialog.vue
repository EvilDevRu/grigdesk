<template>
  <section class="route-rebase-dialog" role="dialog" aria-label="Перенос черновика">
    <h3>Перенос черновика r{{ preview.draftRevision }}</h3>
    <p>Новое основание: <code>{{ preview.currentCatalogHash.slice(0, 12) }}</code>.
      Каждый выбор заменяет целый маршрут вместе с инструкциями или всю начальную разведку.</p>
    <p v-if="!preview.conflicts.length">Пересечений нет. Независимые правки объединятся.</p>
    <div v-for="conflict in preview.conflicts" :key="keyOf(conflict)"
         class="route-rebase-dialog__conflict">
      <strong>{{ conflict.scope === 'bootstrap' ? 'Начальная разведка' : conflict.routeId }}</strong>
      <div class="route-rebase-dialog__versions">
        <div><span>Основание</span><pre>{{ format(conflict.base) }}</pre></div>
        <div><span>Моя версия</span><pre>{{ format(conflict.mine) }}</pre></div>
        <div><span>Текущий каталог</span><pre>{{ format(conflict.current) }}</pre></div>
      </div>
      <label>Какую версию оставить
        <UiSelect :data-test="`rebase-choice-${keyOf(conflict)}`"
                  :model-value="choices[keyOf(conflict)] ?? ''"
                  @update:model-value="setChoice(conflict, String($event ?? ''))">
          <option value="">Выберите</option>
          <option value="mine">Мою</option>
          <option value="current">Из текущего каталога</option>
        </UiSelect>
      </label>
    </div>
    <div class="route-rebase-dialog__actions">
      <UiButton @click="$emit('cancel')">Отмена</UiButton>
      <UiButton data-test="rebase-confirm" :disabled="busy || !resolved"
                @click="confirm">Перенести черновик</UiButton>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import type { RouteRebaseConflict, RouteRebasePreview,
  RouteRebaseResolution } from '../../../../shared/pipeline/routesEditorContracts.ts';
import { UiButton, UiSelect } from '../../ui';

const props = defineProps<{ preview: RouteRebasePreview; busy: boolean }>();
const emit = defineEmits<{ confirm: [resolutions: RouteRebaseResolution[]]; cancel: [] }>();
const choices = reactive<Record<string, RouteRebaseResolution['choice'] | ''>>({});

function keyOf(conflict: RouteRebaseConflict): string {
  return conflict.scope === 'bootstrap' ? 'bootstrap' : `route-${conflict.routeId}`;
}

function format(value: unknown): string {
  return value === null ? '—' : JSON.stringify(value, null, 2);
}

function setChoice(conflict: RouteRebaseConflict, value: string): void {
  choices[keyOf(conflict)] = value === 'mine' || value === 'current' ? value : '';
}

watch(() => props.preview, () => {
  for (const key of Object.keys(choices)) {
    delete choices[key];
  }
});

const resolved = computed(() => props.preview.conflicts.every(
  (conflict) => choices[keyOf(conflict)] === 'mine'
    || choices[keyOf(conflict)] === 'current',
));

function confirm(): void {
  if (!resolved.value || props.busy) {
    return;
  }

  emit('confirm', props.preview.conflicts.map((conflict) => ({
    scope: conflict.scope,
    routeId: conflict.routeId,
    choice: choices[keyOf(conflict)] as RouteRebaseResolution['choice'],
  })));
}
</script>

<style scoped>
.route-rebase-dialog { border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
.route-rebase-dialog__conflict { border-top: 1px solid var(--line); padding: 10px 0; }
.route-rebase-dialog__versions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.route-rebase-dialog__versions > div { min-width: 0; }
.route-rebase-dialog pre { max-height: 28vh; overflow: auto; white-space: pre-wrap;
  overflow-wrap: anywhere; background: var(--surface-2); padding: 8px; }
.route-rebase-dialog label { display: grid; gap: 5px; }
.route-rebase-dialog__actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
