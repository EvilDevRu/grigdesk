<template>
  <section class="studio-library">
    <header class="studio-library-heading">
      <div>
        <h3>Модели</h3>
        <p>Ваша библиотека и все версии в одном месте.</p>
      </div>
      <UiButton tone="accent" variant="solid" @click="$emit('create')">Создать модель</UiButton>
    </header>
    <div class="studio-library-search">
    <UiSearchInput :model-value="store.query" placeholder="Поиск моделей" aria-label="Поиск моделей"
      @update:model-value="store.search($event)" />
      <UiButton :aria-expanded="filtersOpen" aria-controls="studio-library-filters"
        @click="filtersOpen = !filtersOpen">Фильтры{{ filterCount ? ` · ${filterCount}` : '' }}</UiButton>
    </div>
    <p v-if="filterCount && !filtersOpen" class="studio-library-count">{{ filterSummary }}</p>
    <div v-show="filtersOpen" id="studio-library-filters" class="studio-filters">
      <UiField label="Проект"><UiSelect :model-value="store.filters.project || ''"
        @update:model-value="filter('project', $event)">
        <option value="">Все</option><option v-for="item in projects" :key="item.id" :value="item.id">
          {{ item.title }}</option>
      </UiSelect></UiField>
      <UiField label="Категория"><UiSelect :model-value="store.filters.category || ''"
        @update:model-value="filter('category', $event)">
        <option value="">Все</option><option v-for="item in MODEL_CATEGORIES" :key="item.id" :value="item.id">
          {{ item.label }}</option>
      </UiSelect></UiField>
      <UiField label="Происхождение"><UiSelect data-context="studio-filter-origin"
        :model-value="store.filters.origin || ''" @update:model-value="filter('origin', $event)">
        <option value="">Все</option><option value="section">Раздел</option><option value="agent">Агент</option>
        <option value="file">Файл</option><option value="import">Импорт</option>
      </UiSelect></UiField>
      <UiField label="Исполнитель"><UiSelect :model-value="store.filters.provider || ''"
        @update:model-value="filter('provider', $event)">
        <option value="">Все</option><option v-for="item in store.state?.providers || []"
          :key="item.id" :value="item.id">{{ item.name }}</option>
      </UiSelect></UiField>
      <UiField label="Содержимое"><UiSelect :model-value="store.filters.has || ''"
        @update:model-value="filter('has', $event)">
        <option value="">Всё</option><option value="rig">Со скелетом</option>
        <option value="animation">С движениями</option><option value="parts">С частями</option>
      </UiSelect></UiField>
    </div>
    <UiInlineMessage v-if="error" tone="warning">{{ error }}</UiInlineMessage>
    <UiInlineMessage v-if="store.broken.length" tone="warning">
      Повреждённые записи: {{ store.broken.length }}
    </UiInlineMessage>
    <div v-if="!store.models.length && !store.busy" class="studio-library-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"
        stroke-linejoin="round" aria-hidden="true">
        <path d="M12 2l9 5v10l-9 5-9-5V7z M12 22V12 M21 7l-9 5-9-5" />
      </svg>
      <strong>{{ filtered ? 'Модели не найдены' : 'Здесь будут ваши модели' }}</strong>
      <p>{{ filtered ? 'Измените поиск или фильтры.' : 'Создайте первую модель или добавьте готовый файл.' }}</p>
      <UiButton v-if="!filtered" @click="$emit('create')">Создать модель</UiButton>
    </div>
    <p v-else class="studio-library-count">{{ store.busy ? 'Загрузка моделей…' : `Найдено: ${store.total}` }}</p>
    <div class="studio-model-grid">
      <UiPressable v-for="model in store.models" :key="model.id" data-context="studio-model-card"
        @click="$emit('open', model.id)">
        <div class="studio-model-preview">
          <img v-if="model.preview" :src="model.preview" :alt="model.name" loading="lazy" />
          <span v-else class="studio-preview-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width=".8"
              stroke-linejoin="round" aria-hidden="true">
              <path d="M12 2l9 5v10l-9 5-9-5V7z M12 22V12 M21 7l-9 5-9-5" />
            </svg>
            <span>Нет превью</span>
          </span>
          <span class="studio-model-category">{{ valueLabels[model.category || ''] || 'Модель' }}</span>
        </div>
        <div class="studio-model-caption">
          <strong>{{ model.name }}</strong>
          <span v-if="model.active" class="studio-model-working">В работе: {{ model.active }}</span>
          <span>{{ model.versions }} {{ pluralForm(model.versions,
            { one: 'версия', few: 'версии', many: 'версий' }) }}</span>
          <span>{{ [model.has.rig && 'скелет', model.has.animation && 'движения', model.has.parts && 'части',
            model.origin === 'agent' && 'агент'].filter(Boolean).join(' · ') }}</span>
          <span v-if="model.spent !== null">потрачено {{ model.spent }}</span>
          <span v-else v-for="spend in model.spending" :key="spend.provider">
            {{ providerLabel(spend.provider, store.state?.providers) }}:
            списано {{ formatPrice(spend.actual, spend.unit) }}
            <template v-if="spend.unknownCount"> · неизвестно {{ spend.unknownCount }}</template>
          </span>
          <time :datetime="model.updatedAt">{{ new Date(model.updatedAt).toLocaleDateString('ru-RU') }}</time>
        </div>
      </UiPressable>
    </div>
    <UiButton v-if="store.models.length < store.total" :loading="store.busy > 0"
      @click="store.loadModels(true)">Показать ещё</UiButton>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { UiSearchInput, UiSelect, UiField, UiPressable, UiButton, UiInlineMessage } from '../../ui.ts';
