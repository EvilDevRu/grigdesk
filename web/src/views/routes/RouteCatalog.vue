<template>
  <section class="route-catalog" :data-mode="mode">
    <template v-if="mode !== 'manage'">
    <h2 class="route-catalog__title">{{ t('core.routeChernoviki') }}</h2>
    <p v-if="!drafts.length" class="muted">{{ t('core.routeChernovikovPokaNet') }}</p>
    <UiSelectableRow v-for="draft in drafts" :key="draft.id" data-context="workspace-catalog"
                     :selected="draft.id === selectedDraftId"
                     @select="$emit('select', draft.id)">
      <span>{{ draft.title }}</span>
      <small>{{ 'r' }}{{ draft.revision }} · {{ draft.state === 'editing' ? t('core.routeRedaktiruetsya') : t('core.routeZakryt') }}</small>
    </UiSelectableRow>
    </template>
    <div v-if="document && mode !== 'drafts'" class="route-catalog__editor">
      <details class="route-catalog__operation ui-workspace-disclosure">
        <summary>{{ t('core.routeDobavitIliSkopirovatMarshrut') }}</summary>
        <div class="route-catalog__fields ui-workspace-section__body">
          <strong>{{ t('core.routeSostavKataloga') }}</strong>
          <UiButton data-context="workspace-form" variant="ghost" v-if="mode === 'all'" data-test="catalog-bootstrap" @click="emit('select-bootstrap')"> {{ t('core.routeNachalnayaRazvedka') }} </UiButton>
          <UiField :label="t('core.routeIdNovogoMarshruta')"
                   :help="t('core.routeCatalogAUniqueRouteIDSuchAs')">
            <UiInput data-test="route-new-id" :model-value="newId"
                     @update:model-value="newId = String($event ?? '')" />
          </UiField>
          <label>{{ t('core.taskTitle') }} <UiInput data-test="route-new-title" :model-value="newTitle"
                     @update:model-value="newTitle = String($event ?? '')" />
          </label>
          <UiButton data-context="workspace-form" variant="ghost" data-test="route-create" @click="create">{{ t('core.routeSozdatMarshrut') }}</UiButton>
          <label>{{ t('core.routeSkopirovatMarshrut') }} <UiSelect data-test="route-copy-source" :model-value="copySource"
                      @update:model-value="copySource = String($event ?? '')">
              <option value="">{{ t('core.routeVyberiteMarshrut') }}</option>
              <option v-for="id in routeIds" :key="id" :value="id">{{ id }}</option>
            </UiSelect>
          </label>
          <label>{{ t('core.routeIdKopii') }} <UiInput data-test="route-copy-id" :model-value="copyId"
                     @update:model-value="copyId = String($event ?? '')" />
          </label>
          <UiButton data-context="workspace-form" variant="ghost" data-test="route-copy" :disabled="!copySource" @click="copyRoute"> {{ t('core.routeKopirovatMarshrut') }} </UiButton>
        </div>
      </details>
      <template v-if="selectedBundle">
        <strong>{{ t('core.routeMarshrut') }} {{ selectedRouteId }}</strong>
        <UiField :label="t('core.routeNazvanieMarshruta')"
               :help="t('core.routeCatalogTheNameDistinguishesRoutesInThe')">
          <UiInput data-test="route-title" :model-value="routeTitle"
                   @update:model-value="routeTitle = String($event ?? '')" />
        </UiField>
        <UiField :label="t('core.routeNachalnayaRazvedkaPeredMarshrutom')"
               :help="t('core.routeCatalogTriageStudiesTheTaskAndHelps')">
          <UiSelect data-test="route-bootstrap-mode" :model-value="bootstrapMode"
                    @update:model-value="bootstrapMode = String($event ?? '') as BootstrapMode">
            <option value="">{{ t('core.trackerInUse') }}</option>
            <option value="required">{{ t('core.routeObyazatelna') }}</option>
            <option value="skip">{{ t('core.routePropustit') }}</option>
          </UiSelect>
        </UiField>
        <UiField :label="t('core.routeNachalnyyEtap')"
               :help="t('core.routeCatalogTheStartingStageOfTheRoute')">
          <UiSelect data-test="route-entry" :model-value="entryId"
                    @update:model-value="entryId = String($event ?? '')">
            <option value="">{{ t('core.routeNeVybran') }}</option>
            <option v-for="node in selectedBundle.route.nodes.filter((item) => item.executor !== 'status')"
                    :key="node.id" :value="node.id">{{ node.label || node.id }}</option>
          </UiSelect>
        </UiField>
        <UiButton data-context="workspace-form" variant="ghost" data-test="route-save-properties" @click="saveProperties">{{ t('core.routeSohranitPolyaMarshruta') }}</UiButton>
        <UiField :label="t('core.routeNovyyIdMarshruta')"
               :help="t('core.routeCatalogTheRouteIDUsedInLinks')">
          <UiInput data-test="route-rename-id" :model-value="renameId"
                   @update:model-value="renameId = String($event ?? '')" />
        </UiField>
        <UiButton data-context="workspace-form" variant="ghost" data-test="route-rename" @click="rename">{{ t('core.routePereimenovatId') }}</UiButton>
        <UiButton data-context="workspace-form" variant="ghost" data-test="route-remove" @click="previewRemove">{{ t('core.routeUdalitMarshrut') }}</UiButton>
        <div v-if="removePreview" data-test="route-remove-preview" class="route-catalog__preview">
          <strong>{{ t('core.routeUdalenie') }}{{ removePreview.routeId }}»</strong>
          <p>{{ t('core.routeSsylkiOstanutsyaProblemamiChernovika') }}</p>
          <ul><li v-for="reference in removePreview.references" :key="reference.path">
            {{ reference.path }}
          </li></ul>
          <UiButton data-context="workspace-form" variant="ghost" data-test="route-confirm-remove" @click="remove">{{ t('core.routeUdalitSPokazannymiSsylkami') }}</UiButton>
          <UiButton data-context="workspace-form" variant="ghost" data-test="route-cancel-remove" @click="removePreview = null">{{ t('core.cancel') }}</UiButton>
        </div>
      </template>
      <details v-if="routeIds.length > 1" class="ui-workspace-disclosure">
        <summary>{{ t('core.routeKopirovatEtapyIzDrugogo') }}</summary>
        <div class="ui-workspace-section__body">
          <label>{{ t('core.trackerSource') }} <UiSelect data-test="route-node-source" :model-value="nodeSource"
                      @update:model-value="changeNodeSource(String($event ?? ''))">
              <option value="">{{ t('core.routeVyberiteMarshrut') }}</option>
              <option v-for="id in routeIds" :key="id" :value="id">{{ id }}</option>
            </UiSelect>
          </label>
          <label>{{ t('core.routeTsel') }} <UiSelect data-test="route-node-target" :model-value="nodeTarget"
                      @update:model-value="nodeTarget = String($event ?? '')">
              <option value="">{{ t('core.routeVyberiteMarshrut') }}</option>
              <option v-for="id in routeIds" :key="id" :value="id">{{ id }}</option>
            </UiSelect>
          </label>
          <div class="route-catalog__nodes">
            <UiButton data-context="workspace-form" variant="ghost" v-for="node in sourceNodes" :key="node.id"
                      :data-test="`route-node-copy-${node.id}`"
                      :pressed="copyNodeIds.includes(node.id)" @click="toggleNode(node.id)">
              {{ node.label || node.id }}
            </UiButton>
          </div>
          <UiButton data-context="workspace-form" variant="ghost" data-test="route-copy-nodes" :disabled="!copyNodeIds.length || !nodeTarget"
                    @click="copyNodes">{{ t('core.routeKopirovatVybrannyeEtapy') }}</UiButton>
        </div>
      </details>
      <ul v-if="issues.length" data-test="route-catalog-issues" role="alert">
        <li v-for="(issue, index) in issues" :key="index">{{ issue.message }}</li>
      </ul>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { RouteDraft, RouteDraftSummary } from '../../../../shared/pipeline/routesEditorContracts.ts';
