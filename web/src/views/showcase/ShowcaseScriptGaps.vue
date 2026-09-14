<template>
  <div v-if="gaps.length" class="gaps">
    <UiDisclosureButton v-model:open="open" controls="showcase-script-gaps" density="compact">
      {{ open ? 'Скрыть, что осталось за кадром' : `За кадром: ${gaps.length}` }}
    </UiDisclosureButton>
    <div v-show="open" id="showcase-script-gaps" class="gaps__body">
      <p class="gaps__intro">{{ SCRIPT_GAPS_INTRO }}</p>
      <ul class="gaps__list">
        <li v-for="gap in gaps" :key="gap">{{ gap }}</li>
      </ul>
      <p class="gaps__hint">{{ SCRIPT_GAPS_HINT }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import { UiDisclosureButton } from '../../ui';
import { SCRIPT_GAPS_HINT, SCRIPT_GAPS_INTRO } from '../../actions/showcase';

// Пробелы карты экранов — текст модели, и показывается он как текст, списком:
// адресов и селекторов в нём нет. Это справка «что осталось за кадром», а не
// задача оператору, поэтому блок тихий и свёрнут: ролик от пробелов не ломается,
// а дополнять карту профиля — работа агента.
const props = defineProps<{
  gaps: string[] | null | undefined;
}>();

const open = ref(false);

const gaps = computed(() => (props.gaps ?? []).filter(Boolean));
</script>

<style scoped>
.gaps {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}

.gaps__body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-2) 28%, transparent);
  color: var(--ink-mid);
  font-size: 12.5px;
  line-height: 1.45;
}

.gaps__intro,
.gaps__hint {
  margin: 0;
}

.gaps__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding-left: 18px;
  color: var(--ink);
}
</style>
