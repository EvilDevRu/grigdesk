<template>
  <div
    ref="tree"
    class="settings-tree"
    role="tree"
    aria-label="Разделы настроек"
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
      class="settings-tree-node"
      @focus="focusId = node.id"
      @click="activate(node)"
      @keydown="onKey($event, node)"
    >
      <span>{{ node.group ? (settings.expandedGroups.includes(node.id) ? '▾' : '▸') : '' }}</span>
      <span>{{ node.label }}</span>
      <span v-if="dirty(node.id, node.group)" aria-label="Есть изменения">•</span>
    </UiPressable>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { UiPressable } from '../../ui.ts';
import { SETTINGS_GROUPS, SETTINGS_PAGES } from '../../features/settings/catalog.ts';
import { useSettingsStore } from '../../stores/settings.ts';

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
const nodes = computed<TreeNode[]>(() => SETTINGS_GROUPS.flatMap((group) => [
  {
    ...group,
    group: true,
    level: 1,
  },
  ...settings.expandedGroups.includes(group.id) ? SETTINGS_PAGES
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
});

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
</script>

<style scoped>
.settings-tree { display: grid; align-content: start; gap: 4px; min-width: 0; }
.settings-tree-node { display: flex; gap: 8px; align-items: center; text-align: start; }
.settings-tree-node[aria-level='2'] { margin-left: 20px; }
</style>
