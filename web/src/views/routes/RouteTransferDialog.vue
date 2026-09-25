<template>
  <section class="route-transfer">
    <h3>Экспорт и импорт JSON</h3>
    <p class="muted">Комплект содержит маршруты, разведку и тексты инструкций.
      Импорт создаёт черновик и не запускает команды или публикацию.</p>
    <div class="route-transfer__row">
      <label>Экспортировать
        <UiSelect v-model="exportRouteId" data-test="transfer-export-scope">
          <option value="">Весь каталог</option>
          <option v-for="routeId in routeIds" :key="routeId" :value="routeId">
            Только {{ routeId }}
          </option>
        </UiSelect>
      </label>
      <UiButton data-test="transfer-export" :disabled="busy || dirty" @click="exportFile">
        Скачать JSON
      </UiButton>
    </div>
    <div class="route-transfer__row">
      <UiFilePicker accept=".json,application/json" label="Выбрать JSON-комплект"
                    :busy="busy" @change="readFiles" @reset="clearFile" />
    </div>
    <p v-if="error" class="bad" role="alert">{{ error }}</p>
    <template v-if="bundle">
      <p>Исходный проект: <strong>{{ bundle.sourceProfile }}</strong> · маршруты:
        {{ Object.keys(bundle.content.routes).join(', ') || 'нет' }}</p>
      <p v-if="bundle.dependencies.length" class="bad" data-test="transfer-dependencies">
        Внешние зависимости: {{ bundle.dependencies.join(', ') }}.
        Их нужно разрешить в целевом каталоге до публикации.
      </p>
      <div class="route-transfer__row">
        <label>Целевой проект
          <UiSelect v-model="targetProfile" data-test="transfer-target-profile">
            <option v-for="profile in profiles" :key="profile" :value="profile">
              {{ profile }}
            </option>
          </UiSelect>
        </label>
        <label>Название нового черновика
          <UiInput v-model="title" data-test="transfer-title" />
        </label>
        <label>Способ импорта
          <UiSelect v-model="importMode" data-test="transfer-import-mode">
            <option value="new">Создать новый черновик</option>
            <option v-if="singleRoute && document.state === 'editing'
                      && targetProfile === document.profile"
                    value="add">Добавить в открытый черновик</option>
          </UiSelect>
        </label>
      </div>
      <div v-if="importMode === 'add' && collision" class="route-transfer__row">
        <p>Маршрут {{ importedRouteId }} уже есть в черновике. Выберите действие.</p>
        <label>Совпавший ID
          <UiSelect v-model="collisionChoice" data-test="transfer-collision">
            <option value="cancel">Отменить импорт</option>
            <option value="replace">Заменить маршрут</option>
            <option value="rename">Переименовать импортируемый</option>
          </UiSelect>
        </label>
        <label v-if="collisionChoice === 'rename'">Новый ID
          <UiInput v-model="newRouteId" data-test="transfer-new-id" />
        </label>
      </div>
      <UiButton data-test="transfer-import" :disabled="!canImport" @click="importFile">
        Импортировать
      </UiButton>
    </template>
    <template v-if="result">
      <p v-if="result.cancelled">Импорт отменён; черновик не менялся.</p>
      <p v-else>Черновик сохранён: ревизия {{ result.draft.revision }}.</p>
      <p v-if="result.unresolvedDependencies.length" class="bad">
        Неразрешённые ссылки: {{ result.unresolvedDependencies.join(', ') }}.
      </p>
      <ul v-if="result.issues.length">
        <li v-for="(issue, index) in result.issues" :key="index">
          {{ issue.message }}
        </li>
      </ul>
      <UiButton v-if="!result.cancelled && importMode === 'new'"
                data-test="transfer-open" @click="openImported">
        Открыть новый черновик
      </UiButton>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import {
  parseRouteTransferBundle, ROUTES_EDITOR_LIMITS,
} from '../../../../shared/routesEditorContracts.ts';
import type {
  RouteDraft, RouteTransferBundle, RouteTransferImportResult,
} from '../../../../shared/routesEditorContracts.ts';
import {
  addRouteTransfer, exportRouteTransfer, importRouteTransfer,
} from '../../actions/routes';
import { failureText } from '../../shared/apiClient.ts';
import { UiButton, UiFilePicker, UiInput, UiSelect } from '../../ui';

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
const title = ref('Импортированный комплект');
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
    error.value = 'JSON-комплект больше 64 МиБ.';

    return;
  }

  try {
    const raw = await file.text();

    if (new TextEncoder().encode(raw).length > ROUTES_EDITOR_LIMITS.importBytes) {
      error.value = 'JSON-комплект больше 64 МиБ.';

      return;
    }

    bundle.value = parseRouteTransferBundle(JSON.parse(raw));
    title.value = `Импорт из ${bundle.value.sourceProfile}`;
  } catch (failure) {
    error.value = failureText(failure, 'Не удалось прочитать JSON-комплект.');
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
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = `routes-${exportRouteId.value || 'catalog'}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (failure) {
    error.value = failureText(failure, 'Не удалось экспортировать комплект.');
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
    error.value = failureText(failure, 'Не удалось импортировать комплект.');
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
