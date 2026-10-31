<template>
  <a
    ref="element"
    v-bind="$attrs"
    class="ui-button ui-action-link"
    :class="[
      `ui-button--${normalizedVariant}`,
      `ui-button--${normalizedTone}`,
      { 'ui-button--block': block },
    ]"
    :data-variant="normalizedVariant"
    :data-tone="normalizedTone"
    :data-size="normalizedSize"
    :href="guarded ? undefined : href"
    :target="target"
    :rel="safeRel"
    :download="download"
    :aria-disabled="guarded ? 'true' : undefined"
    :tabindex="disabled ? -1 : undefined"
    @click="onClick"
    ><slot
  /></a>
</template>

<script setup lang="ts">
import { messageRef } from '../../services/locale.ts';

import { computed, ref } from 'vue';
import { uiDownloadAvailable, saveUiDownload } from '../../services/downloads.ts';
import { showToast } from '../../services/toasts.ts';
import type { UiActionSize, UiActionTone, UiActionVariant } from '../../types/uiActions';
import {
  normalizeActionSize,
  normalizeActionTone,
  normalizeActionVariant,
} from '../../types/uiActions';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    href: string;
    target?: string;
    rel?: string;
    download?: string | boolean;
    variant?: UiActionVariant;
    tone?: UiActionTone;
    size?: UiActionSize;
    disabled?: boolean;
    ariaDisabled?: boolean;
    block?: boolean;
  }>(),
  {
    target: undefined,
    rel: undefined,
    download: undefined,
    variant: 'outline',
    tone: 'neutral',
    size: 'default',
    disabled: false,
    ariaDisabled: false,
    block: false,
  },
);

defineSlots<{ default(): unknown }>();

const emit = defineEmits<{ click: [event: MouseEvent] }>();
const element = ref<HTMLAnchorElement | null>(null);
const normalizedVariant = computed(() => normalizeActionVariant(props.variant));
const normalizedTone = computed(() => normalizeActionTone(props.tone));
const normalizedSize = computed(() => normalizeActionSize(props.size));
const guarded = computed(() => props.disabled || props.ariaDisabled);
const safeRel = computed(
  () =>
    props.rel ||
    (props.target === '_blank' ? 'noopener noreferrer' : undefined),
);

/**
 * Скачивание в нативной оболочке передаём системному выбору файла.
 * Пользовательский обработчик сохраняет право отменить действие ссылки.
 */
async function onClick(event: MouseEvent): Promise<void> {
  if (guarded.value) {
    event.preventDefault();
    event.stopImmediatePropagation();

    return;
  }

  emit('click', event);

  if (event.defaultPrevented || props.download === undefined
    || props.download === false || !uiDownloadAvailable()) {
    return;
  }

  event.preventDefault();

  try {
    await saveUiDownload(props.href, typeof props.download === 'string' ? props.download : undefined);
  } catch {
    showToast({
      id: 'save-file-failed',
      title: messageRef('core.couldNotSaveTheFile'),
      tone: 'danger',
    });
  }
}

defineExpose({
  get el() {
    return element.value;
  },
  focus: (options?: FocusOptions) => element.value?.focus(options),
  click: () => element.value?.click(),
});
</script>
