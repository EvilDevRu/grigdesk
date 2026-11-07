<template>
  <UiPopover :open="open" :return-focus="false" has-popup="menu" placement="bottom-end"
             @update:open="emit('update:open', $event)" @keydown="onMenuKey">
    <template #trigger>
      <UiIconButton class="git-file-action" role="embedded" data-context="code-row-action"
                    :data-action="directory ? 'dir-more' : 'row-more'" :data-file="path"
                    :label="t('core.codeReviewMenu')" :aria-label="t('core.codeReviewMenu')">…</UiIconButton>
    </template>
    <template #default="{ close }">
      <UiButton v-for="action in actions" :key="action" block variant="ghost" role="menuitem"
                :data-action="action" :data-file="path"
                @click="emit('action', action); close('action')">
        {{ t(actionLabel(action)) }}
      </UiButton>
    </template>
  </UiPopover>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { UiButton, UiIconButton, UiPopover, t } from '../../ui';
import type { MessageKey } from '../../../../shared/i18n/catalogs';
import type { CodeGitEntry } from '../../../../shared/plugins/code/codeContracts';

type MenuAction = 'copy-path' | 'view-file' | 'folder-review' | 'ask-agent' | 'file-history'
  | 'unstage-dir' | 'unstage-file' | 'stage-dir' | 'discard-dir' | 'clean-new'
  | 'ignore-shared' | 'ignore-local' | 'delete-new-dir' | 'mark-resolved'
  | 'stage-file' | 'clean-file' | 'discard-file';

const props = defineProps<{
  group: 'work' | 'staged' | 'commits';
  path: string;
  status?: string;
  directory?: boolean;
  files?: CodeGitEntry[];
  open: boolean;
}>();
const emit = defineEmits<{
  'update:open': [value: boolean];
  action: [value: string];
}>();
const actions = computed<MenuAction[]>(() => {
  const result: MenuAction[] = ['copy-path', props.directory ? 'folder-review' : 'view-file', 'ask-agent'];

  if (!props.directory) {
    result.push('file-history');
  }

  if (props.group === 'commits') {
    return result;
  }
  if (props.group === 'staged') {
    return [...result, props.directory ? 'unstage-dir' : 'unstage-file'];
  }
  if (props.directory) {
    const files = props.files?.filter((file) => file.path.startsWith(`${props.path}/`)) || [];

    result.push('stage-dir');

    if (files.some((file) => file.status !== 'A' && file.status !== 'U')) {
      result.push('discard-dir');
    }
    if (files.some((file) => file.status === 'A')) {
      result.push('clean-new', 'ignore-shared', 'ignore-local');
    }
    if (files.length && files.every((file) => file.status === 'A')) {
      result.push('delete-new-dir');
    }

    return result;
  }
  if (props.status === 'U') {
    return [...result, 'mark-resolved'];
  }

  return props.status === 'A'
    ? [...result, 'stage-file', 'clean-file', 'ignore-shared', 'ignore-local']
    : [...result, 'stage-file', 'discard-file'];
});

function actionLabel(action: MenuAction): MessageKey {
  return `core.codeReviewMenu${action}`;
}

/**
 * Общая клавиатурная навигация работает у меню дерева, списка и touch-кнопки.
 * Фокус ходит только по доступным пунктам, Escape обрабатывает сам UiPopover.
 */
function onMenuKey(event: KeyboardEvent) {
  const surface = event.currentTarget as HTMLElement;
  const items = [...surface.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
  const index = items.indexOf(document.activeElement as HTMLElement);
  let target = index;

  if (event.key === 'ArrowDown') {
    target = (index + 1) % items.length;
  } else if (event.key === 'ArrowUp') {
    target = (index - 1 + items.length) % items.length;
  } else if (event.key === 'Home') {
    target = 0;
  } else if (event.key === 'End') {
    target = items.length - 1;
  } else {
    return;
  }

  event.preventDefault();
  items[target]?.focus();
}
</script>
