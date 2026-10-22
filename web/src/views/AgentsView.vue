<template>
  <div class="agents-page ui-page ui-workspace" data-ui-workspace
       :class="{ 'has-editor': mobileEditor && form }">
    <aside class="catalog" aria-label="Библиотека агентов">
      <UiPaneHeader>
        <template #title><h1>Агенты</h1></template>
        <template #meta>{{ agents.length }}</template>
        <template #actions>
          <UiButton variant="ghost" data-context="workspace-toolbar" :disabled="busy"
                    aria-label="Новый агент" @click="createNew">+ Новый</UiButton>
        </template>
      </UiPaneHeader>

      <div class="catalog-scroll">
        <div class="catalog-tools">
          <UiSearchInput v-model="search" aria-label="Поиск агентов" placeholder="Название или ID…" />
          <UiButton v-if="form" class="agent-resume" variant="text" data-context="workspace-form"
                    @click="mobileEditor = true">
            {{ isNew ? 'Продолжить создание' : 'Вернуться к агенту' }}
          </UiButton>
        </div>
        <div v-if="error" class="catalog-message">
          <UiInlineMessage tone="danger">{{ error }}</UiInlineMessage>
          <UiButton variant="text" data-context="workspace-form" :disabled="busy || loading"
                    @click="load">Повторить загрузку</UiButton>
        </div>
        <p v-if="loading && !agents.length" class="catalog-message muted" role="status">Загрузка агентов…</p>
        <div v-else-if="!agents.length && !error" class="catalog-message empty-list">
          <strong>Агентов пока нет</strong>
          <p>Создайте свою роль или установите стандартный набор ниже.</p>
        </div>
        <div v-else-if="agents.length && !groups.length" class="catalog-message empty-list" role="status">
          <strong>Ничего не найдено</strong>
          <p>Попробуйте другое название или ID.</p>
          <UiButton variant="text" data-context="workspace-form" @click="search = ''">Сбросить поиск</UiButton>
        </div>
        <div v-for="group in groups" :key="group.v" class="agent-group">
          <h2 class="group-title">{{ group.label }} <span>{{ group.items.length }}</span></h2>
          <UiButton v-for="agent in group.items" :key="agent.id" variant="ghost"
                       data-context="workspace-catalog-row" :data-agent-id="agent.id"
                       :pressed="agent.id === selectedId && !isNew"
                       :disabled="busy" @click="select(agent.id)">
            <span class="agent-row-content">
              <span class="agent-name">{{ agent.label || agent.id }}</span>
              <span class="agent-id mono">{{ agent.id }}</span>
              <span v-if="(agent.tier || agent.effort) && !['human', 'code'].includes(agent.kind)"
                    class="agent-advice" v-tooltip="adviceTitle(agent)">
                {{ [tierLabel[agent.tier] || agent.tier, agent.effort].filter(Boolean).join(' · ') }}
              </span>
            </span>
          </UiButton>
        </div>
      </div>

      <div class="catalog-footer">
        <UiButton variant="outline" data-context="workspace-form" :loading="installing"
                  :disabled="busy && !installing" loading-label="Установка набора…" @click="install">
          Стандартный набор
        </UiButton>
        <p class="muted">Добавляет готовые роли. Ваши правки сохраняются.</p>
        <p v-if="installNotice" :class="installNotice.startsWith('Ошибка') ? 'bad' : 'good'"
           :role="installNotice.startsWith('Ошибка') ? 'alert' : 'status'">{{ installNotice }}</p>
      </div>
    </aside>

    <section v-if="form" class="editor" aria-label="Редактор агента">
      <UiPaneHeader class="agent-header" inset="content">
        <template #navigation>
          <UiButton class="agent-back" variant="ghost" data-context="workspace-toolbar"
                    @click="mobileEditor = false">← Агенты</UiButton>
        </template>
        <template #title><h2>{{ isNew ? 'Новый агент' : original?.label || selectedId }}</h2></template>
        <template #meta><span v-if="dirty">Не сохранён</span></template>
        <template v-if="!isNew" #actions>
          <UiButton variant="ghost" tone="danger" data-context="workspace-toolbar"
                    :disabled="busy" @click="del">Удалить</UiButton>
        </template>
      </UiPaneHeader>

      <form class="agent-form" @submit.prevent="save">
        <div class="form-scroll">
          <p class="library-note">
            Здесь хранятся шаблоны ролей для конвейера. Инструкцию и рекомендации переносят
            в маршрут проекта. Изменения агента сохраняются только в библиотеке.
          </p>
          <fieldset class="agent-fields" :disabled="busy">
            <div class="basic-fields">
              <UiField label="Название агента" :help="help.label">
                <UiInput v-model="form.label" placeholder="Например, Разведка" />
              </UiField>
              <UiField label="Тип роли" :help="help.kind">
                <UiSelect v-model="form.kind">
                  <option v-if="!kinds.some(kind => kind.v === form?.kind)" :value="form.kind">
                    {{ form.kind }}
                  </option>
                  <option v-for="kind in kinds" :key="kind.v" :value="kind.v">{{ kind.label }}</option>
                </UiSelect>
              </UiField>
            </div>
            <UiField v-if="isNew" label="ID агента" :help="help.id"
                     hint="До 41 символа: строчные латинские буквы, цифры, дефис и подчёркивание. После создания ID не меняется.">
              <UiInput v-model.trim="form.id" class="mono" placeholder="Например, code_review"
                       required pattern="[a-z0-9](?:[a-z0-9_]|-){0,40}" maxlength="41" spellcheck="false" />
            </UiField>
            <UiField label="Инструкция роли" :help="help.prompt"
                     :hint="form.kind === 'human'
                       ? 'Для решения человека инструкция необязательна: опишите, что нужно проверить.'
                       : form.kind === 'code'
                         ? 'Опишите назначение команды и ожидаемый результат. Сам запуск настраивают в маршруте.'
                         : 'Опишите задачу роли, порядок работы и ожидаемый результат.'">
              <UiTextarea v-model="form.prompt" data-context="workspace-instruction" rows="12"
                          spellcheck="false" placeholder="Что нужно сделать и как проверить результат…" />
            </UiField>

            <section v-show="!['human', 'code'].includes(form.kind)" class="recommendations"
                     aria-label="Рекомендации автору маршрута">
              <h3>Рекомендации автору маршрута</h3>
              <p class="section-help">Конкретную модель и параметры запуска выбирают в проекте.</p>
              <div class="recommendation-fields">
                <UiField label="Класс модели" :help="help.tier">
                  <UiSelect v-model="form.tier">
                    <option value="">Без рекомендации</option>
                    <option v-if="form.tier && !tiers.some(tier => tier.v === form?.tier)" :value="form.tier">
                      {{ form.tier }}
                    </option>
                    <option v-for="tier in tiers" :key="tier.v" :value="tier.v">{{ tier.label }}</option>
                  </UiSelect>
                </UiField>
                <UiField label="Глубина рассуждений" :help="help.effort">
                  <UiSelect v-model="form.effort">
                    <option value="">Без рекомендации</option>
                    <option v-if="form.effort && !efforts.includes(form.effort)" :value="form.effort">
                      {{ form.effort }}
                    </option>
                    <option v-for="effort in efforts" :key="effort" :value="effort">{{ effort }}</option>
                  </UiSelect>
                </UiField>
              </div>
            </section>

            <details class="technical" :open="pro" @toggle="pro = ($event.target as HTMLDetailsElement).open">
              <summary>Технические параметры</summary>
              <div class="technical-fields">
                <UiField v-if="!isNew" label="ID агента" :help="help.id">
                  <UiInput :model-value="selectedId" class="mono" readonly />
                </UiField>
                <UiField label="Примечание к роли" :help="help.sub">
                  <UiInput v-model="form.sub" placeholder="Например, lint · tests" />
                </UiField>
                <UiField label="Ключ запуска" :help="help.key">
                  <UiInput v-model="form.key" class="mono" placeholder="Например, SCOUT" spellcheck="false" />
                </UiField>
                <UiField label="Время на этап, сек" :help="help.timeout" hint="0 — без рекомендации">
                  <UiNumberInput :model-value="form.timeout" :min="0" :step="60"
                                 @update:model-value="form.timeout = typeof $event === 'number' ? $event : 0" />
                </UiField>
                <UiField label="Бюджет работы" :help="help.budget" hint="0 — без рекомендации">
                  <UiNumberInput :model-value="form.budget" :min="0"
                                 @update:model-value="form.budget = typeof $event === 'number' ? $event : 0" />
                </UiField>
              </div>
              <div class="role-flags" data-context="workspace-form">
                <UiCheckbox v-model="form.readonly">Только чтение репозитория</UiCheckbox>
                <UiCheckbox v-model="form.optional">Этап можно пропустить</UiCheckbox>
              </div>
              <p class="section-help">{{ help.flags }}</p>
            </details>
          </fieldset>
        </div>

        <footer class="editor-footer">
          <div class="save-state" :class="{ bad: notice.startsWith('Ошибка'), good: notice === 'Сохранено' }"
               :role="notice.startsWith('Ошибка') ? 'alert' : 'status'">
            {{ notice || (dirty ? 'Есть несохранённые изменения' : 'Все изменения сохранены') }}
          </div>
          <div class="footer-actions">
            <UiButton variant="ghost" data-context="workspace-form" :disabled="!dirty || busy"
                      @click="cancelChanges">Отменить</UiButton>
            <UiButton type="submit" tone="accent" data-context="workspace-form" :loading="saving"
                      :disabled="!dirty || busy || (isNew && !form.id)" loading-label="Сохранение…">
              {{ isNew ? 'Создать агента' : 'Сохранить' }}
            </UiButton>
          </div>
        </footer>
      </form>
    </section>

    <section v-else class="editor empty-editor">
      <h2>{{ loading ? 'Загрузка библиотеки' : 'Выберите агента' }}</h2>
      <p>Здесь можно подготовить инструкцию роли для маршрутов конвейера.</p>
      <UiButton variant="outline" data-context="workspace-form" :disabled="busy"
                @click="createNew">Создать агента</UiButton>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';

