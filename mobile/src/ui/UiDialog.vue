<template>
  <Teleport to="body">
    <div class="ui-dialog-overlay mobile-dialog-overlay" @keydown.esc.prevent.stop="close">
      <section
        ref="dialog"
        class="ui-dialog mobile-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        tabindex="-1"
        @keydown.tab="trapFocus"
      >
        <h2>{{ title }}</h2>
        <div class="mobile-dialog-body"><slot /></div>
        <footer class="mobile-actions">
          <UiButton :disabled="busy" @click="close">Отмена</UiButton>
          <UiButton
            :busy="busy"
            :kind="danger ? 'danger' : 'primary'"
            variant="solid"
            :disabled="disabled"
            @click="$emit('confirm')"
            >{{ confirm || 'Подтвердить' }}</UiButton
          >
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';

import UiButton from './UiButton.vue';

const props = defineProps<{
  title: string;
  confirm?: string;
  danger?: boolean;
  busy?: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  confirm: [];
}>();

const dialog = ref<HTMLElement | null>(null);
const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
const dialogId = crypto.randomUUID();
const close = () => {
  if (!props.busy) {
    emit('close');
  }
};
const back = () => emit('close');

/**
 * Клавиатурный фокус остаётся в активном диалоге, включая обратный Tab.
 * Недоступные элементы не участвуют в обходе; пустой диалог держит фокус на своей поверхности.
 */
function trapFocus(event: KeyboardEvent) {
  const controls = [
    ...(dialog.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled)',
    ) || []),
  ].filter((element) => !element.closest('[hidden],[inert]'));
  const first = controls[0];
  const last = controls.at(-1);

  if (!first || !last) {
    event.preventDefault();
    dialog.value?.focus();
  } else if (
    event.shiftKey &&
    (document.activeElement === first || document.activeElement === dialog.value)
  ) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

onMounted(() => {
  document.getElementById('app')?.setAttribute('inert', '');
  history.pushState(
    {
      ...history.state,
      mobileDialog: dialogId,
    },
    '',
  );
  window.addEventListener('popstate', back);
  (
    dialog.value?.querySelector<HTMLElement>('input,textarea,button:not(:disabled)') || dialog.value
  )?.focus();
});

onUnmounted(() => {
  document.getElementById('app')?.removeAttribute('inert');
  window.removeEventListener('popstate', back);

  if (history.state?.mobileDialog === dialogId) {
    history.back();
  }

  if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) {
    previousFocus.focus();
  }
});
</script>
