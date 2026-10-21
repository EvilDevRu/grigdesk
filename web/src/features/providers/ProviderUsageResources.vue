<template>
  <span v-if="resources.length" class="usage-resource-list">
    <span
      v-for="resource in resources"
      :key="resource.key"
      class="usage-resource"
      :class="`is-${resource.tone || 'muted'}`"
    >
      <span class="usage-resource-heading">
        <span>{{ resource.label }}</span>
        <b>{{ resource.summary }}</b>
      </span>

      <span
        v-if="Number.isFinite(resource.percent)"
        class="usage-resource-bar"
      >
        <span
          class="usage-resource-fill"
          :class="{ hot: resource.percent >= 85 }"
          :style="{ width: `${Math.min(100, resource.percent)}%` }"
        />
      </span>

      <span v-if="noteOf(resource)" class="usage-resource-note">
        {{ noteOf(resource) }}
      </span>

      <span
        v-for="control in controlsOf(resource)"
        :key="control.id"
        class="usage-control"
      >
        <UiActionLink
          v-if="control.kind === 'link'"
          data-context="topbar-popover-resource-link"
          :href="control.href"
          variant="text"
          target="_blank"
        >
          {{ control.label }}
        </UiActionLink>

        <UiSwitch
          v-else-if="control.kind === 'toggle'"
          :model-value="Boolean(control.value)"
          :disabled="control.disabled || stateOf(resource, control).busy"
          @update:model-value="ask(resource, control, $event)"
        >
          {{ stateOf(resource, control).busy ? t('core.applying') : control.label }}
        </UiSwitch>

        <span v-else-if="control.kind === 'number'" class="usage-number-control">
          <span>{{ control.label }}</span>
          <span class="usage-number-field">
            <UiInput
              :model-value="draftOf(resource, control)"
              inputmode="decimal"
              :disabled="control.disabled || stateOf(resource, control).busy"
              :aria-label="control.label"
              @update:model-value="setDraft(resource, control, $event)"
              @keyup.enter="ask(resource, control, draftOf(resource, control))"
            />
          </span>
          <span v-if="control.unit">{{ control.unit }}</span>
          <span class="usage-number-save">
            <UiButton
              data-context="topbar-popover-action"
              :disabled="control.disabled"
              :loading="stateOf(resource, control).busy"
              @click.stop="ask(resource, control, draftOf(resource, control))"
            >
              {{ t('core.save') }}
            </UiButton>
          </span>
        </span>

        <UiButton
          v-else-if="control.kind === 'button'"
          data-context="topbar-popover-action"
          :disabled="control.disabled"
          :loading="stateOf(resource, control).busy"
          @click.stop="ask(resource, control)"
        >
          {{ control.label }}
        </UiButton>

        <UiInlineConfirm
          v-if="stateOf(resource, control).ask"
          data-context="topbar-popover-confirm"
          :model-value="true"
          :question="confirmationOf(resource, control).text"
          :confirm-text="confirmationOf(resource, control).label"
          :tone="confirmationTone(resource, control)"
          :loading="stateOf(resource, control).busy"
          @update:model-value="updateConfirmation(resource, control, $event)"
          @confirm="apply(resource, control)"
        />

        <span v-if="stateOf(resource, control).error" class="usage-control-error">
          {{ stateOf(resource, control).error }}
        </span>
      </span>
    </span>
  </span>
</template>

<script setup>
import { uiLocale } from '../../ui.ts';

import { t } from '../../ui.ts';

import { computed, reactive } from 'vue';
import { localizeUsageResource } from './providerUsage.js';
import { useProvidersStore } from '../../stores/providers.js';
import {
  UiActionLink,
  UiButton,
  UiInput,
  UiInlineConfirm,
  UiSwitch,
} from '../../ui';
import {
  prepareUsageControl,
  usageControlConfirmation,
} from './providerUsageActions.js';

const props = defineProps({
  providerId: {
    type: String,
    required: true,
  },
  resources: {
    type: Array,
    default: () => [],
  },
  // Всплывашка топбара показывает ресурсы только на чтение: единственное место
  // изменения — плашка исполнителя в настройках.
  readonly: {
    type: Boolean,
    default: false,
  },
});

const providers = useProvidersStore();
const resources = computed(() => props.resources.map((resource) =>
  localizeUsageResource(props.providerId, resource, uiLocale)));
const local = reactive({});
const EMPTY_STATE = Object.freeze({
  busy: false,
  error: '',
  ask: null,
  draft: undefined,
});

/**
 * Ручки, которые здесь действительно можно тронуть. Ресурсом владеет исполнитель, он же
 * говорит, где ручка уместна: настройка аккаунта (доплата, потолок) крутится только в
 * своей плашке настроек, а `scope: 'live'` — операция над рантаймом, и её место там, где
 * человек видит состояние, то есть и во всплывашке топбара.
 */