import type { AgentCard } from '../../../shared/pipeline/agentsContracts.ts';
import { agentsApi } from '../shared/agentsApi.ts';
import { failureText } from '../shared/apiClient.ts';
import {
  UiButton,
  UiCheckbox,
  UiField,
  UiInlineMessage,
  UiPaneHeader,
  UiSearchInput,
  UiInput,
  UiNumberInput,
  UiSelect,
  UiTextarea,
  confirmDialog,
  vTooltip,
} from '../ui';
import { useUiContextSource } from '../composables/useUiContextSource.ts';

// База агентов (ролей конвейера): слева список, справа редактор карточки.
// Агент — заготовка роли: метаданные + начало задания. Ни одно поле не исполняется:
// боевой промпт этапа живёт в маршруте профиля (routes/<маршрут>/prompts/), модель и
// лимиты — в runners.env. Отсюда текст переносят в маршрут, а не наоборот.
// Тексты подсказок пишем в этой логике: сначала что это для человека, потом где лежит
// боевое значение — иначе раздел читается как настройки запуска, которыми он не является.
// Основные поля видны сразу; технические рекомендации раскрываются отдельно.
// Все изменения применяются к библиотеке только после явного сохранения.

// Черновик карточки: та же форма, что у сохранённой. Отдельного типа для нового
// агента не нужно — создание от правки отличает адрес запроса, а не форма тела.
type AgentForm = AgentCard;

