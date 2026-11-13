<template>
  <section class="route-transfer">
    <h3>{{ t('core.routeEksportIImportJson') }}</h3>
    <p class="muted">{{ t('core.routeKomplektSoderzhitMarshrutyRazvedku') }}</p>
    <div class="route-transfer__row">
      <label>{{ t('core.routeEksportirovat') }} <UiSelect v-model="exportRouteId" data-test="transfer-export-scope">
          <option value="">{{ t('core.routeVesKatalog') }}</option>
          <option v-for="routeId in routeIds" :key="routeId" :value="routeId"> {{ t('core.routeTolko') }} {{ routeId }}
          </option>
        </UiSelect>
      </label>
      <UiButton data-test="transfer-export" :disabled="busy || dirty" @click="exportFile"> {{ t('core.routeSkachatJson') }} </UiButton>
    </div>
    <div class="route-transfer__row">
      <UiFilePicker accept=".json,application/json" :label="t('core.routeVybratJsonKomplekt')"
                    :busy="busy" @change="readFiles" @reset="clearFile" />
    </div>
    <p v-if="error" class="bad" role="alert">{{ error }}</p>
    <template v-if="bundle">
      <p>{{ t('core.routeIshodnyyProekt') }} <strong>{{ bundle.sourceProfile }}</strong> {{ t('core.routeMarshruty2') }} {{ Object.keys(bundle.content.routes).join(', ') || t('core.routeNet') }}</p>
      <p v-if="bundle.dependencies.length" class="bad" data-test="transfer-dependencies"> {{ t('core.routeVneshnieZavisimosti') }} {{ bundle.dependencies.join(', ') }}{{ t('core.routeIhNuzhnoRazreshitV') }} </p>
      <div class="route-transfer__row">
        <label>{{ t('core.routeTselevoyProekt') }} <UiSelect v-model="targetProfile" data-test="transfer-target-profile">
            <option v-for="profile in profiles" :key="profile" :value="profile">
              {{ profile }}
            </option>
          </UiSelect>
        </label>
        <label>{{ t('core.routeNazvanieNovogoChernovika') }} <UiInput v-model="title" data-test="transfer-title" />
        </label>
        <label>{{ t('core.routeSposobImporta') }} <UiSelect v-model="importMode" data-test="transfer-import-mode">
            <option value="new">{{ t('core.routeSozdatNovyyChernovik') }}</option>
            <option v-if="singleRoute && document.state === 'editing'
                      && targetProfile === document.profile"
                    value="add">{{ t('core.routeDobavitVOtkrytyyChernovik') }}</option>
          </UiSelect>
        </label>
      </div>
      <div v-if="importMode === 'add' && collision" class="route-transfer__row">
        <p>{{ t('core.routeMarshrut') }} {{ importedRouteId }} {{ t('core.routeUzheEstVChernovike') }}</p>
        <label>{{ t('core.routeSovpavshiyId') }} <UiSelect v-model="collisionChoice" data-test="transfer-collision">
            <option value="cancel">{{ t('core.routeOtmenitImport') }}</option>
            <option value="replace">{{ t('core.routeZamenitMarshrut') }}</option>
            <option value="rename">{{ t('core.routePereimenovatImportiruemyy') }}</option>
          </UiSelect>
        </label>
        <label v-if="collisionChoice === 'rename'">{{ t('core.routeNovyyId') }} <UiInput v-model="newRouteId" data-test="transfer-new-id" />
        </label>
      </div>
      <UiButton data-test="transfer-import" :disabled="!canImport" @click="importFile"> {{ t('core.routeImportirovat') }} </UiButton>
    </template>
    <template v-if="result">
      <p v-if="result.cancelled">{{ t('core.routeImportOtmenenChernovikNe') }}</p>
      <p v-else>{{ t('core.routeChernovikSohranenReviziya') }} {{ result.draft.revision }}.</p>
      <p v-if="result.unresolvedDependencies.length" class="bad"> {{ t('core.routeNerazreshennyeSsylki') }} {{ result.unresolvedDependencies.join(', ') }}.
      </p>
      <ul v-if="result.issues.length">
        <li v-for="(issue, index) in result.issues" :key="index">
          {{ issue.message }}
        </li>
      </ul>
      <UiButton v-if="!result.cancelled && importMode === 'new'"
                data-test="transfer-open" @click="openImported"> {{ t('core.routeOtkrytNovyyChernovik') }} </UiButton>
    </template>
  </section>
</template>

<script setup lang="ts">
import { saveFile } from '../../shared/saveFile.ts';
import { computed, ref, watch } from 'vue';

import {
  parseRouteTransferBundle, ROUTES_EDITOR_LIMITS,
} from '../../../../shared/pipeline/routesEditorContracts.ts';
import type {
  RouteDraft, RouteTransferBundle, RouteTransferImportResult,
} from '../../../../shared/pipeline/routesEditorContracts.ts';
import {
  addRouteTransfer, exportRouteTransfer, importRouteTransfer,
} from '../../actions/routes';
import { failureText } from '../../shared/apiClient.ts';
import { UiButton, UiFilePicker, UiInput, UiSelect, t } from '../../ui';

