<template>
  <UiDialog :open="open" title="Переименовать модель" :busy="busy" @close="$emit('close')">
    <UiField label="Имя"><UiInput v-model="name" :maxlength="200" :disabled="busy"
      data-context="studio-model-name" /></UiField>
    <UiField label="Категория"><UiSelect v-model="category" :disabled="busy"
      data-context="studio-model-category">
      <option value="">Без категории</option>
      <option value="character">Персонаж</option>
      <option value="prop">Предмет</option>
      <option value="part">Часть</option>
      <option value="scene">Сцена</option>
    </UiSelect></UiField>
    <UiField label="Проект"><UiSelect v-model="project" :disabled="busy"
      data-context="studio-model-project">
      <option value="">Без проекта</option>
      <option v-for="item in projects" :key="item.id" :value="item.id">{{ item.title }}</option>
    </UiSelect></UiField>
    <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="$emit('close')">Отмена</UiButton>
      <UiButton :disabled="!name.trim() || busy" :loading="busy" data-context="studio-model-save"
        @click="save">Сохранить</UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue';
import { UiDialog, UiField, UiInput, UiSelect, UiInlineMessage, UiButton } from '../../ui.ts';
import { projectsApi } from '../../shared/projectsApi.ts';
import { useStudio3dStore } from '../../stores/studio3d.ts';
import type { ProjectSummary } from '../../../../shared/runtime/projectsContracts.ts';
import { studioErrorMessage } from '../../features/studio3d/presentation.ts';

interface EditableModel {
  id: string;
  name: string;
  category: string | null;
  project: string | null;
}

const props = defineProps<{
  open: boolean;
  model: EditableModel
}>();
const emit = defineEmits<{ close: [] }>();
const store = useStudio3dStore();
const name = ref('');
const category = ref('');
const project = ref('');
const projects = ref<ProjectSummary[]>([]);
const busy = ref(false);
const error = ref('');
const marker = computed(() => `${store.libraryId}:${props.model.id}:${props.open}`);
let alive = true;

onUnmounted(() => {
  alive = false;
});

watch(marker, async () => {
  name.value = props.model.name;
  category.value = props.model.category ?? '';
  project.value = props.model.project ?? '';
  error.value = '';
  busy.value = false;

  if (!props.open) {
    return;
  }

  const current = marker.value;

  try {
    const list = await projectsApi.list();

    if (alive && current === marker.value) {
      projects.value = list.filter((item) => !item.archivedAt);
    }
  } catch {
    if (alive && current === marker.value) {
      error.value = 'Не удалось загрузить список проектов.';
    }
  }
}, { immediate: true });

/**
 * Сохраняются только имя, категория и проект выбранной модели, без правки её версий.
 * Смена библиотеки или закрытие диалога отзывает поздний ответ и его сообщение.
 */
async function save(): Promise<void> {
  if (busy.value || !name.value.trim()) {
    return;
  }

  const current = marker.value;

  busy.value = true;
  error.value = '';

  try {
    await store.patchModel(props.model.id, {
      name: name.value.trim(),
      category: category.value || null,
      project: project.value || null
    });

    if (alive && current === marker.value) {
      emit('close');
    }
  } catch (cause) {
    if (alive && current === marker.value) {
      error.value = studioErrorMessage(cause);
    }
  } finally {
    if (alive && current === marker.value) {
      busy.value = false;
    }
  }
}
</script>