const PRO_KEY = 'grigdesk-agents-pro';

const agents = ref<AgentCard[]>([]);
const loading = ref(false);
const error = ref('');
const selectedId = ref('');
const search = ref('');
// Редактируемая копия: правка карточки не должна менять список до сохранения.
const form = ref<AgentForm | null>(null);
// Режим создания: у нового агента ещё нет id, и удалять его нечего.
const isNew = ref(false);
const mobileEditor = ref(false);
const saving = ref(false);
const deleting = ref(false);
const notice = ref('');
// Идёт установка стандартного набора; её итог показывается в шапке списка.
const installing = ref(false);
const installNotice = ref('');
const pro = ref(localStorage.getItem(PRO_KEY) === '1');
// Ступени усилия приходят из реестра исполнителей: перечислять их здесь нельзя —
// новая ступень CLI тогда просто пропала бы из выбора.
const efforts = ref<string[]>([]);

const agentsContext = useUiContextSource('agents', { layer: 'page', active: false });

watch(selectedId, (agentId) => {
  if (agentId) {
    agentsContext.focus({ details: { agentId } });
  } else {
    agentsContext.blur();
  }
}, { immediate: true });

watch(pro, (value) => localStorage.setItem(PRO_KEY, value ? '1' : '0'));

const kinds = [
  { v: 'agent', label: 'Агент ИИ' },
  { v: 'human', label: 'Решение человека' },
  { v: 'code', label: 'Команда проекта' },
];

// Класс модели, а не семейство: база агентов общая для всех проектов, а проекты
// живут на разных исполнителях. Какое семейство закрывает класс — дело runners.env.
const tiers = [
  { v: 'reasoning', label: 'Рассуждающая — сложный анализ' },
  { v: 'balanced', label: 'Сбалансированная — рутина по спецификации' },
  { v: 'cheap', label: 'Экономная — механика и проверки' },
];

