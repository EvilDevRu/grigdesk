<template>
  <div class="settings-native-editor" :data-field-id="field.id">
    <template v-if="field.children?.length">
      <UiDisclosureButton v-model:open="open" :controls="groupId">
        {{ field.label }} · {{ count(field.children) }}
      </UiDisclosureButton>
      <div
        v-if="open"
        :id="groupId"
        class="settings-native-group"
      >
        <SettingsNativeEditor
          v-for="child in field.children"
          :key="child.id"
          :field="child"
          :provider-id="providerId"
          :expand="expand"
        />
      </div>
    </template>
    <SettingsField v-else :address="address" layout="stack">
      <p
        v-if="field.consumerSupport?.chat?.state === 'verified'
        && field.consumerSupport?.pipeline?.state === 'unsupported'"
      >
        {{ t('settings.chatsOnly') }}
      </p>
      <p v-else-if="field.consumerSupport?.pipeline?.state === 'unverified'">
        {{ field.consumerSupport.pipeline.reason || t('settings.compatibilityWithPipelinesHasNotBeenVerified') }}
      </p>
      <template v-if="field.writable && field.kind === 'array' && field.items">
        <p v-if="value === undefined">{{ t('settings.theProviderSListIsUnknownSelecting') }}</p>
        <div
          v-for="(item, index) in array"
          :key="index"
          class="settings-native-item"
        >
          <SettingsNativeValue
            :field="{ ...field.items, label: t('settings.item', { value1: index + 1 }) }"
            :value="item"
            @change="changeItem(index, $event)"
          />
          <UiButton data-context="workspace-form-wrap" :aria-label="t('settings.removeItem', { value1: index + 1 })" @click="removeItem(index)">{{ t('settings.delete') }}</UiButton>
        </div>
        <UiButton data-context="workspace-form-wrap"
          :disabled="field.constraints.maxItems !== undefined && array.length >= field.constraints.maxItems"
          @click="addItem"
        >
          {{ t('settings.addItem') }}
        </UiButton>
        <UiButton data-context="workspace-form-wrap" v-if="field.constraints.nullable" @click="set(null)">
          {{ t('settings.setEmptyValueNull') }}
        </UiButton>
      </template>
      <SettingsNativeValue
        v-else-if="field.writable"
        :field="field"
        :value="value"
        @change="set"
      />
      <p v-if="field.reason">{{ field.reason }}</p>
      <p>{{ status }}</p>
      <div class="settings-native-actions">
        <UiButton data-context="workspace-form-wrap" v-if="field.override.state === 'known' || state?.dirty" @click="unset">{{ t('settings.reset') }}</UiButton>
        <UiButton data-context="workspace-form-wrap" v-if="state?.dirty" @click="settings.discardField(resourceId, field.id)">
          {{ t('settings.discardEdit') }}
        </UiButton>
        <UiDisclosureButton v-model:open="detailsOpen" :controls="detailsId">{{ t('settings.details') }}</UiDisclosureButton>
      </div>
      <div v-if="detailsOpen" :id="detailsId">
        <p>{{ field.description }}</p>
        <p>{{ t('settings.parameter') }} {{ field.path.join('.') }}</p>
        <p v-if="field.default.state === 'known'">
          {{ t('settings.schemaValue') }} {{ JSON.stringify(field.default.value) }}
        </p>
        <p v-if="field.base.state === 'unknown'">
          {{ t('settings.theProviderDoesNotReportTheOriginal') }}
        </p>
      </div>
    </SettingsField>
  </div>
</template>

<script setup lang="ts">
import { t } from '../../../ui.ts';

import { computed, ref, useId, watch } from 'vue';
import { UiButton, UiDisclosureButton } from '../../../ui.ts';
import type { JsonValue, ProviderSettingNode } from '../../../../../shared/chat/providerSettingsContracts.ts';
import { useSettingsStore } from '../../../stores/settings.ts';
import SettingsField from '../SettingsField.vue';
import SettingsNativeValue from './SettingsNativeValue.vue';

const props = defineProps<{
  field: ProviderSettingNode;
  providerId: string;
  expand?: boolean;
}>();
const settings = useSettingsStore();
const open = ref(Boolean(props.expand) || count(props.field.children ?? []) <= 6);
const detailsOpen = ref(false);
const groupId = `settings-native-group-${useId()}`;
const detailsId = `settings-native-details-${useId()}`;
const resourceId = computed(() => `providerNative:${props.providerId}`);
const address = computed(() => ({
  pageId: 'agents.providers',
  entityId: props.providerId,
  tabId: 'parameters',
  fieldPath: ['native', ...props.field.path],
}));
const state = computed(() => settings.snapshot.resources.find((resource) => resource.id === resourceId.value)
  ?.fields.find((field) => field.key === props.field.id));
const value = computed(() => {
  settings.snapshot;

  const intent = settings.getIntent(resourceId.value, props.field.id);

  if (intent?.op === 'set') {
    return intent.value;
  }
  if (!intent && props.field.override.state === 'known') {
    return props.field.override.value;
  }

  return props.field.base.state === 'known' ? props.field.base.value : undefined;
});
const array = computed(() => Array.isArray(value.value) ? value.value : []);
const status = computed(() => state.value?.dirty
  ? state.value.intent?.op === 'unset' ? t('settings.resetAfterApply') : t('settings.notApplied2')
  : props.field.override.state === 'known' ? t('settings.customChoiceForTheNextRun')
    : t('settings.inheritedApplicationInChatNotConfirmed'));

function count(fields: ProviderSettingNode[]): number {
  return fields.reduce((total, field) => total + (field.children?.length ? count(field.children) : 1), 0);
}

function set(value: JsonValue): void {
  settings.setField(resourceId.value, props.field.id, value);
}

function unset(): void {
  settings.unsetField(resourceId.value, props.field.id);
}

function changeItem(index: number, value: JsonValue): void {
  const next = [...array.value];

  next[index] = value;
  set(next);
}

function removeItem(index: number): void {
  set(array.value.filter((_item, position) => position !== index));
}

/**
 * Добавление создаёт только значение массива в общей сессии, без локального списка drafts.
 * Начальное значение элемента следует его публичному типу и доступному enum.
 */
function addItem(): void {
  const item = props.field.items;
  const initial = item?.constraints.enum?.length ? item.constraints.enum[0]!
    : item?.kind === 'boolean' ? false
      : ['number', 'integer'].includes(item?.kind ?? '') ? item?.constraints.minimum ?? 0 : '';

  set([...array.value, initial]);
}

watch([() => props.expand, () => settings.revealTarget], ([expand, target]) => {
  if (expand || target?.entityId === props.providerId && target.fieldPath[0] === 'native'
      && props.field.path.every((part, index) => target.fieldPath[index + 1] === part)) {
    open.value = true;
  }
}, { immediate: true });
</script>

<style scoped>
.settings-native-editor { display: grid; gap: 12px; min-width: 0; overflow-wrap: anywhere; }
.settings-native-group { display: grid; gap: 20px; padding-inline-start: 12px; }
.settings-native-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
.settings-native-actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
