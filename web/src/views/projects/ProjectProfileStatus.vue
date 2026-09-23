<template>
  <div class="profile" data-role="project-profile">
    <p class="line">
      <span class="lbl">Профиль фабрики:</span>
      <span>{{ detail.profile.present ? 'есть' : 'нет' }}</span>
      <span v-if="detail.profile.present" class="src">{{ pathsLabel }}</span>
    </p>

    <p v-if="!detail.profile.present" class="hint">
      Профиль появится, когда его заведут в каталоге профилей фабрики.
    </p>

    <template v-else>
      <p class="line">
        <span class="lbl">Маршруты:</span>
        <span v-if="detail.routes.length" class="mono">{{ detail.routes.join(', ') }}</span>
        <span v-else>опубликованных маршрутов нет</span>
      </p>
      <p v-if="detail.profile.mismatch.length" class="warn">
        Ключи {{ mismatchKeys }} объявлены в паспорте, но профиль их не называет.
      </p>
    </template>

    <UiButton variant="text" data-role="project-routes" @click="emit('openRoutes')">
      Маршруты →
    </UiButton>
  </div>
</template>

<script setup lang="ts">
// Состояние профиля фабрики у проекта: есть ли он, откуда взяты пути и что
// опубликовано в каталоге маршрутов. Править здесь нечего — это чтение.
import { computed } from 'vue';

import { UiButton } from '../../ui';
import type { ProjectDetail } from '../../../../shared/projectsContracts';

const props = defineProps<{ detail: ProjectDetail }>();

const emit = defineEmits<{ openRoutes: [] }>();

const pathsLabel = computed(() => (
  props.detail.profile.pathsSource === 'profile' ? 'пути из профиля' : 'пути из паспорта'
));
const mismatchKeys = computed(() => props.detail.profile.mismatch
  .map((repo) => repo.key)
  .join(', '));
</script>

<style scoped>
.profile {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--sidebar);
  font-size: 13px;
}

.line {
  display: flex;
  gap: 8px;
  margin: 0;
  flex-wrap: wrap;
}

.lbl {
  color: var(--ink-mid);
}

.src {
  color: var(--ink-mid);
}

.hint,
.warn {
  margin: 0;
  font-size: 12px;
}

.warn {
  color: var(--warn);
}

.hint {
  color: var(--ink-mid);
}
</style>
