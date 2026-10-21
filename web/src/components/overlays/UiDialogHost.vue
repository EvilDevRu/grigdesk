<template>
  <UiDialog
    ref="dialog"
    :open="Boolean(request)"
    :role="dialogRole"
    layer="confirm"
    size="compact"
    :title="dialogTitle"
    :data-ui-touch="request?.kind === 'confirm' && request.options.touchTargets ? '' : undefined"
    :label="dialogTitle"
    :persistent="busy"
    :busy="busy"
    :initial-focus="initialFocusTarget"
    @close="onDialogClose"
    @keydown="onDialogKeydown"
  >
    <p v-if="dialogText" class="ui-dialog-host__message">{{ dialogText }}</p>

    <UiInput
      v-if="request?.kind === 'prompt' && request.options.multiline === false"
      ref="promptInput"
      v-model="promptValue"
      :aria-label="dialogTitle"
      :placeholder="resolveUiText(request.options.placeholder ?? '')"
      :disabled="busy"
      @keydown="onPromptKeydown"
    />
    <UiTextarea
      v-else-if="request?.kind === 'prompt'"
      ref="promptInput"
      v-model="promptValue"
      class="ui-dialog-host__prompt"
      :aria-label="dialogTitle"
      :placeholder="resolveUiText(request.options.placeholder ?? '')"
      :disabled="busy"
      @keydown="onPromptKeydown"
    />

    <UiInlineMessage
      v-if="actionError"
      class="ui-dialog-host__error"
      tone="danger"
    >
      {{ actionError }}
    </UiInlineMessage>

    <template #footer>
      <div class="ui-dialog-host__actions">
        <UiButton
          v-if="request?.kind !== 'alert'"
          ref="cancelButton"
          :disabled="busy"
          @click="cancel"
        >
          {{ cancelText }}
        </UiButton>
        <UiButton
          ref="submitButton"
          variant="solid"
          :tone="danger ? 'danger' : 'accent'"
          :loading="busy"
          :loading-label="okText"
          @click="submit"
        >
          {{ okText }}
        </UiButton>
      </div>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { t, resolveUiText } from '../../services/locale.ts';

import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
} from 'vue';
import UiButton from '../primitives/UiButton.vue';
import UiInput from '../primitives/UiInput.vue';
import UiTextarea from '../primitives/UiTextarea.vue';
import UiInlineMessage from '../feedback/UiInlineMessage.vue';
import UiDialog from './UiDialog.vue';
import {
  completeDialogRequest,
  registerDialogHost,
  type DialogHostController,
} from '../../services/dialogs';
import type {
  DialogHostRequest,
  DialogResult,
  UiDialogCloseReason,
  UiDialogRole,
} from '../../types/uiOverlays';

interface FocusHandle {
  focus(options?: FocusOptions): void;
}

const request = shallowRef<DialogHostRequest | null>(null);
const promptValue = ref('');
const busy = ref(false);
const actionError = ref('');
const dialog = ref<FocusHandle | null>(null);
const promptInput = ref<FocusHandle | null>(null);
const cancelButton = ref<FocusHandle | null>(null);
const submitButton = ref<FocusHandle | null>(null);
let unregisterHost: (() => void) | null = null;

const dialogRole = computed<UiDialogRole>(() =>
  request.value?.kind === 'alert' ? 'alertdialog' : 'dialog',
);
const dialogTitle = computed(() => {
  const current = request.value;

  if (!current) {
    return '';
  }
  if (current.kind === 'confirm') {
    return resolveUiText(current.options.title ?? t('core.confirmAction'));
  }
  if (current.kind === 'prompt') {
    return resolveUiText(current.options.title ?? t('core.explanation'));
  }

  return resolveUiText(current.options.title ?? 'GrigDesk');
});
const dialogText = computed(() => {
  const current = request.value;

  if (!current) {
    return '';
  }

  return resolveUiText(current.kind === 'prompt'
    ? (current.options.text ?? '')
    : current.text);
});
const okText = computed(() => {
  const current = request.value;

  if (!current) {
    return '';
  }
  if (current.kind === 'confirm') {
    return resolveUiText(current.options.okText ?? t('core.yes'));
  }
  if (current.kind === 'prompt') {
    return resolveUiText(current.options.okText ?? t('core.send'));
  }

  return resolveUiText(current.options.okText ?? t('core.gotIt'));
});
const cancelText = computed(() => {
  const current = request.value;

  if (!current || current.kind === 'alert') {
    return '';
  }

  return resolveUiText(current.options.cancelText ?? t('settings.cancel'));
});
const danger = computed(() => Boolean(request.value?.options.danger));