import type { CatalogCommandIssue, CatalogCommandResult } from './catalogCommands.ts';
import { createRoute, cloneRoute, renameRoute, removeRoute, inspectRouteReferences,
  copyNodesFromRoute, setRouteProperties } from './catalogCommands.ts';
import { UiButton, UiField, UiInput, UiSelect, UiSelectableRow, t } from '../../ui.ts';

type BootstrapMode = '' | 'required' | 'skip';

const props = defineProps<{
  mode?: 'all' | 'drafts' | 'manage';
  drafts: RouteDraftSummary[];
  selectedDraftId: string | null;
  document?: RouteDraft | null;
  selectedRouteId?: string
}>();
const mode = computed(() => props.mode ?? 'all');
const emit = defineEmits<{
  select: [id: string];
  change: [document: RouteDraft];
  'select-route': [id: string];
  'select-bootstrap': []
}>();
const newId = ref('');
const newTitle = ref('');
const copySource = ref('');
const copyId = ref('');
const renameId = ref('');
const routeTitle = ref('');
const bootstrapMode = ref<BootstrapMode>('');
const entryId = ref('');
const issues = ref<CatalogCommandIssue[]>([]);
const removePreview = ref<{ routeId: string; references: CatalogCommandIssue[] } | null>(null);
const nodeSource = ref('');
const nodeTarget = ref('');
const copyNodeIds = ref<string[]>([]);
const routeIds = computed(() => Object.keys(props.document?.routes ?? {}).sort());
const selectedBundle = computed(() => props.document?.routes[props.selectedRouteId ?? ''] ?? null);
const sourceNodes = computed(() => props.document?.routes[nodeSource.value]?.route.nodes ?? []);

