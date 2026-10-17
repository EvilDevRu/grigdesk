<template>
  <section class="studio-version-tree" aria-label="Версии модели">
    <div v-for="row in rows" :key="row.version.id" class="studio-tree-item">
      <UiIconButton v-if="parents.has(row.version.id)" role="embedded"
        :label="`${folded.has(row.version.id) ? 'Развернуть' : 'Свернуть'} ${row.version.label}`"
        @click="fold(row.version.id)">{{ folded.has(row.version.id) ? '›' : '⌄' }}</UiIconButton>
      <UiPressable data-context="studio-version-row" :pressed="selected === row.version.id"
        :style="{ paddingLeft: `${row.depth * 18}px` }" @click="$emit('select', row.version.id)">
        <span class="studio-version-preview">
          <img v-if="row.version.preview" :src="row.version.preview" alt="" loading="lazy" />
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"
            stroke-linejoin="round" aria-hidden="true">
            <path d="M12 2l9 5v10l-9 5-9-5V7z M12 22V12 M21 7l-9 5-9-5" />
          </svg>
        </span>
        <span class="studio-version-copy">
          <span class="studio-version-name">{{ main === row.version.id ? '★ ' : '' }}{{ row.version.label }}</span>
          <span class="studio-version-meta">
            <span class="studio-version-number">v{{ String(row.version.seq).padStart(2, '0') }}</span>
            <span class="studio-version-status" :data-status="row.version.status">
              {{ statusLabels[row.version.status] }}
            </span>
          </span>
          <UiProgress v-if="ACTIVE_STATUSES.includes(row.version.status) && row.version.status !== 'unknown'"
            :value="row.version.progress" :label="`Прогресс ${row.version.label}`" />
        </span>
        <span v-if="main === row.version.id" class="studio-version-main">Основная</span>
      </UiPressable>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { UiPressable, UiProgress, UiIconButton } from '../../ui.ts';
import type { Studio3dVersion } from '../../../../shared/studio3d/studio3dContracts.ts';
import { ACTIVE_STATUSES } from '../../../../shared/studio3d/studio3dContracts.ts';
import { statusLabels } from '../../features/studio3d/presentation.ts';

const props = defineProps<{
  versions: Studio3dVersion[];
  selected: string;
  main: string | null
}>();

defineEmits<{ select: [versionId: string] }>();

const folded = ref(new Set<string>());
const parents = computed(() => new Set(props.versions.map((item) => item.parent).filter(Boolean)));
const rows = computed(() => {
  const seen = new Set<string>();
  const result: { version: Studio3dVersion; depth: number }[] = [];
  const known = new Set(props.versions.map((item) => item.id));
  const ordered = [...props.versions].sort((a, b) => a.seq - b.seq);
  /**
   * Seen защищает от повторных связей, а folded скрывает только потомков выбранной ветки.
   * Корни сортируются по seq независимо от порядка файлов server manifest.
   */
  const visit = (version: Studio3dVersion, depth: number) => {
    if (seen.has(version.id)) {
      return;
    }
    
    seen.add(version.id);
    result.push({ version, depth });
    
    if (folded.value.has(version.id)) {
      return;
    }
    
    for (const child of ordered.filter((item) => item.parent === version.id)) {
      visit(child, depth + 1);
    }
  };
  
  for (const item of ordered.filter((item) => !item.parent || !known.has(item.parent))) {
    visit(item, 0);
  }
  // Повреждённый цикл не вызывает бесконечную рекурсию и не прячет независимые версии.
  if (!folded.value.size) {
    for (const item of ordered) {
      visit(item, 0);
    }
  }
  
  return result;
});

/**
 * Сворачивание скрывает потомков без изменения выбранной версии или main manifest.
 * Новый Set сохраняет реактивность и не ставит listeners вне этого дерева.
 */
function fold(id: string): void {
  const next = new Set(folded.value);
  
  if (next.has(id)) {
    next.delete(id);
  }
  else {
    next.add(id);
  }
  
  folded.value = next;
}
</script>

<style scoped>
.studio-version-tree {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: var(--studio-tree-max-height, none);
  overflow-y: auto;
}

.studio-tree-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.studio-version-preview {
  display: grid;
  flex: none;
  place-items: center;
  width: 36px;
  height: 40px;
  margin-left: 8px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--ground);
  color: var(--ink-mid);
}

.studio-version-preview img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.studio-version-preview svg {
  width: 22px;
  height: 22px;
}

.studio-version-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.studio-version-name {
  overflow: hidden;
  font-size: 12px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.studio-version-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  font-size: 11px;
  color: var(--ink-mid);
}

.studio-version-number {
  font-variant-numeric: tabular-nums;
}

.studio-version-status[data-status='ready'] {
  color: var(--good);
}

.studio-version-status[data-status='failed'],
.studio-version-status[data-status='unknown'],
.studio-version-status[data-status='unresolved'] {
  color: var(--warn);
}

.studio-version-main {
  flex: none;
  align-self: flex-start;
  padding: 2px 5px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--accent);
  font-size: 10px;
}
</style>