const props = defineProps<{
  document: RouteDraft;
  profiles: string[];
  dirty: boolean;
}>();
const emit = defineEmits<{
  open: [profile: string, draftId: string, routeId: string | null];
}>();
const busy = ref(false);
const error = ref('');
const exportRouteId = ref('');
const bundle = ref<RouteTransferBundle | null>(null);
const result = ref<RouteTransferImportResult | null>(null);
const targetProfile = ref(props.document.profile);
const title = ref(t('core.routeImportirovannyyKomplekt'));
const importMode = ref<'new' | 'add'>('new');
const collisionChoice = ref<'cancel' | 'replace' | 'rename'>('cancel');
const newRouteId = ref('');
const routeIds = computed(() => Object.keys(props.document.routes).sort());
const importedRouteId = computed(() => Object.keys(bundle.value?.content.routes ?? {})[0] ?? '');
const singleRoute = computed(() => Object.keys(bundle.value?.content.routes ?? {}).length === 1);
const collision = computed(() => singleRoute.value
  && Object.hasOwn(props.document.routes, importedRouteId.value));
const canImport = computed(() => Boolean(bundle.value && !busy.value && !props.dirty
  && targetProfile.value && title.value.trim()
  && (importMode.value === 'new' || (singleRoute.value
    && props.document.state === 'editing'
    && targetProfile.value === props.document.profile))
  && !(importMode.value === 'add' && collision.value && collisionChoice.value === 'rename'
    && !newRouteId.value.trim())));

watch(targetProfile, (profile) => {
  if (profile !== props.document.profile) {
    importMode.value = 'new';
  }
});

watch(() => props.document.id, () => {
  clearFile();
  targetProfile.value = props.document.profile;
  importMode.value = 'new';
  exportRouteId.value = '';
});

function clearFile(): void {
  bundle.value = null;
  result.value = null;
  error.value = '';
}

/** Читает только один ограниченный JSON-файл; неизвестные поля отклоняет общий decoder. */
/**
 * Читает выбранный файл с проверкой ограничения размера.
 * Диалог сохраняет ошибки импорта видимыми до исправления файла или выбора.
 */
async function readFiles(files: File[]): Promise<void> {
  clearFile();

  const file = files[0];

  if (!file) {
    return;
  }
  if (file.size > ROUTES_EDITOR_LIMITS.importBytes) {
    error.value = t('core.routeJsonKomplektBolshe64');

    return;
  }

  try {
    const raw = await file.text();

    if (new TextEncoder().encode(raw).length > ROUTES_EDITOR_LIMITS.importBytes) {
      error.value = t('core.routeJsonKomplektBolshe64');

      return;
    }

    bundle.value = parseRouteTransferBundle(JSON.parse(raw));
    title.value = t('core.routeImportIzSourceprofile', { sourceProfile: bundle.value.sourceProfile });
  } catch (failure) {
    error.value = failureText(failure, t('core.routeNeUdalosProchitatJson'));
  }
}

/** Скачивает документ авторства, а не runtime-путь или служебный журнал. */
/**
 * Создаёт локальную загрузку экспортированного бандла.
 * Диалог сохраняет ошибки импорта видимыми до исправления файла или выбора.
 */
async function exportFile(): Promise<void> {
  busy.value = true;
  error.value = '';

  try {
    const exported = await exportRouteTransfer(exportRouteId.value || null);
    const blob = new Blob([`${JSON.stringify(exported, null, 2)}\n`],
      { type: 'application/json' });

    await saveFile(blob, `routes-${exportRouteId.value || 'catalog'}.json`);
  } catch (failure) {
    error.value = failureText(failure, t('core.routeNeUdalosEksportirovatKomplekt'));
  } finally {
    busy.value = false;
  }
}

/** Импорт пишет отдельный draft или одну typed-команду в открытый draft. */
/**
 * Импортирует проверенный файл в новый или открытый черновик.
 * Диалог сохраняет ошибки импорта видимыми до исправления файла или выбора.
 */
async function importFile(): Promise<void> {
  if (!bundle.value || !canImport.value) {
    return;
  }

  busy.value = true;
  error.value = '';
  result.value = null;

  try {
    if (importMode.value === 'new') {
      result.value = await importRouteTransfer(title.value.trim(), targetProfile.value,
        bundle.value);
    } else {
      result.value = await addRouteTransfer(bundle.value,
        collision.value ? collisionChoice.value : 'require-choice',
        collisionChoice.value === 'rename' ? newRouteId.value.trim() : undefined);
    }
  } catch (failure) {
    error.value = failureText(failure, t('core.routeNeUdalosImportirovatKomplekt'));
  } finally {
    busy.value = false;
  }
}

function openImported(): void {
  if (!result.value || result.value.cancelled) {
    return;
  }

  emit('open', result.value.draft.profile, result.value.draft.id,
    importedRouteId.value || null);
}
</script>

<style scoped>
.route-transfer { border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
.route-transfer__row { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; margin: 10px 0; }
.route-transfer__row label { display: grid; gap: 5px; }
.bad { color: var(--bad); }
</style>