// Короткая подпись класса: до тире — название, после — пояснение для селекта.
const tierLabel: Record<string, string> = Object.fromEntries(
  tiers.map((tier) => [tier.v, tier.label.split(' — ')[0] ?? tier.label]),
);

// Описания настроек для тултипов — языком человека, не движка.
const help = {
  id: 'Уникальное техническое имя агента в библиотеке, например code_review.'
    + ' Используется в имени файла. Начните с буквы или цифры; после создания ID не меняется.',
  label: 'Название роли в библиотеке и заготовке этапа. Например, «Разведка» или «Проверка кода».',
  kind: 'Агент ИИ выполняет инструкцию, команда проекта запускает проверку или сборку,'
    + ' решение человека ждёт одобрения или отказа. Здесь задаётся тип шаблона роли.',
  tier: 'Рассуждающая — для сложного анализа, сбалансированная — для работы по готовому плану,'
    + ' экономная — для механических проверок. Это рекомендация: конкретную модель выбирают в проекте.',
  effort: 'Рекомендация, сколько усилий модель должна тратить на обдумывание (effort).'
    + ' Доступные значения приходят из реестра исполнителей. Фактический уровень задают в проекте.',
  sub: 'Короткое уточнение под названием блока на схеме. Например, «lint · tests».',
  key: 'Предлагаемый ключ результата этапа, например SCOUT. При сборке маршрута его указывают'
    + ' в ключе запуска этапа (runKey), под которым движок хранит результат.',
  timeout: 'Рекомендуемое время на этап в секундах. 0 — без рекомендации.'
    + ' Фактическое ограничение задаётся в опубликованном маршруте.',
  budget: 'Числовая пометка об объёме работы для автора маршрута. 0 — без рекомендации.'
    + ' В маршруте бюджет выбирают отдельно по именованному классу, например standard или large.',
  flags: 'Это рекомендации. Права на запись и возможность пропуска задаются отдельно в маршруте.',
  prompt: 'Шаблон задания для роли. Опишите, что нужно сделать и какой результат подготовить.'
    + ' Текст переносят в инструкцию этапа маршрута; правки здесь не обновляют существующие маршруты.'
    + ' Данные задачи и отчёты предыдущих этапов движок добавляет отдельно.',
};

const groups = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  const visible = agents.value.filter((agent) => (
    `${agent.label} ${agent.id}`.toLocaleLowerCase().includes(query)
  ));
  const unknownKinds = [...new Set(visible.map((agent) => agent.kind))]
    .filter((kind) => !kinds.some((known) => known.v === kind));

  return [...kinds, ...unknownKinds.map((kind) => ({ v: kind, label: kind || 'Другие роли' }))]
    .map((kind) => ({ ...kind, items: visible.filter((agent) => agent.kind === kind.v) }))
    .filter((group) => group.items.length);
});

const busy = computed(() => saving.value || deleting.value || installing.value);

const original = computed(() => (
  agents.value.find((agent) => agent.id === selectedId.value) || null
));

const dirty = computed(() => {
  if (isNew.value) {
    return true;
  }
  if (!form.value || !original.value) {
    return false;
  }

  return JSON.stringify(form.value) !== JSON.stringify(original.value);
});

/**
 * Объясняет краткие рекомендации в строке каталога, чтобы класс и effort
 * не воспринимались как фактические параметры запуска этапа.
 */
function adviceTitle(agent: AgentCard): string {
  const parts: string[] = [];

  if (agent.tier) {
    parts.push(`модель класса «${tierLabel[agent.tier] || agent.tier}»`);
  }
  if (agent.effort) {
    parts.push(`effort ${agent.effort}`);
  }

  return `Рекомендация автору маршрута: ${parts.join(', ')}. Параметры запуска задаются в проекте.`;
}

/** Копия карточки для правки: список не должен меняться до сохранения. */
function editableCopy(agent: AgentCard): AgentForm {
  return { ...agent };
}

/**
 * Читает список и, если ничего не выбрано, открывает первую карточку. Реестр моделей
 * тянется отдельно и молча: его недоступность не должна мешать правке агента.
 */
async function load(): Promise<void> {
  loading.value = true;
  error.value = '';

  try {
    agents.value = await agentsApi.list();

    const first = agents.value[0];

    if (!selectedId.value && !isNew.value && first) {
      selectedId.value = first.id;
      form.value = editableCopy(first);
    }
  } catch (failure) {
    error.value = failureText(failure);
  } finally {
    loading.value = false;
  }

  try {
    efforts.value = await agentsApi.efforts();
  } catch {
    // Реестр исполнителей недоступен — селект усилий останется пустым.
  }
}