function controlsOf(resource) {
  return (resource.controls || [])
    .filter((control) => !props.readonly || control.scope === 'live');
}

/**
 * Заметка ресурса. Во всплывашке она остаётся только у беды: «месячный потолок выбран —
 * сверх лимитов подписки работа не пойдёт» терять нельзя, а спокойное «причина отказа:
 * out_of_credits» стоит рядом со сводкой «выключено» и говорит то же самое второй раз.
 * Состояние самих ручек там не отражается вовсе — на «включено или нет» отвечает сводка.
 */
function noteOf(resource) {
  if (!resource.note) {
    return '';
  }

  return !props.readonly || resource.tone === 'bad' ? resource.note : '';
}

function stateKey(resource, control) {
  return `${resource.key}:${control.id}`;
}

function stateOf(resource, control) {
  return local[stateKey(resource, control)] || EMPTY_STATE;
}

function mutableState(resource, control) {
  const key = stateKey(resource, control);

  if (!local[key]) {
    local[key] = {
      busy: false,
      error: '',
      ask: null,
      draft: undefined,
    };
  }

  return local[key];
}

function draftOf(resource, control) {
  const state = stateOf(resource, control);

  return state.draft === undefined
    ? (control.value ?? '')
    : state.draft;
}

function confirmationTone(resource, control) {
  return stateOf(resource, control).ask?.confirm.danger
    ? 'danger'
    : 'accent';
}

/**
 * Открытое подтверждение разрешается из текущей проекции control при каждом показе.
 * Сохранённый request и введённое значение остаются прежними до явного действия.
 */
function confirmationOf(resource, control) {
  const request = stateOf(resource, control).ask;

  return usageControlConfirmation(control, request?.value, uiLocale);
}

/**
 * Подтверждение хранится отдельно для каждого server-declared control: смена
 * черновика одного лимита не должна затронуть соседний ресурс провайдера.
 */
function ask(resource, control, input) {
  const state = mutableState(resource, control);

  if (state.busy) {
    return;
  }

  const prepared = prepareUsageControl(control, input, uiLocale);

  state.error = prepared.ok ? '' : prepared.error;
  state.ask = prepared.ok
    ? {
      ...prepared,
      requestId: globalThis.crypto?.randomUUID?.()
        || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      confirm: usageControlConfirmation(control, prepared.value, uiLocale),
    }
    : null;
}

function actionError(error) {
  return error instanceof Error && error.message
    ? error.message
    : t('core.failed2');
}

/**
 * Подтверждённый request сохраняется до результата. При ошибке его можно
 * повторить без повторного ввода значения и с тем же идемпотентным requestId.
 */
async function apply(resource, control) {
  const state = mutableState(resource, control);

  if (!state.ask || state.busy) {
    return;
  }

  const request = state.ask;

  state.busy = true;

  try {
    const result = await providers.runUsageAction(
      props.providerId,
      request.actionId,
      request.payload,
      request.requestId,
    );

    state.error = result.ok
      ? ''
      : (result.error || result.message || t('core.failed2'));

    if (result.ok) {
      state.ask = null;
      state.draft = undefined;
    }
  } catch (error) {
    state.error = actionError(error);
  } finally {
    state.busy = false;
  }
}

function setDraft(resource, control, value) {
  mutableState(resource, control).draft = value;
}

function cancel(resource, control) {
  mutableState(resource, control).ask = null;
}

function updateConfirmation(resource, control, open) {
  if (!open) {
    cancel(resource, control);
  }
}
</script>

<style scoped>
.usage-resource-list,
.usage-resource,
.usage-control {
  display: flex;
  flex-direction: column;
}

.usage-resource-list {
  gap: 9px;
}

.usage-resource {
  gap: 5px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}

.usage-resource-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  color: var(--ink-mid);
  font-size: 11.5px;
}

/* Значение держится одной строкой у правого края, переносится подпись слева. */
.usage-resource-heading b {
  color: var(--ink);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}

.usage-resource.is-warn .usage-resource-heading b {
  color: var(--warn);
}

.usage-resource.is-bad .usage-resource-heading b {
  color: var(--bad);
}

.usage-resource-bar {
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--surface-2);
}

.usage-resource-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
}

.usage-resource-fill.hot {
  background: var(--bad);
}

.usage-resource-note,
.usage-control-error {
  font-size: 10.5px;
  line-height: 1.45;
}

.usage-resource-note {
  color: var(--ink-mid);
}

.usage-control-error {
  color: var(--bad);
  overflow-wrap: anywhere;
}

.usage-control {
  align-items: flex-start;
  gap: 6px;
}

.usage-number-control {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  color: var(--ink-mid);
  font-size: 11px;
}

.usage-number-field {
  flex: none;
  width: 72px;
}

.usage-number-save {
  margin-left: auto;
}

</style>
