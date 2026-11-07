<template>
  <UiDialog v-if="presentation === 'dialog'" v-bind="$attrs"
            :open="open" :label="label" :size="size" :initial-focus="initialFocus"
            :body-inset="bodyInset" :fade-only="fadeOnly"
            @update:open="emit('update:open', $event)">
    <slot />
  </UiDialog>
  <section v-else-if="open" ref="documentRoot" v-bind="{ ...$attrs, ...layerProps }"
           class="task-card-document" role="region" :aria-label="label">
    <slot />
  </section>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { UiDialog, useUiLayer } from '../ui';

defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{
  presentation?: 'dialog' | 'document';
  open: boolean;
  label: string;
  size?: 'compact' | 'content' | 'workspace';
  initialFocus?: string;
  bodyInset?: boolean;
  fadeOnly?: boolean;
}>(), {
  presentation: 'dialog',
  size: 'workspace',
  initialFocus: '#task-modal-title',
  bodyInset: false,
  fadeOnly: true,
});
const emit = defineEmits<{
  'update:open': [
    value: boolean
  ];
}>();
const documentRoot = ref<HTMLElement | null>(null);
let escapeRelease: AbortController | null = null;

/**
 * Нативное окно закрываем после отпускания Escape, чтобы остаток нажатия
 * не попал в окно под карточкой. Программная «Назад» не ждёт физических клавиш.
 */
function closeDocument(event: KeyboardEvent): boolean {
  if (!event.isTrusted || event.type !== 'keydown') {
    emit('update:open', false);

    return true;
  }
  if (escapeRelease) {
    return true;
  }

  const release = new AbortController();

  escapeRelease = release;

  const finish = () => {
    release.abort();
    escapeRelease = null;
    window.setTimeout(() => emit('update:open', false), 0);
  };

  window.addEventListener('keyup', (released) => {
    if (released.key === 'Escape') {
      finish();
    }
  }, { signal: release.signal });
  window.addEventListener('blur', finish, { signal: release.signal, once: true });

  return true;
}

// Документ лежит ниже модальных дифов, подтверждений и всплывашек.
// Общий stack сам выбирает одного владельца Escape и не закрывает два слоя.
const { layerProps } = useUiLayer('tools', {
  enabled: computed(() => props.presentation === 'document' && props.open),
  element: documentRoot,
  onEscape: closeDocument,
});

onUnmounted(() => {
  escapeRelease?.abort();
});
</script>

<style scoped>
.task-card-document {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--surface);
}
</style>
