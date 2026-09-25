<template>
  <section ref="dialog" class="route-publish-dialog" role="dialog" aria-modal="true"
           aria-label="Подтверждение публикации маршрутов" tabindex="-1">
    <h3>Опубликовать черновик r{{ report.draftRevision }}?</h3>
    <p>Новые попытки пойдут по новой ревизии. Уже запущенные сохранят свой каталог.</p>
    <dl>
      <dt>Текущий каталог</dt><dd class="mono">{{ report.currentCatalogHash?.slice(0, 12) ?? 'нет' }}</dd>
      <dt>Источник</dt><dd>редактор, источник r{{ report.sourceRevision }}</dd>
      <dt>Изменений</dt><dd>{{ report.changes.length }}</dd>
    </dl>
    <label for="route-publication-comment">Комментарий к публикации
      <UiTextarea id="route-publication-comment" v-model="comment"
                  data-test="publication-comment" maxlength="2000" />
    </label>
    <p v-if="!canPublish" class="bad">Снимок устарел или содержит ошибки. Сохраните,
      проверьте и сравните черновик снова.</p>
    <div class="route-publish-dialog__actions">
      <UiButton @click="$emit('cancel')">Отмена</UiButton>
      <UiButton data-test="confirm-publish" :disabled="!canPublish || busy"
                @click="$emit('confirm', comment)">Опубликовать этот снимок</UiButton>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { RouteCompareReport } from '../../../../shared/routesEditorContracts.ts';
import { onMounted, onUnmounted, ref } from 'vue';
import { UiButton, UiTextarea } from '../../ui';

defineProps<{
  report: RouteCompareReport;
  canPublish: boolean;
  busy?: boolean
}>();
defineEmits<{ confirm: [comment: string]; cancel: [] }>();

const comment = ref('');
const dialog = ref<HTMLElement | null>(null);
let opener: HTMLElement | null = null;

onMounted(() => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialog.value?.focus();
});

onUnmounted(() => {
  if (opener?.isConnected) {
    opener.focus();
  }
});
</script>

<style scoped>
.route-publish-dialog { border: 1px solid var(--line); background: var(--surface);
  border-radius: 8px; padding: 14px; }
.route-publish-dialog dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; }
.route-publish-dialog__actions { display: flex; gap: 8px; }
.route-publish-dialog label { display: grid; gap: 6px; }
.mono { font-family: var(--font-mono); }
.bad { color: var(--bad); }
</style>