function plain(): RouteDraft | null {
  return props.document ? JSON.parse(JSON.stringify(props.document)) as RouteDraft : null;
}

/**
 * Применяет результат команды к родительскому состоянию каталога.
 * Операции меняют полный черновик и возвращают ошибки ссылочной целостности.
 */
function apply(result: CatalogCommandResult, input: RouteDraft): boolean {
  issues.value = result.issues;

  if (result.draft === input) {
    return false;
  }

  emit('change', result.draft);

  return true;
}

/**
 * Добавляет новый маршрут с выбранным идентификатором.
 * Операции меняют полный черновик и возвращают ошибки ссылочной целостности.
 */
function create(): void {
  const input = plain();

  if (!input) {
    return;
  }
  if (apply(createRoute(input, newId.value.trim(), newTitle.value), input)) {
    emit('select-route', newId.value.trim());
    copySource.value = newId.value.trim();
    newId.value = '';
    newTitle.value = '';
  }
}

/**
 * Копирует маршрут вместе с его промптами.
 * Операции меняют полный черновик и возвращают ошибки ссылочной целостности.
 */
function copyRoute(): void {
  const input = plain();

  if (!input) {
    return;
  }
  if (apply(cloneRoute(input, copySource.value, copyId.value.trim()), input)) {
    emit('select-route', copyId.value.trim());
    copyId.value = '';
  }
}

/**
 * Переименовывает маршрут с учётом входящих ссылок.
 * Операции меняют полный черновик и возвращают ошибки ссылочной целостности.
 */
function rename(): void {
  const input = plain();

  if (!input || !props.selectedRouteId) {
    return;
  }
  if (apply(renameRoute(input, props.selectedRouteId, renameId.value.trim()), input)) {
    emit('select-route', renameId.value.trim());
    renameId.value = '';
  }
}

