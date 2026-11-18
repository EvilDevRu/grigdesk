<template>
  <section class="stand-picker" data-testid="showcase-stand-picker" aria-labelledby="showcase-stand-picker-title">
    <h3 id="showcase-stand-picker-title">{{ t('core.showcaseStendDlyaZapisi') }}</h3>

    <UiInlineMessage v-if="!project.ref" tone="warning">
      {{ t('core.showcaseStendNeVybranPodklyuchite') }}
    </UiInlineMessage>
    <template v-else>
      <p class="stand-picker__current" data-testid="showcase-stand-current">
        {{ project.target?.status === 'ready' ? project.target.scope.targetLabel : project.title }}
        <UiActionLink v-if="targetUrl" :href="targetUrl" target="_blank">
          {{ t('core.showcaseOtkrytStend') }}
        </UiActionLink>
      </p>
      <UiInlineMessage v-if="project.target?.status === 'blocked'" tone="warning">
        {{ project.target.reason }}
      </UiInlineMessage>
      <UiInlineMessage v-else-if="project.target?.warning" tone="warning">
        {{ project.target.warning }}
      </UiInlineMessage>
    </template>

    <div class="stand-picker__row">
      <UiSelect
        v-model="selected"
        :aria-label="t('core.showcaseVyberiteStend')"
        data-testid="showcase-stand-select"
        :disabled="busy"
      >
        <option value="">{{ t('core.showcaseVyberiteStend') }}</option>
        <option
          v-for="target in targets"
          :key="`${target.ref.kind}:${target.ref.id}`"
          :value="`${target.ref.kind}:${target.ref.id}`"
        >
          {{ target.label }}{{ target.status === 'blocked' ? ` — ${target.reason}` : '' }}
        </option>
      </UiSelect>
      <UiButton
        variant="outline"
        :disabled="busy || !selected"
        data-testid="showcase-stand-attach"
        @click="attach"
      > {{ t('core.showcasePodklyuchitStend') }} </UiButton>
    </div>

    <UiInlineMessage v-if="selectedWarning" tone="warning" data-testid="showcase-stand-option-warning">
      {{ selectedWarning }}
    </UiInlineMessage>

    <p v-if="error" class="stand-picker__error" role="alert">{{ error }}</p>

    <UiActionLink href="#/sandboxes">{{ t('core.showcaseOtkrytPesochnitsy') }}</UiActionLink>
  </section>
</template>

<script setup lang="ts">
// Стенд подключается к ролику из server-owned каталога. Подъём снесённой песочницы
// живёт в разделе «Песочницы»: здесь только выбор готового стенда и ссылка туда.
// Селект преднастроен первым постоянным стендом (D25), подключение — явная кнопка.
import { computed, ref, watch } from 'vue';

import type {
  ShowcaseProject,
  ShowcaseTargetOption,
} from '../../../../shared/plugins/showcase/showcaseContracts.ts';
import { UiActionLink, UiButton, UiInlineMessage, UiSelect, t } from '../../ui';

const props = defineProps<{
  project: ShowcaseProject;
  targets: ShowcaseTargetOption[];
  busy: boolean;
  targetUrl: string | null;
}>();

const emit = defineEmits<{
  attach: [ref: { kind: 'project' | 'sandbox'; id: string }];
}>();

const firstProject = computed(() => props.targets.find((target) => target.ref.kind === 'project'));
const selected = ref('');
const error = ref('');
const selectedWarning = computed(() => (
  props.targets.find((target) => `${target.ref.kind}:${target.ref.id}` === selected.value)?.warning ?? ''
));

// Каталог может приехать позже монтирования (глубокая ссылка): преднастройка D25
// реактивна и не перетирает выбор человека (находка R3-R2-A4).
watch(firstProject, (target) => {
  if (!selected.value && target) {
    selected.value = `${target.ref.kind}:${target.ref.id}`;
  }
}, { immediate: true });

/**
 * Выбранная ссылка проходит локальную проверку формы до отправки события.
 * Адрес и профиль из неё определит сервер, а не поле интерфейса.
 */
function attach() {
  const [kind, id] = selected.value.split(':');

  error.value = '';

  if ((kind !== 'project' && kind !== 'sandbox') || !id) {
    error.value = t('core.showcaseVyberiteStend');

    return;
  }

  emit('attach', { kind, id });
}
</script>

<style scoped>
.stand-picker {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.stand-picker h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.stand-picker__current {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.stand-picker__row {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  min-width: 0;
}

.stand-picker__error {
  margin: 0;
  color: var(--bad);
  font-size: 12px;
}
</style>