/**
 * Открывает карточку в редакторе. Несохранённая правка не теряется молча: человека
 * спрашивают, и отказ оставляет его на прежней карточке.
 */
async function select(id: string): Promise<void> {
  if (busy.value) {
    return;
  }

  if (selectedId.value === id && form.value && !isNew.value) {
    mobileEditor.value = true;

    return;
  }

  const agent = agents.value.find((item) => item.id === id);

  if (!agent) {
    return;
  }

  const dropChanges = !dirty.value
    || await confirmDialog('Есть несохранённые изменения. Отменить их и продолжить?', {
      okText: 'Отменить изменения',
    });

  if (!dropChanges) {
    return;
  }

  selectedId.value = id;
  isNew.value = false;
  notice.value = '';
  form.value = editableCopy(agent);
  mobileEditor.value = true;
}

/**
 * Пустая карточка нового агента. Значения полей совпадают с серверными умолчаниями:
 * иначе создание молча меняло бы то, чего человек не заполнял.
 */
async function createNew(): Promise<void> {
  if (busy.value) {
    return;
  }

  const dropChanges = !dirty.value
    || await confirmDialog('Есть несохранённые изменения. Отменить их и продолжить?', {
      okText: 'Отменить изменения',
    });

  if (!dropChanges) {
    return;
  }

  selectedId.value = '';
  isNew.value = true;
  mobileEditor.value = true;
  notice.value = '';
  form.value = {
    id: '',
    kind: 'agent',
    label: '',
    sub: '',
    key: '',
    tier: '',
    effort: '',
    timeout: 0,
    budget: 0,
    readonly: false,
    optional: false,
    prompt: '',
  };
}

/**
 * Возвращает загруженную карточку без сетевой записи. Новый несохранённый агент
 * закрывается; библиотека и применённые ранее изменения остаются нетронутыми.
 */
function cancelChanges(): void {
  if (busy.value) {
    return;
  }

  notice.value = '';

  if (isNew.value) {
    isNew.value = false;
    selectedId.value = agents.value[0]?.id || '';
    form.value = agents.value[0] ? editableCopy(agents.value[0]) : null;
    mobileEditor.value = false;
  } else if (original.value) {
    form.value = editableCopy(original.value);
  }
}

/**
 * Принимает нормализованную карточку из ответа записи и перечитывает список.
 * Если перечитывание не удалось, подтверждённая запись не откатывается старым снимком.
 */
async function save(): Promise<void> {
  const draft = form.value;

  if (!draft || !dirty.value || busy.value) {
    return;
  }

  saving.value = true;
  notice.value = '';

  try {
    const saved = isNew.value
      ? await agentsApi.create(draft)
      : await agentsApi.update(selectedId.value, draft);

    isNew.value = false;
    selectedId.value = saved.id;
    form.value = editableCopy(saved);
    agents.value = agents.value.some((agent) => agent.id === saved.id)
      ? agents.value.map((agent) => agent.id === saved.id ? saved : agent)
      : [...agents.value, saved];

    await load();

    const current = agents.value.find((agent) => agent.id === selectedId.value);

    if (current) {
      form.value = editableCopy(current);
    }

    notice.value = 'Сохранено';
    setTimeout(() => {
      notice.value = '';
    }, 2000);
  } catch (failure) {
    notice.value = `Ошибка: ${failureText(failure)}`;
  } finally {
    saving.value = false;
  }
}

/**
 * Удаление карточки. У несозданного агента удалять нечего: пока он не сохранён,
 * на сервере его нет вовсе, и запрос отправился бы в никуда.
 */
async function del(): Promise<void> {
  if (busy.value) {
    return;
  }

  if (!selectedId.value || isNew.value) {
    return;
  }

  const title = form.value?.label || selectedId.value;
  const confirmed = await confirmDialog(`Удалить агента «${title}»?`, {
    danger: true,
    okText: 'Удалить',
  });

  if (!confirmed) {
    return;
  }

  deleting.value = true;

  try {
    await agentsApi.remove(selectedId.value);
    selectedId.value = '';
    form.value = null;
    await load();
  } catch (failure) {
    notice.value = `Ошибка: ${failureText(failure)}`;
  } finally {
    deleting.value = false;
  }
}

