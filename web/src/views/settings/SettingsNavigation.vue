<template>
  <div
    ref="tree"
    class="settings-tree"
    role="tree"
    :aria-label="t('settings.settingsSections')"
  >
    <UiPressable
      v-for="node in nodes"
      :key="node.id"
      role="treeitem"
      :aria-level="node.level"
      :aria-expanded="node.group ? settings.expandedGroups.includes(node.id) : undefined"
      :aria-selected="node.group ? undefined : settings.pageId === node.id"
      :tabindex="focusId === node.id ? 0 : -1"
      :data-settings-node="node.id"
      :data-dirty="dirty(node.id, node.group)"
      data-ui-settings-node
      class="settings-tree-node"
      @focus="focusId = node.id"
      @click="activate(node)"
      @keydown="onKey($event, node)"
    >
      <SettingsIcon v-if="node.group" :name="node.id" />
      <span v-else class="settings-tree-branch" aria-hidden="true" />
      <span class="settings-tree-label">{{ node.label }}</span>
      <span v-if="dirty(node.id, node.group)" class="settings-tree-dirty" :aria-label="t('settings.hasChanges')" />
      <svg
        v-if="node.group"
        class="settings-tree-chevron"
        :data-expanded="settings.expandedGroups.includes(node.id)"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path d="m6 4 4 4-4 4" stroke="currentColor" stroke-width="1.5" />
      </svg>
    </UiPressable>
  </div>
</template>

<script setup lang="ts">
import { t, uiLocale } from '../../ui.ts';

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { UiPressable } from '../../ui.ts';
import { getSettingsGroups, getSettingsPages } from '../../features/settings/catalog.ts';
import { useSettingsStore } from '../../stores/settings.ts';
import SettingsIcon from './SettingsIcon.vue';

interface TreeNode {
  id: string;
  label: string;
  group: boolean;
  level: number;
  parent?: string;
}

const emit = defineEmits<{ select: [] }>();
const settings = useSettingsStore();
const tree = ref<HTMLElement>();
const focusId = ref(settings.pageId);
let resizeObserver: ResizeObserver | undefined;

const nodes = computed<TreeNode[]>(() => getSettingsGroups(uiLocale.value).flatMap((group) => [
  {
    ...group,
    group: true,
    level: 1,
  },
  ...settings.expandedGroups.includes(group.id) ? getSettingsPages(uiLocale.value)
    .filter((page) => page.groupId === group.id)
    .map((page) => ({
      id: page.id,
      label: page.label,
      group: false,
      level: 2,
      parent: group.id,
    })) : [],
]));

watch(() => settings.pageId, (id) => {
  focusId.value = id;
  revealSelection();
}, { flush: 'post' });

/**
 * Переход из поиска или внешнего действия может выбрать пункт далеко внизу дерева.
 * Показываем выбранную строку без переноса фокуса из редактируемого поля.
 */
function revealSelection(): void {
  tree.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
}

function dirty(id: string, group: boolean): boolean {
  return settings.snapshot.resources.some((resource) => resource.fields.some((field) =>
    field.dirty && (group ? field.address.pageId.startsWith(`${id}.`) : field.address.pageId === id)));
}

function expand(id: string, value: boolean): void {
  settings.setGroupExpanded(id, value);
}

function activate(node: TreeNode): void {
  focusId.value = node.id;

  if (node.group) {
    expand(node.id, !settings.expandedGroups.includes(node.id));
  } else {
    settings.selectPage(node.id);
    emit('select');
  }
}

/**
 * Перемещение фокуса выполняется только внутри видимых узлов дерева.
 * Выбор страницы остаётся отдельным действием Enter, Space или кликом.
 */
function onKey(event: KeyboardEvent, node: TreeNode): void {
  const index = nodes.value.findIndex((item) => item.id === node.id);
  let target: string | undefined;

  if (event.key === 'ArrowDown') {
    target = nodes.value[Math.min(index + 1, nodes.value.length - 1)]?.id;
  } else if (event.key === 'ArrowUp') {
    target = nodes.value[Math.max(index - 1, 0)]?.id;
  } else if (event.key === 'Home' || event.key === 'End') {
    target = event.key === 'Home' ? nodes.value[0]?.id : nodes.value.at(-1)?.id;
  } else if (event.key === 'ArrowRight' && node.group) {
    if (settings.expandedGroups.includes(node.id)) {
      target = nodes.value[index + 1]?.id;
    } else {
      expand(node.id, true);
    }
  } else if (event.key === 'ArrowLeft') {
    if (node.group) {
      expand(node.id, false);
    } else {
      target = node.parent;
    }
  } else if (event.key === 'Enter' || event.key === ' ') {
    activate(node);
  } else {
    return;
  }

  event.preventDefault();

  if (target) {
    focusId.value = target;

    const element = [...tree.value?.querySelectorAll<HTMLElement>('[data-settings-node]') ?? []]
      .find((item) => item.dataset.settingsNode === target);

    element?.focus();
  }
}

onMounted(() => {
  revealSelection();

  if (typeof ResizeObserver !== 'undefined' && tree.value?.parentElement) {
    resizeObserver = new ResizeObserver(revealSelection);
    resizeObserver.observe(tree.value.parentElement);
  }
});

onBeforeUnmount(() => resizeObserver?.disconnect());
</script>

<style scoped>
.settings-tree {
  display: grid;
  align-content: start;
  gap: 3px;
  min-width: 0;
}
.settings-tree-node {
  display: flex;
  gap: 10px;
  align-items: center;
  text-align: start;
}
.settings-tree-label {
  flex: 1;
  min-width: 0;
}
.settings-tree-branch {
  width: 20px;
  flex: none;
}
.settings-tree-chevron {
  width: 14px;
  height: 14px;
  flex: none;
}
.settings-tree-chevron[data-expanded='true'] {
  transform: rotate(90deg);
}
.settings-tree-dirty {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--accent);
}
</style>
