<template>
  <div class="studio-price-control" :class="{ 'studio-price-footer': layout === 'footer' }">
    <div v-if="layout === 'footer'" class="studio-price-summary" aria-live="polite">
      <span>Стоимость по расчёту</span>
      <strong>{{ quote ? formatPrice(quote.total, quote.unit) : 'Расчёт…' }}</strong>
    </div>
    <div class="studio-price-line">
      <UiButton data-context="studio-price" tone="accent" variant="solid" :disabled="Boolean(reason)"
        :loading="sending || busy" :loading-label="progressLabel" @click="send">
        {{ sending || busy ? progressLabel : layout === 'footer' ? verb
          : `${verb} — ${quote ? formatPrice(quote.total, quote.unit) : 'расчёт цены…'}` }}
      </UiButton>
      <UiPopover v-if="quote" label="Раскладка цены" trigger-label="i">
        <p v-for="(line, index) in quote.lines" :key="index">{{ line.label }} — {{ formatPrice(line.amount, quote.unit) }}</p>
        <p v-if="quote.usd !== null">≈ ${{ quote.usd.toFixed(2).replace('.', ',') }}</p>
        <p v-if="quote.note">{{ quote.note }}</p>
      </UiPopover>
    </div>
    <p v-if="reason && layout === 'footer'" class="studio-price-reason" role="status">{{ reason }}</p>
    <UiInlineMessage v-else-if="reason" tone="warning">{{ reason }}</UiInlineMessage>
    <UiActionLink v-if="shortage && billingUrl" :href="billingUrl" target="_blank" rel="noopener">Пополнить</UiActionLink>
    <UiButton v-if="quote?.total && balance === null" variant="ghost" @click="$emit('refresh')">Обновить баланс</UiButton>
    <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { UiButton, UiPopover, UiInlineMessage, UiActionLink } from '../../ui.ts';
import { formatPrice } from '../../../../shared/studio3d/studio3dOperations.ts';
import type { Studio3dQuote, Studio3dValidation } from '../../../../shared/studio3d/studio3dContracts.ts';
import { studioErrorMessage } from '../../features/studio3d/presentation.ts';

const props = withDefaults(defineProps<{
  quote: Studio3dQuote | null;
  validation?: Studio3dValidation | null;
  balance?: number | null;
  billingUrl?: string | null;
  verb?: string;
  fingerprint: string;
  busy?: boolean;
  layout?: 'default' | 'footer';
  disabledReason?: string | null;
  execute: (idempotencyKey: string) => Promise<unknown>;
}>(), {
  validation: null,
  balance: null,
  billingUrl: null,
  verb: 'Создать',
  busy: false,
  layout: 'default',
  disabledReason: null
});
const emit = defineEmits<{
  run: [idempotencyKey: string];
  priceChanged: [quote: Studio3dQuote];
  refresh: [];
}>();
const sending = ref(false);
const error = ref('');
let key: string | null = null;
const progressLabel = computed(() => sending.value ? 'Отправка…' : 'Загрузка…');
const shortage = computed(() => props.quote?.total !== null && props.quote?.total !== undefined
  && props.balance !== null && props.quote.total > props.balance);
const reason = computed(() => {
  if (props.disabledReason) {
    return props.disabledReason;
  }
  if (props.validation?.errors.length) {
    return props.validation.errors[0]!.message;
  }
  if (!props.quote) {
    return 'Расчёт цены…';
  }
  if (props.quote.total === null || (props.quote.total > 0 && !props.quote.unit)) {
    return 'Цена пока не опубликована';
  }
  if (props.quote.total > 0 && props.balance === null) {
    return 'Не удалось проверить баланс';
  }
  if (shortage.value) {
    return `Не хватает ${formatPrice(props.quote.total - (props.balance ?? 0), props.quote.unit)}`;
  }
  
  return '';
});

/**
 * Локальный lock ставится до события и await, поэтому double click даёт один POST.
 * Сетевой отказ удерживает key; новая форма и подтверждённая новая цена его меняют.
 */
async function send(): Promise<void> {
  if (sending.value || props.busy || reason.value) {
    return;
  }
  
  sending.value = true;
  error.value = '';
  key ??= crypto.randomUUID();
  
  const snapshot = props.fingerprint;
  
  emit('run', key);
  
  try {
    const result = await props.execute(key);
    
    if (snapshot !== props.fingerprint) {
      return;
    }
    
    key = null;
    
    if (result && typeof result === 'object' && 'priceChanged' in result) {
      emit('priceChanged', result.priceChanged as Studio3dQuote);
    }
  } catch (cause) {
    if (snapshot === props.fingerprint) {
      error.value = studioErrorMessage(cause);
    }
  } finally {
    sending.value = false;
  }
}

watch(() => props.fingerprint, () => {
  key = null;
  error.value = '';
});
</script>

<style scoped>
.studio-price-control {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.studio-price-line {
  display: flex;
  gap: 8px;
  align-items: center;
}

.studio-price-footer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px 16px;
}

.studio-price-footer > :not(.studio-price-line):not(.studio-price-summary) {
  grid-column: 1 / -1;
}

.studio-price-summary {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 12px;
}

.studio-price-summary > span,
.studio-price-reason {
  color: var(--ink-mid);
  font-size: 12px;
}

.studio-price-summary > strong {
  font-size: 15px;
  font-weight: 600;
}

.studio-price-reason {
  margin: 0;
  line-height: 1.5;
}
</style>
