<template>
  <UiDialog :open="open" title="Сохранить в проект" :busy="busy" @close="$emit('close')">
    <div class="studio-save-fields">
      <p class="studio-save-hint">{{ model.name }} · {{ version.label }}. Готовый файл копируется бесплатно.</p>
      <UiInlineMessage v-if="!projectsLoading && !projects.length && !error">
        Сначала добавьте проект с репозиторием в разделе «Проекты». Модель останется в библиотеке.
      </UiInlineMessage>
      <UiField label="Проект"><UiSelect v-model="projectId" :disabled="busy">
        <option value="">Выберите проект</option><option v-for="item in projects" :key="item.id" :value="item.id">
          {{ item.title }}</option>
      </UiSelect></UiField>
      <UiField label="Репозиторий"><UiSelect v-model="repoKey" :disabled="busy">
        <option v-for="item in repos" :key="item.key" :value="item.key">{{ item.key }} · {{ item.dir }}</option>
      </UiSelect></UiField>
      <UiField label="Папка" hint="Относительно репозитория"><UiInput v-model="folder"
        data-context="studio-save-folder" :disabled="busy" /></UiField>
      <UiField label="Имя файла"><UiInput v-model="fileName" :disabled="busy" /></UiField>
      <UiField label="Формат"><UiSelect v-model="format" :disabled="busy">
        <option :value="nativeExt">{{ nativeExt.toUpperCase() }} · бесплатно</option>
        <option v-for="ext in ['glb', 'fbx', 'obj', 'stl'].filter((item) => item !== nativeExt)"
          :key="ext" :value="ext">{{ ext.toUpperCase() }}</option>
      </UiSelect></UiField>
      <UiInlineMessage v-if="format !== nativeExt">
        Другой формат подготовьте шагом «Экспорт». Стоимость будет показана перед запуском.
        <UiButton variant="ghost" @click="$emit('export')">Открыть «Экспорт»</UiButton>
      </UiInlineMessage>
      <div v-if="projectId && repoKey" class="studio-save-destination">
        <span>Файл появится в репозитории {{ repoKey }}</span>
        <strong>{{ [folder, fileName].filter(Boolean).join('/') }}</strong>
      </div>
      <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
    </div>
    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="$emit('close')">Отмена</UiButton>
      <UiButton :loading="busy" :disabled="!projectId || !repoKey || !fileName || format !== nativeExt"
        @click="save">Сохранить</UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { UiDialog, UiField, UiSelect, UiInput, UiButton, UiInlineMessage, confirmDialog } from '../../ui.ts';
import { projectsApi } from '../../shared/projectsApi.ts';
import type { ProjectSummary } from '../../../../shared/runtime/projectsContracts.ts';
import type { Studio3dModel, Studio3dVersion } from '../../../../shared/studio3d/studio3dContracts.ts';
import { useStudio3dStore } from '../../stores/studio3d.ts';
import {
  studioSlug,
  studioErrorMessage
} from '../../features/studio3d/presentation.ts';

const props = defineProps<{
  open: boolean;
  model: Studio3dModel;
  version: Studio3dVersion;
  folders?: Record<string, Record<string, string>> | null
}>();
const emit = defineEmits<{
  close: [];
  saved: [path: string];
  export: []
}>();
const store = useStudio3dStore();
const projects = ref<ProjectSummary[]>([]);
const projectsLoading = ref(true);
const projectId = ref(props.model.project || '');
const repoKey = ref('');
const folder = ref('');
const fileName = ref('');
const format = ref('');
const busy = ref(false);
const error = ref('');
let alive = true;

const source = computed(() => props.version.files.find((item) => item.id === props.version.mainFileId));
const nativeExt = computed(() => source.value?.name.split('.').at(-1)?.toLowerCase() || 'glb');
const repos = computed(() => projects.value.find((item) => item.id === projectId.value)?.repos || []);
const fingerprint = computed(() => JSON.stringify([store.libraryId, props.model.id, props.version.id,
  projectId.value, repoKey.value, folder.value, fileName.value, format.value, props.open]));

watch(() => [props.open, props.version.id], () => {
  if (!props.open) {
    return;
  }
  
  fileName.value = `${studioSlug(props.model.name)}_${studioSlug(props.version.label)}.${nativeExt.value}`;
  format.value = nativeExt.value;
  error.value = '';
}, { immediate: true });
watch(() => [projectId.value, projects.value], () => {
  const project = projects.value.find((item) => item.id === projectId.value);
  
  repoKey.value = project?.defaultRepoKey || project?.repos[0]?.key || '';
});
watch(() => [projectId.value, repoKey.value, props.folders], () => {
  folder.value = props.folders?.[projectId.value]?.[repoKey.value] || '';
}, { immediate: true });
onMounted(async () => {
  try {
    const list = await projectsApi.list();
    
    if (alive) {
      projects.value = list.filter((item) => !item.archivedAt);
    }
  } catch (cause) {
    if (alive) {
      error.value = `Не удалось загрузить проекты: ${studioErrorMessage(cause)}`;
    }
  } finally {
    if (alive) {
      projectsLoading.value = false;
    }
  }
});
onUnmounted(() => {
  alive = false;
});

/**
 * Каждое подтверждение замены привязано к SHA показанного сервером файла.
 * Новая чужая правка требует нового вопроса; смена формы отзывает ожидающее действие.
 */
async function save(): Promise<void> {
  if (busy.value || !source.value || format.value !== nativeExt.value) {
    return;
  }
  
  const marker = fingerprint.value;
  const model = props.model.id;
  const version = props.version.id;
  const input: Record<string, unknown> = {
    projectId: projectId.value,
    repoKey: repoKey.value,
    folder: folder.value,
    fileName: fileName.value
  };
  
  busy.value = true;
  error.value = '';
  
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (!alive || fingerprint.value !== marker) {
        return;
      }
      
      try {
        const result = await store.save(model, version, input);
        
        if (alive && fingerprint.value === marker) {
          emit('saved', result.path);
          emit('close');
        }
        
        return;
      } catch (cause) {
        const failure = cause as {
          status?: number;
          code?: string;
          body?: { sha256?: string }
        };
        
        if (failure.status !== 409 || !['exists', 'changed'].includes(failure.code || '')
          || !/^[a-f0-9]{64}$/i.test(failure.body?.sha256 || '')) {
            throw cause;
          }
        if (!alive || fingerprint.value !== marker) {
          return;
        }
        
        const prefix = failure.code === 'changed' ? 'Файл изменился после подтверждения. ' : '';
        const accepted = await confirmDialog(`${prefix}Заменить ${folder.value}/${fileName.value}?\n`
          + `SHA-256: ${failure.body!.sha256}`);
        
        if (!accepted || !alive || fingerprint.value !== marker) {
          return;
        }
        
        input.overwrite = true;
        input.expectedSha256 = failure.body!.sha256;
      }
    }
    
    throw new Error('Файл продолжает меняться. Повторите сохранение после завершения чужой записи.');
  } catch (cause) {
    if (alive && fingerprint.value === marker) {
      error.value = studioErrorMessage(cause);
    }
  } finally {
    if (alive) {
      busy.value = false;
    }
  }
}
</script>

<style scoped>
.studio-save-fields,
.studio-save-destination {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.studio-save-hint,
.studio-save-destination > span {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
}

.studio-save-destination {
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  overflow-wrap: anywhere;
}
</style>