/**
 * Prompt начинает с поля, confirm — с безопасной отмены, alert — с действия.
 * Этот порядок исключает случайное подтверждение сразу после открытия.
 */
function initialFocusTarget(): FocusHandle | null {
  if (request.value?.kind === 'prompt') {
    return promptInput.value;
  }
  if (request.value?.kind === 'confirm') {
    return cancelButton.value;
  }

  return submitButton.value;
}

/**
 * Каждый новый запрос получает чистое transient-состояние предыдущего диалога.
 * Начальное значение prompt принимается только строкой из его собственного контракта.
 */
function show(nextRequest: DialogHostRequest): void {
  request.value = nextRequest;
  promptValue.value =
    nextRequest.kind === 'prompt' &&
    typeof nextRequest.options.value === 'string'
      ? nextRequest.options.value
      : '';
  busy.value = false;
  actionError.value = '';
}

/**
 * Идентификатор работает как CAS: запоздалый hide старого запроса
 * не имеет права закрыть уже показанный следующий диалог.
 */
function hide(requestId: number): void {
  if (request.value?.id !== requestId) {
    return;
  }

  request.value = null;
  busy.value = false;
  actionError.value = '';
}

const controller: DialogHostController = { show, hide };

function settle(result: DialogResult): void {
  const current = request.value;

  if (!current) {
    return;
  }

  completeDialogRequest(current.id, result);
}

/**
 * Разные виды диалогов сохраняют совместимую семантику отмены результата:
 * confirm возвращает false, prompt — null, alert завершается без значения.
 */
function cancel(): void {
  if (busy.value || !request.value) {
    return;
  }
  if (request.value.kind === 'confirm') {
    settle(false);
  } else if (request.value.kind === 'prompt') {
    settle(null);
  } else {
    settle(undefined);
  }
}

/**
 * Пользовательское действие может бросить Error или строку из legacy-кода.
 * Пустые и неизвестные значения заменяются стабильным сообщением интерфейса.
 */
function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return t('core.couldNotPerformTheAction');
}

/**
 * Асинхронное action выполняется до завершения promise диалога.
 * Проверка id не даёт результату старого action закрыть новый запрос в host.
 */
async function submit(): Promise<void> {
  const current = request.value;

  if (!current || busy.value) {
    return;
  }

  actionError.value = '';

  const result: DialogResult =
    current.kind === 'confirm'
      ? true
      : current.kind === 'prompt'
        ? promptValue.value
        : undefined;
  const action = current.options.action;

  if (action) {
    busy.value = true;

    try {
      if (current.kind === 'confirm') {
        await current.options.action?.(true);
      } else if (current.kind === 'prompt') {
        await current.options.action?.(promptValue.value);
      } else {
        await current.options.action?.();
      }
    } catch (error) {
      if (request.value?.id === current.id) {
        busy.value = false;
        actionError.value = errorText(error);
        await nextTick();
        submitButton.value?.focus({ preventScroll: true });
      }

      return;
    }
  }

  if (request.value?.id !== current.id) {
    return;
  }

  busy.value = false;
  completeDialogRequest(current.id, result);
}

function onDialogClose(_reason: UiDialogCloseReason): void {
  cancel();
}

function isCompositionEnter(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

/**
 * Enter отправляет однострочный prompt, но Shift+Enter и незавершённый IME-ввод
 * остаются внутри поля и не всплывают до общего keyboard handler диалога.
 */
function onPromptKeydown(event: KeyboardEvent): void {
  if (
    event.key !== 'Enter' ||
    event.shiftKey ||
    isCompositionEnter(event) ||
    busy.value
  ) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  void submit();
}

/**
 * Общий Enter подтверждает alert/confirm из любой точки формы.
 * Prompt обрабатывает клавишу отдельно, чтобы сохранить Shift и IME-семантику.
 */
function onDialogKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || isCompositionEnter(event) || busy.value) {
    return;
  }
  if (request.value?.kind === 'prompt') {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  void submit();
}

onMounted(() => {
  unregisterHost = registerDialogHost(controller);
});

onBeforeUnmount(() => {
  unregisterHost?.();
  unregisterHost = null;
});
</script>