/**
 * Доустановка отсутствующих агентов из стандартного набора (server/seed/agents).
 * Create-only: свои правки и одноимённые агенты не перезаписываются, жать можно смело.
 */
async function install(): Promise<void> {
  if (busy.value) {
    return;
  }

  installing.value = true;
  installNotice.value = '';

  try {
    const result = await agentsApi.install();

    await load();
    installNotice.value = result.created?.length
      ? `Установлено агентов: ${result.created.length}`
      : 'Все агенты набора уже есть';
    setTimeout(() => {
      installNotice.value = '';
    }, 4000);
  } catch (failure) {
    installNotice.value = `Ошибка: ${failureText(failure)}`;
  } finally {
    installing.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.agents-page {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  container: agents / inline-size;
}

.catalog, .editor {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.catalog {
  background: var(--sidebar);
  border-right: 1px solid var(--line);
}

.catalog-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-bottom: 12px;
}

.catalog-tools {
  display: grid;
  gap: 8px;
  padding: 12px;
}

.catalog-message { margin: 0; padding: 0 12px 12px; }
.empty-list { display: grid; gap: 6px; color: var(--ink-mid); }
.empty-list p { margin: 0; }
.agent-group { padding: 0 6px 8px; }
.group-title {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  padding: 6px;
  color: var(--ink-mid);
  font-size: 12px;
  font-weight: 400;
  overflow-wrap: anywhere;
}

.agent-row-content { display: grid; gap: 1px; width: 100%; min-width: 0; }
.agent-name { min-width: 0; overflow-wrap: anywhere; }
.agent-id, .agent-advice {
  min-width: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

.catalog-footer {
  flex: none;
  display: grid;
  gap: 6px;
  padding: 12px;
  border-top: 1px solid var(--line);
}

.catalog-footer p { margin: 0; font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.agent-form { display: flex; flex: 1; flex-direction: column; min-height: 0; }
.form-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 20px 24px; }
.library-note { max-width: 84ch; margin: 0 0 16px; color: var(--ink-mid); }
.agent-fields { display: grid; gap: 16px; min-width: 0; margin: 0; padding: 0; border: 0; }
.basic-fields { display: grid; grid-template-columns: minmax(0, 1fr) 220px; gap: 12px; }
.recommendation-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.recommendations h3 { margin: 0; font-size: 13px; font-weight: 600; }
.section-help { margin: 4px 0 8px; color: var(--ink-mid); font-size: 12px; line-height: 18px; }
.technical { min-width: 0; border-top: 1px solid var(--line); padding-top: 8px; }
.technical summary { min-height: var(--control-height); align-content: center; cursor: pointer; }
.technical-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; padding-top: 8px; }
.role-flags { display: flex; flex-wrap: wrap; gap: 12px 20px; margin-top: 16px; }
.editor-footer {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding: 10px 20px;
  border-top: 1px solid var(--line);
  background: var(--surface);
}

.save-state { min-width: 0; font-size: 12px; color: var(--ink-mid); overflow-wrap: anywhere; }
.footer-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.empty-editor { align-items: center; justify-content: center; gap: 12px; padding: 20px; text-align: center; }
.empty-editor h2 { margin: 0; font-size: 13px; font-weight: 600; }
.empty-editor p { max-width: 45ch; margin: 0; color: var(--ink-mid); }
.bad { color: var(--bad); }
.good { color: var(--good); }
.muted { color: var(--ink-mid); }

/* Панели скрываются без размонтирования: поиск и локальный ввод переживают возврат.
   Размер контейнера учитывает и узкую область внутри широкого окна. */
.agent-back, .agent-resume { display: none; }
.agent-header :deep(.ui-pane-header__navigation) { display: none; }
@container agents (max-width: 900px) {
  .catalog, .editor { grid-column: 1 / -1; grid-row: 1; }
  .catalog { border-right: 0; }
  .has-editor > .catalog, .agents-page:not(.has-editor) > .editor { display: none; }
  .agent-back, .agent-resume { display: inline-flex; }
  .agent-header :deep(.ui-pane-header__navigation) { display: flex; }
}

/* Шапка, форма и footer используют одну ось на узком экране. */
.editor { background: var(--surface); container: agent-editor / inline-size; }
@container agent-editor (max-width: 600px) {
  .basic-fields, .recommendation-fields, .technical-fields { grid-template-columns: minmax(0, 1fr); }
}

@container agent-editor (max-width: 480px) {
  .form-scroll { padding: 12px 12px 20px; }
  .editor-footer { padding: 10px 12px; }
}
</style>
