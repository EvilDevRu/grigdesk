<template>
  <section ref="panel" class="task-shelf-panel" tabindex="-1" aria-label="Полка задач">
    <header class="shelf-head">
      <div>
        <h2>Полка</h2>
        <p>Задачи, по которым ждём событие</p>
      </div>
      <span v-if="shelf.rows.length" class="shelf-count">{{ shelf.rows.length }}</span>
    </header>

    <p v-if="shelf.loading && !shelf.loaded" class="shelf-state">Загружаю полку…</p>
    <p v-if="shelf.error" class="shelf-state error" role="alert">{{ shelf.error }}</p>
    <p v-if="!shelf.loading && !shelf.error && !shelf.rows.length" class="shelf-state">
      На полке пока пусто
    </p>
    <ul v-if="shelf.rows.length" class="shelf-list">
      <li v-for="row in shelf.rows" :key="row.taskId">
        <UiSelectableRow
          data-ui-task-shelf-row
          :data-task-id="row.taskId"
          :data-shelf-state="row.state"
          :aria-label="`${row.title}, задача #${row.taskId}`"
          @select="ui.openTask(row.taskId)"
          @click.self="ui.openTask(row.taskId)"
        >
          <span class="shelf-dot" aria-hidden="true"></span>
          <span class="shelf-copy">
            <strong>{{ row.title }}</strong>
            <span>{{ ` ${row.reasonText}` }}</span>
            <span v-if="row.message" class="shelf-event">{{ ` ${row.message}` }}</span>
          </span>
          <template #actions>
            <UiIconButton
              label="Убрать с полки"
              title="Убрать с полки"
              role="embedded"
              :loading="shelf.isPending?.(row.taskId)"
              :disabled="shelf.isPending?.(row.taskId)"
              @click.stop="shelf.remove(row.taskId)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" aria-hidden="true">
                <path d="M6 6l12 12 M18 6 6 18" />
              </svg>
            </UiIconButton>
          </template>
        </UiSelectableRow>
      </li>
    </ul>
  </section>
</template>

<script setup>
import { ref } from 'vue';
import { useTaskShelfStore } from '../../stores/task-shelf.js';
import { useUiStore } from '../../stores/ui.js';
import { UiIconButton, UiSelectableRow } from '../../ui';

const shelf = useTaskShelfStore();
const ui = useUiStore();
const panel = ref(null);

defineExpose({ focus: () => panel.value?.focus?.() });
</script>

<style scoped>
.task-shelf-panel {
  min-height: 100%; outline: none; background: var(--ground); color: var(--ink);
}
.shelf-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  min-height: 54px; padding: 10px 12px; border-bottom: 1px solid var(--line);
}
.shelf-head h2 { margin: 0; font-size: 15px; }
.shelf-head p { margin: 2px 0 0; color: var(--ink-mid); font-size: 11px; }
.shelf-count {
  min-width: 22px; height: 22px; display: inline-grid; place-items: center;
  border-radius: 999px; background: var(--surface-2); color: var(--ink-mid); font-size: 11px;
}
.shelf-state { margin: 0; padding: 18px 14px; color: var(--ink-mid); font-size: 13px; }
.shelf-state.error { color: var(--bad); }
.shelf-list { display: grid; gap: 3px; margin: 0; padding: 7px; list-style: none; }
.shelf-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-low); }
.shelf-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.shelf-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.shelf-copy span { color: var(--ink-mid); font-size: 11px; }
.shelf-copy .shelf-event { color: var(--warn); }
</style>