import { useStudio3dStore } from '../../stores/studio3d.ts';
import { projectsApi } from '../../shared/projectsApi.ts';
import type { ProjectSummary } from '../../../../shared/runtime/projectsContracts.ts';
import { MODEL_CATEGORIES } from '../../../../shared/studio3d/studio3dContracts.ts';
import { formatPrice, pluralForm } from '../../../../shared/studio3d/studio3dOperations.ts';
import {
  studioErrorMessage,
  providerLabel,
  valueLabels
} from '../../features/studio3d/presentation.ts';

defineEmits<{ open: [modelId: string]; create: [] }>();

const store = useStudio3dStore();
const projects = ref<ProjectSummary[]>([]);
const error = ref('');
const filtersOpen = ref(false);
const filterCount = computed(() => Object.values(store.filters).filter(Boolean).length);
const filterSummary = computed(() => Object.entries(store.filters).filter(([, value]) => value)
  .map(([key, value]) => key === 'project'
    ? projects.value.find((project) => project.id === value)?.title || value
    : valueLabels[value] || providerLabel(value, store.state?.providers)).join(' · '));
const filtered = computed(() => Boolean(store.query || Object.values(store.filters).some(Boolean)));
let alive = true;

/**
 * Фильтр меняет полный снимок поиска, а store отзывает прежнюю страницу по поколению.
 * Пустой пункт удаляет условие, чтобы оно не превращалось в строку undefined.
 */
function filter(key: string, raw: unknown): void {
  const value = typeof raw === 'string' ? raw : '';
  const next = { ...store.filters };
  
  if (value) {
    next[key] = value;
  }
  else {
    delete next[key];
  }
  
  store.filters = next;
  void store.loadModels();
}

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
  }
});
onUnmounted(() => {
  alive = false;
});
</script>

<style scoped>
.studio-library {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.studio-library-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.studio-library-heading h3 {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 600;
}

.studio-library-heading p,
.studio-library-empty p,
.studio-library-count {
  margin: 0;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.5;
}

.studio-filters {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 140px), 1fr));
  gap: 12px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--line);
}

.studio-library-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 48px 20px;
  text-align: center;
  border: 1px dashed var(--line-2);
  border-radius: var(--radius);
}

.studio-library-empty svg {
  width: 40px;
  height: 40px;
  margin-bottom: 4px;
  color: var(--accent);
}

.studio-model-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 210px), 1fr));
  gap: 16px;
}

.studio-model-preview {
  position: relative;
  display: grid;
  place-items: center;
  height: 170px;
  background: radial-gradient(ellipse at center, var(--surface-2), var(--ground));
}

.studio-model-preview img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.studio-preview-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  color: var(--ink-low);
  font-size: 11px;
}

.studio-preview-empty svg {
  width: 48px;
  height: 48px;
}

.studio-model-category {
  position: absolute;
  bottom: 10px;
  left: 12px;
  padding: 3px 7px;
  border-radius: 5px;
  background: var(--surface);
  color: var(--ink-mid);
  font-size: 11px;
}

.studio-model-caption {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 12px;
  overflow-wrap: anywhere;
}

.studio-model-caption > strong {
  font-size: 13px;
  font-weight: 600;
}

.studio-model-caption > span,
.studio-model-caption time {
  color: var(--ink-mid);
  font-size: 12px;
}

.studio-model-caption > span:empty {
  display: none;
}

.studio-model-caption > .studio-model-working {
  color: var(--accent);
}

.studio-model-caption time {
  margin-top: 4px;
  color: var(--ink-low);
  font-size: 11px;
}
.studio-library-search { display: flex; gap: 8px; align-items: center; }
.studio-library-search > :first-child { flex: 1; min-width: 0; }
@media (max-height: 500px) {
  .studio-library { gap: 8px; }
  .studio-library-heading p { display: none; }
  .studio-model-preview { height: 68px; aspect-ratio: auto; }
  .studio-model-caption { padding: 8px 12px; }
}
</style>