function saveProperties(): void {
  const input = plain();

  if (!input || !props.selectedRouteId) {
    return;
  }

  apply(setRouteProperties(input, props.selectedRouteId, {
    title: routeTitle.value,
    bootstrap: bootstrapMode.value,
    entry: entryId.value,
  }), input);
}

function previewRemove(): void {
  if (!props.document || !props.selectedRouteId) {
    return;
  }

  removePreview.value = { routeId: props.selectedRouteId,
    references: inspectRouteReferences(props.document, props.selectedRouteId) };
}

/**
 * Удаляет маршрут после проверки зависимых переходов.
 * Операции меняют полный черновик и возвращают ошибки ссылочной целостности.
 */
function remove(): void {
  const input = plain();

  if (!input || !removePreview.value) {
    return;
  }

  const result = removeRoute(input, removePreview.value.routeId);

  removePreview.value = null;

  if (apply(result, input)) {
    emit('select-route', Object.keys(result.draft.routes).sort()[0] ?? '');
  }
}

function changeNodeSource(value: string): void {
  nodeSource.value = value;
  copyNodeIds.value = [];
}

function toggleNode(id: string): void {
  copyNodeIds.value = copyNodeIds.value.includes(id)
    ? copyNodeIds.value.filter((item) => item !== id) : [...copyNodeIds.value, id];
}

/**
 * Подбирает свободный ключ запуска при копировании узлов.
 * Операции меняют полный черновик и возвращают ошибки ссылочной целостности.
 */
function allocateKey(suggested: string, used: ReadonlySet<string>): string {
  const base = `${suggested}_COPY`;

  if (!used.has(base)) {
    return base;
  }

  for (let index = 2; index < 10_000; index++) {
    const candidate = `${base}_${index}`;

    if (!used.has(candidate)) {
      return candidate;
    }
  }

  return '';
}

/**
 * Переносит выбранные узлы из другого маршрута.
 * Операции меняют полный черновик и возвращают ошибки ссылочной целостности.
 */
function copyNodes(): void {
  const input = plain();

  if (!input) {
    return;
  }
  if (apply(copyNodesFromRoute(input, nodeSource.value, nodeTarget.value,
    copyNodeIds.value, allocateKey), input)) {
    emit('select-route', nodeTarget.value);
  }
}

watch(() => [props.selectedRouteId, props.document?.routes[props.selectedRouteId ?? '']], () => {
  const route = selectedBundle.value?.route;

  routeTitle.value = route?.title ?? '';
  bootstrapMode.value = route?.bootstrap ?? '';
  entryId.value = route?.entry ?? '';
  copySource.value = props.selectedRouteId ?? '';
  nodeTarget.value = props.selectedRouteId ?? '';
  removePreview.value = null;
}, { immediate: true });
</script>

<style scoped>
.route-catalog {
  display: grid;
  gap: 4px;
  padding: 12px 0;
  margin-top: 12px;
  border-top: 1px solid var(--line);
  min-width: 0;
}

.route-catalog[data-mode='manage'] {
  margin: 0;
  padding: 0;
  border: 0;
}

.route-catalog__title {
  margin: 0;
  font-weight: 600;
  font-size: 12px;
  color: var(--ink);
  padding: 0 6px 4px;
}

small {
  display: block;
  color: var(--ink-mid);
}

.route-catalog__editor {
  display: grid;
  gap: 8px;
  min-width: 0;
  max-width: 620px;
}

.route-catalog__editor label {
  display: grid;
  gap: 3px;
  font-size: 12px;
}

.route-catalog__editor details {
  min-width: 0;
}

.route-catalog__editor details label {
  margin-top: 8px;
}

.route-catalog__nodes {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: 8px 0;
}

.route-catalog__preview {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 8px;
}

.route-catalog__preview p {
  margin: 6px 0;
}
</style>
