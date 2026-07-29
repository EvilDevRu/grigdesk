<script setup>
import { reactive } from 'vue';
import { useProvidersStore } from '../stores/providers.js';
import {
  prepareUsageControl,
  usageControlConfirmation,
} from './provider-usage-actions.js';
import ToggleSwitch from './ui/ToggleSwitch.vue';

const props = defineProps({
  providerId: { type: String, required: true },
  resources: { type: Array, default: () => [] },
});
const providers = useProvidersStore();
const local = reactive({});
const EMPTY_STATE = Object.freeze({ busy: false, error: '', ask: null, draft: undefined });

const stateKey = (resource, control) => `${resource.key}:${control.id}`;
function stateOf(resource, control) {
  return local[stateKey(resource, control)] || EMPTY_STATE;
}
function mutableState(resource, control) {
  const key = stateKey(resource, control);
  if (!local[key]) local[key] = { busy: false, error: '', ask: null, draft: undefined };
  return local[key];
}
function draftOf(resource, control) {
  const state = stateOf(resource, control);
  return state.draft === undefined ? (control.value ?? '') : state.draft;
}

function ask(resource, control, input) {
  const state = mutableState(resource, control);
  const prepared = prepareUsageControl(control, input);
  state.error = prepared.ok ? '' : prepared.error;
  state.ask = prepared.ok
    ? {
      ...prepared,
      requestId: globalThis.crypto?.randomUUID?.()
        || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      confirm: usageControlConfirmation(control, prepared.value),
    }
    : null;
}

async function apply(resource, control) {
  const state = mutableState(resource, control);
  if (!state.ask || state.busy) return;
  const request = state.ask;
  state.ask = null;
  state.busy = true;
  const result = await providers.runUsageAction(
    props.providerId,
    request.actionId,
    request.payload,
    request.requestId,
  );
  state.busy = false;
  state.error = result.ok ? '' : (result.error || result.message || 'Не получилось');
  if (result.ok) state.draft = undefined;
  else state.ask = request;
}

function setDraft(resource, control, value) {
  mutableState(resource, control).draft = value;
}
function cancel(resource, control) {
  mutableState(resource, control).ask = null;
}
</script>

<template>
  <span v-if="resources.length" class="pur-list">
    <span v-for="resource in resources" :key="resource.key" class="pur" :class="`is-${resource.tone || 'muted'}`">
      <span class="pur-head">
        <span>{{ resource.label }}</span>
        <b>{{ resource.summary }}</b>
      </span>
      <span v-if="Number.isFinite(resource.percent)" class="pur-bar">
        <span class="pur-fill" :class="{ hot: resource.percent >= 85 }"
              :style="{ width: Math.min(100, resource.percent) + '%' }"></span>
      </span>
      <span v-if="resource.note" class="pur-note">{{ resource.note }}</span>

      <span v-for="control in resource.controls || []" :key="control.id" class="pur-control">
        <a v-if="control.kind === 'link'" class="pur-link" :href="control.href"
           target="_blank" rel="noopener">{{ control.label }}</a>

        <ToggleSwitch v-else-if="control.kind === 'toggle'"
                      :model-value="!!control.value"
                      :disabled="control.disabled || stateOf(resource, control).busy"
                      :label="stateOf(resource, control).busy ? 'применяю…' : control.label"
                      @update:model-value="(value) => ask(resource, control, value)" />

        <span v-else-if="control.kind === 'number'" class="pur-number">
          <span>{{ control.label }}</span>
          <input :value="draftOf(resource, control)" inputmode="decimal"
                 :disabled="control.disabled || stateOf(resource, control).busy"
                 :aria-label="control.label"
                 @input="setDraft(resource, control, $event.target.value)"
                 @keyup.enter="ask(resource, control, draftOf(resource, control))" />
          <span v-if="control.unit">{{ control.unit }}</span>
          <button :disabled="control.disabled || stateOf(resource, control).busy"
                  @click.stop="ask(resource, control, draftOf(resource, control))">
            Сохранить
          </button>
        </span>

        <button v-else-if="control.kind === 'button'" class="pur-button"
                :disabled="control.disabled || stateOf(resource, control).busy"
                @click.stop="ask(resource, control)">
          {{ stateOf(resource, control).busy ? 'выполняю…' : control.label }}
        </button>

        <span v-if="stateOf(resource, control).ask" class="pur-ask">
          <span>{{ stateOf(resource, control).ask.confirm.text }}</span>
          <span class="pur-ask-actions">
            <button class="ok" :class="{ danger: stateOf(resource, control).ask.confirm.danger }"
                    @click.stop="apply(resource, control)">
              {{ stateOf(resource, control).ask.confirm.label }}
            </button>
            <button @click.stop="cancel(resource, control)">Отмена</button>
          </span>
        </span>
        <span v-if="stateOf(resource, control).error" class="pur-error">
          {{ stateOf(resource, control).error }}
        </span>
      </span>
    </span>
  </span>
</template>

<style scoped>
.pur-list, .pur, .pur-control, .pur-ask {
  display: flex;
  flex-direction: column;
}
.pur-list { gap: 9px; }
.pur {
  gap: 5px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}
.pur-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  color: var(--ink-mid);
  font-size: 11.5px;
}
.pur-head b { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
.pur.is-warn .pur-head b { color: var(--warn); }
.pur.is-bad .pur-head b { color: var(--bad); }
.pur-bar {
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--surface-2);
}
.pur-fill { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
.pur-fill.hot { background: var(--bad); }
.pur-note, .pur-error, .pur-link {
  font-size: 10.5px;
  line-height: 1.45;
}
.pur-note { color: var(--ink-mid); }
.pur-error { color: var(--bad); overflow-wrap: anywhere; }
.pur-link { color: var(--ink-mid); text-decoration: underline; }
.pur-link:hover { color: var(--accent); }
.pur-control { align-items: flex-start; gap: 6px; }
.pur-number {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  color: var(--ink-mid);
  font-size: 11px;
}
.pur-number input {
  width: 62px;
  padding: 3px 7px;
  border: 1px solid var(--line-2);
  border-radius: 7px;
  background: var(--surface-2);
  color: var(--ink);
  font-family: var(--mono);
  font-size: 11.5px;
  text-align: right;
}
.pur-number input:focus { outline: none; border-color: var(--accent); }
.pur-number button, .pur-button, .pur-ask-actions button {
  padding: 4px 10px;
  border: 1px solid var(--line-2);
  border-radius: 7px;
  background: var(--surface-2);
  color: var(--ink);
  cursor: pointer;
  font-size: 11px;
}
.pur-number button { margin-left: auto; }
.pur-number button:hover:not(:disabled), .pur-button:hover:not(:disabled),
.pur-ask-actions button:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.pur-number button:disabled, .pur-button:disabled { cursor: default; opacity: .5; }
.pur-ask { gap: 7px; color: var(--ink); font-size: 11px; line-height: 1.45; }
.pur-ask-actions { display: flex; gap: 6px; }
.pur-ask-actions button.ok {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
  font-weight: 600;
}
.pur-ask-actions button.ok.danger { border-color: var(--bad); background: var(--bad); }
</style>
