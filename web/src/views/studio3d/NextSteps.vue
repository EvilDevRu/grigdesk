<template>
  <section class="studio-next">
    <h3>{{ heading }}</h3>
    <section v-for="group in groups" :key="group.id" class="studio-next-group">
      <h4>{{ group.label }}</h4>
      <div v-for="offer in group.offers" :key="key(offer)" class="studio-next-offer">
        <UiDisclosureButton :open="selectedKey === key(offer)" :controls="`${stepId}-${key(offer)}`"
          :disabled="!offer.available" data-context="studio-next-operation"
          @click="selectedKey === key(offer) ? selectedKey = '' : select(offer)">
          <span class="studio-next-label">{{ offer.label }}</span>
          <span class="studio-next-price">{{ formatPrice(offer.quote.total, offer.quote.unit) }}</span>
        </UiDisclosureButton>
        <p v-if="!offer.available" class="studio-next-hint">{{ offer.reason }}</p>
        <div v-if="selectedKey === key(offer) && offer.available" :id="`${stepId}-${key(offer)}`"
          class="studio-next-form">
          <p class="studio-next-hint">{{ offer.providerName }} · исходная версия сохранится в дереве.</p>
          <OperationForm v-model="values" :fields="offer.fields" :errors="validation?.errors" />
          <p v-if="offer.note">{{ offer.note }}</p>
          <PriceButton :quote="quote" :validation="validation" :balance="balance"
            :billing-url="provider?.billingUrl" :verb="offer.label" :fingerprint="fingerprint"
            :execute="execute" @price-changed="priceChanged" @refresh="store.loadState" />
          <UiInlineMessage v-if="changed" tone="warning">Цена изменилась. Подтвердите новую цену.</UiInlineMessage>
        </div>
      </div>
    </section>
    <p v-if="!groups.length">Для этой версии пока нет следующих шагов.</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch, onUnmounted, toRaw, useId } from 'vue';
import { UiDisclosureButton, UiInlineMessage } from '../../ui.ts';
import { useStudio3dStore } from '../../stores/studio3d.ts';
import { OPERATION_GROUPS, formatPrice } from '../../../../shared/studio3d/studio3dOperations.ts';
import type { FieldValues } from '../../../../shared/studio3d/studio3dOperations.ts';
import type { Studio3dOffer, Studio3dQuote } from '../../../../shared/studio3d/studio3dContracts.ts';
import OperationForm from './OperationForm.vue';
import PriceButton from './PriceButton.vue';

const props = withDefaults(defineProps<{
  modelId: string;
  versionId: string;
  openOperation?: string;
  heading?: string
}>(), { openOperation: '', heading: 'Доработать модель' });
const emit = defineEmits<{ created: [modelId: string, versionId?: string] }>();
const store = useStudio3dStore();
const selectedKey = ref('');
const values = ref<FieldValues>({});
const changed = ref(false);
const stepId = `studio-step-${useId()}`;
let openedOperation = '';
let alive = true;

const key = (offer: Studio3dOffer) => `${offer.provider}:${offer.operation}`;
const selected = computed(() => store.offers.find((offer) => key(offer) === selectedKey.value));
const groups = computed(() => {
  const ids = [...new Set([...OPERATION_GROUPS.map((item) => item.id),
    ...store.offers.map((item) => item.group)])];
  
  return ids.map((id) => ({
    id,
    label: OPERATION_GROUPS.find((item) => item.id === id)?.label || 'Другие действия',
    offers: store.offers.filter((item) => item.group === id)
  })).filter((item) => item.offers.length);
});
const provider = computed(() => store.state?.providers.find((item) => item.id === selected.value?.provider));
const balance = computed(() => provider.value?.balance?.available ?? null);
const quote = computed(() => store.quoted?.quote || null);
const validation = computed(() => store.quoted?.validation || null);
const fingerprint = computed(() => JSON.stringify([store.libraryId, props.modelId, props.versionId,
  selectedKey.value, values.value]));

/**
 * Выбор шага накладывает только его объявленные defaults и отзывает предыдущую цену.
 * Нельзя оплатить форму одного действия по котировке другого.
 */
function select(offer: Studio3dOffer): void {
  selectedKey.value = key(offer);
  values.value = Object.fromEntries(offer.fields.map((field) => [field.id, field.default ?? null]));
  changed.value = false;
}

watch(() => [props.modelId, props.versionId, store.libraryId], () => {
  selectedKey.value = '';
  openedOperation = '';
  store.quoted = null;
  void store.loadOffers({ modelId: props.modelId, versionId: props.versionId });
}, { immediate: true });
watch(fingerprint, () => {
  changed.value = false;
  
  const offer = selected.value;
  
  if (offer) {
    void store.quote({
      modelId: props.modelId,
      versionId: props.versionId,
      provider: offer.provider,
      operation: offer.operation,
      values: toRaw(values.value)
    });
  }
  else {
    store.quoted = null;
  }
});
watch(() => [props.openOperation, store.offers], () => {
  if (!props.openOperation) {
    openedOperation = '';
  }

  const offer = store.offers.find((item) => item.operation === props.openOperation && item.available);
  
  if (offer && openedOperation !== props.openOperation) {
    select(offer);
    openedOperation = props.openOperation;
  }
}, { immediate: true });
onUnmounted(() => {
  alive = false;
});

/**
 * Нажатие фиксирует нормализованные значения и исходную версию в durable request.
 * Поздний ответ после ухода не меняет selection или котировку нового экрана.
 */
async function execute(idempotencyKey: string): Promise<unknown> {
  const offer = selected.value;
  const price = quote.value?.total;
  
  if (!offer || price === null || price === undefined || !validation.value) {
    return { cancelled: true };
  }
  
  const marker = fingerprint.value;
  const result = await store.run({
    modelId: props.modelId,
    versionId: props.versionId,
    provider: offer.provider,
    operation: offer.operation,
    values: JSON.parse(JSON.stringify(validation.value.values)),
    expectedPrice: price
  }, idempotencyKey);
  
  if (alive && marker === fingerprint.value && 'model' in result && result.model) {
    emit('created', result.model.id, result.versions[0]?.id ?? props.versionId);
  }
  
  return result;
}

/**
 * Перерасчёт отображается человеку без автоматического повторного POST.
 * Общий PriceButton сохранит прежнее намерение и потребует нового нажатия.
 */
function priceChanged(value: Studio3dQuote): void {
  if (store.quoted) {
    store.quoted.quote = value;
  }
  
  changed.value = true;
}
</script>

<style scoped>
.studio-next,
.studio-next-group,
.studio-next-offer,
.studio-next-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.studio-next h3,
.studio-next h4,
.studio-next p {
  margin: 0;
}

.studio-next h3 {
  font-size: 13px;
  font-weight: 600;
}

.studio-next h4 {
  color: var(--ink-mid);
  font-size: 11px;
  font-weight: 500;
}

.studio-next-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 0;
}

.studio-next-label {
  min-width: 0;
  overflow-wrap: anywhere;
}

.studio-next-price {
  color: var(--ink-mid);
  font-size: 11px;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}

.studio-next-form {
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}

.studio-next-hint {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}
</style>
