<template>
  <div class="agents-page">
    <!-- Список -->
    <aside class="list">
      <div class="list-head">
        <span class="ttl">База агентов</span>
        <!-- На планшете ховера нет, а объяснение раздела длинное — его открывают явно. -->
        <UiPopover
          trigger-mode="both"
          focus-policy="none"
          placement="top-start"
          :style="{ maxWidth: '330px' }"
        >
          <template #trigger>
            <UiIconButton class="page-tip" role="embedded" label="О разделе">?</UiIconButton>
          </template>
          <span class="doc">
            <b class="doc-ttl">Библиотека ролей конвейера</b>
            <span v-for="(p, i) in helpPage" :key="i" class="doc-p">{{ p }}</span>
          </span>
        </UiPopover>
        <span class="grow"></span>
        <UiButton class="btn" :loading="installing"
                v-tooltip="'Доустановить отсутствующих агентов из стандартного набора. Существующие и ваши правки не перезаписываются'"
                loading-label="Устанавливаю набор" @click="install">⇩ Набор</UiButton>
        <UiButton class="btn accent" tone="accent" @click="createNew">+ Новый</UiButton>
      </div>
      <p class="list-sub">Заготовки ролей для схем конвейера. На запуск не влияют: боевой промпт и модель живут в маршруте проекта.</p>
      <p v-if="installNotice" class="list-sub" :class="{ bad: installNotice.startsWith('Ошибка') }">{{ installNotice }}</p>
      <div v-if="loading && !agents.length" class="pad muted"><UiSpinner decorative /> Загружаю…</div>
      <div v-else-if="error && !agents.length" class="pad bad">{{ error }}</div>
      <div v-else-if="!agents.length" class="pad empty-list">
        <p class="muted">Библиотека пуста. На свежей установке это нормально: наполнение агентов — данные машины и не едет с репозиторием.</p>
        <UiButton class="btn accent" tone="accent" :loading="installing"
                  loading-label="Устанавливаю набор" @click="install">Установить стандартный набор</UiButton>
      </div>
      <template v-for="g in groups" :key="g.v">
        <div class="grp-ttl">{{ g.label }}</div>
        <UiSelectableRow v-for="a in g.items" :key="a.id" class="item"
                         :selected="a.id === selectedId && !isNew" @select="select(a.id)">
          <span class="item-content">
            <span class="ic" :class="`k-${a.kind}`">{{ kindIcon[a.kind] }}</span>
            <span class="item-main">
              <span class="nm" v-tooltip="a.label || a.id">{{ a.label || a.id }}</span>
              <span v-if="a.tier || a.effort" class="advice" v-tooltip="adviceTitle(a)">
                <span v-if="a.tier" class="chip tier-chip">{{ tierLabel[a.tier] || a.tier }}</span>
                <span v-if="a.effort" class="chip effort-chip mono">{{ a.effort }}</span>
              </span>
            </span>
          </span>
        </UiSelectableRow>
      </template>
    </aside>

    <!-- Редактор -->
    <section v-if="form" class="editor">
      <header class="ehead">
        <template v-if="isNew">
          <UiInput v-model.trim="form.id" class="fld idfld mono" placeholder="id (латиница, напр. my_agent)" spellcheck="false" />
        </template>
        <template v-else>
          <span class="eid mono">{{ selectedId }}</span>
        </template>
        <span class="grow"></span>
        <span v-if="notice" class="notice" :class="{ bad: notice.startsWith('Ошибка') }">{{ notice }}</span>
        <UiSwitch v-model="pro"
                  v-tooltip="'Редкие поля роли: сноска под блоком, ключ в реестре задачи, таймаут, бюджет и флаги'" aria-description="Редкие поля роли: сноска под блоком, ключ в реестре задачи, таймаут, бюджет и флаги">профи</UiSwitch>
        <UiButton v-if="!isNew" class="btn danger" tone="danger" @click="del">Удалить</UiButton>
        <UiButton class="btn accent" tone="accent" :loading="saving"
                  :disabled="!dirty || (isNew && !form.id)" loading-label="Сохраняю" @click="save">Сохранить</UiButton>
      </header>

      <!-- Обычные настройки -->
      <div class="fields">
        <label class="f f-label">
          <span class="lbl">
            Подпись <UiTooltip :text="help.label" placement="top-start" />
          </span>
          <UiInput v-model="form.label" class="fld" placeholder="Название блока на схеме" />
        </label>
        <label class="f">
          <span class="lbl">Форма блока <UiTooltip :text="help.kind" /></span>
          <UiSelect v-model="form.kind" class="fld">
            <option v-for="k in kinds" :key="k.v" :value="k.v">{{ k.label }}</option>
          </UiSelect>
        </label>
        <label class="f">
          <span class="lbl">Класс модели <UiTooltip :text="help.tier" /></span>
          <UiSelect v-model="form.tier" class="fld">
            <option value="">без рекомендации</option>
            <option v-for="t in tiers" :key="t.v" :value="t.v">{{ t.label }}</option>
          </UiSelect>
        </label>
        <label class="f">
          <span class="lbl">Рекомендация effort <UiTooltip :text="help.effort" /></span>
          <UiSelect v-model="form.effort" class="fld">
            <option value="">без рекомендации</option>
            <option v-for="e in effortOptions" :key="e" :value="e">{{ e }}</option>
          </UiSelect>
        </label>
      </div>

      <!-- Профи-настройки -->
      <div v-if="pro" class="fields pro">
        <label class="f">
          <span class="lbl">
            Сноска <UiTooltip :text="help.sub" placement="top-start" />
          </span>
          <UiInput v-model="form.sub" class="fld" placeholder="под блоком (напр. lint · tests)" />
        </label>
        <label class="f">
          <span class="lbl">Ключ реестра <UiTooltip :text="help.key" /></span>
          <UiInput v-model="form.key" class="fld mono" placeholder="SCOUT" spellcheck="false" />
        </label>
        <label class="f">
          <span class="lbl">Таймаут, сек <UiTooltip :text="help.timeout" /></span>
          <UiNumberField :model-value="form.timeout" :min="0" :step="60" placeholder="0 = дефолт"
                         @update:model-value="form.timeout = typeof $event === 'number' ? $event : 0" />
        </label>
        <label class="f">
          <span class="lbl">Бюджет <UiTooltip :text="help.budget" /></span>
          <UiNumberField :model-value="form.budget" :min="0" placeholder="0 = нет"
                         @update:model-value="form.budget = typeof $event === 'number' ? $event : 0" />
        </label>
        <div class="f">
          <span class="lbl">Флаги <UiTooltip :text="help.flags" /></span>
          <div class="row">
            <UiToggleButton v-model="form.readonly" class="tag"
                    v-tooltip="'Советовать запрет записи в репозиторий: этап только смотрит и отчитывается'"
                    >read-only</UiToggleButton>
            <UiToggleButton v-model="form.optional" class="tag"
                    v-tooltip="'Советовать разрешить пропуск: конвейер идёт дальше, если этап нечего делать'"
                    >optional</UiToggleButton>
          </div>
        </div>
      </div>

      <div class="prompt-wrap">
        <div class="lbl prompt-lbl">
          Заготовка задания <UiTooltip :text="help.prompt" placement="top-start" />
          <span class="muted sm">
            — основа для промпта этапа; боевой текст живёт в маршруте проекта
          </span>
        </div>
        <UiTextarea v-model="form.prompt" class="prompt mono" spellcheck="false"
                    :placeholder="form.kind === 'human' ? 'У человеческого этапа задания нет — конвейер просто ждёт решения человека' : 'С чего начинается задание этапа…'" />
      </div>
    </section>

    <section v-else class="editor empty">
      <p class="muted">Выбери роль слева или заведи новую</p>
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
  UiIconButton,
  UiInput,
  UiNumberField,
  UiPopover,
  UiSelect,
  UiSelectableRow,
  UiSpinner,
  UiSwitch,
  UiTextarea,
  UiToggleButton,
  UiTooltip,
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
// Два уровня рекомендаций: обычные (подпись, форма, класс модели, промпт) и «Профи»
// (ключ реестра, сноска, таймаут, бюджет, флаги) — скрыты за тумблером.

// Черновик карточки: та же форма, что у сохранённой. Отдельного типа для нового
// агента не нужно — создание от правки отличает адрес запроса, а не форма тела.
type AgentForm = AgentCard;

const PRO_KEY = 'cockpit-agents-pro';

const agents = ref<AgentCard[]>([]);
const loading = ref(false);
const error = ref('');
const selectedId = ref('');
// Редактируемая копия: правка карточки не должна менять список до сохранения.
const form = ref<AgentForm | null>(null);
// Режим создания: у нового агента ещё нет id, и удалять его нечего.
const isNew = ref(false);
const saving = ref(false);
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
  { v: 'agent', label: '🤖 Агент' },
  { v: 'human', label: '👤 Человек' },
  { v: 'code', label: '</> Код' },
];

// Значок рода — свободный словарь: файл базы пишет человек, и незнакомый род должен
// доехать до списка без значка, а не исчезнуть вместе с карточкой.
const kindIcon: Record<string, string> = {
  agent: '🤖',
  human: '👤',
  code: '</>',
};

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
  label: 'Как этап будет подписан на схеме конвейера — текст внутри блока.'
    + ' Например «Разведка» или «Приёмка кода».',
  kind: 'Кто делает этап: 🤖 агент — работает ИИ; 👤 человек — конвейер останавливается'
    + ' и ждёт решения человека; </> код — выполняется команда на хосте. Здесь это'
    + ' заготовка для нового блока: у этапов уже собранной схемы форма задана самой схемой.',
  tier: 'Насколько сильная модель нужна этапу: рассуждающая — для сложного анализа,'
    + ' сбалансированная — для рутины по готовой спецификации, экономная — для механики'
    + ' и проверок. Конкретную модель (opus, sonnet…) здесь не выбирают: база агентов'
    + ' общая для всех проектов, а какой моделью закрыть класс — решает runners.env'
    + ' проекта. Это пометка человеку, который собирает маршрут; запуск её не читает.',
  effort: 'Сколько усилий модели тратить на обдумывание хода — пометка тому, кто собирает'
    + ' маршрут. На запуск не влияет: фактический effort этапа берётся из runners.env проекта.',
  sub: 'Мелкая приписка под названием блока на схеме — уточнение, чем этап занят'
    + ' (например «lint · tests»).',
  key: 'Короткое имя этапа в реестре задачи (runKey): под ним движок хранит результат'
    + ' этапа и показывает его в дашборде и логах. Здесь — предложение для нового узла;'
    + ' у собранной схемы ключ берётся из неё.',
  timeout: 'За сколько секунд этап должен уложиться — ориентир тому, кто собирает маршрут;'
    + ' 0 — без рекомендации. Боевой лимит принадлежит опубликованному маршруту, и агент'
    + ' узнаёт его из служебного «регламента времени» в конце промпта.',
  budget: 'Ориентир объёма работы этапа для автора маршрута; 0 — без рекомендации.'
    + ' В маршрутах бюджет задан именованным классом (standard, large), так что число'
    + ' отсюда никуда не едет.',
  flags: 'Две пометки для нового узла: read-only — этапу нельзя писать в репозиторий'
    + ' (только смотрит и отчитывается), optional — этап разрешено штатно пропустить.'
    + ' Настоящую файловую политику и допустимые исходы задаёт маршрут.',
  prompt: 'С чего начинается задание этапа. Это заготовка: боевой текст живёт в маршруте'
    + ' профиля (routes/<маршрут>/prompts/), туда его переносят отсюда — правка заготовки'
    + ' собранные маршруты не меняет. Данные задачи (номер, ветку, отчёты предыдущих'
    + ' этапов) движок подставляет сам отдельными блоками.',
};

// Что это за раздел вообще — главный вопрос к нему. Держим ответ в трёх абзацах:
// что здесь лежит, чего оно НЕ делает и зачем тогда нужно.
const helpPage = [
  'Агент здесь — описание роли конвейера: как этап подписан на схеме, какого класса'
    + ' модель ему нужна и с чего начинается его задание.',
  'Это библиотека, а не настройки запуска. Прогон задачи отсюда не читает ничего:'
    + ' боевой промпт этапа лежит в маршруте проекта, а модель, effort и лимиты —'
    + ' в runners.env профиля. Правка карточки не трогает ни собранные маршруты,'
    + ' ни бегущие задачи.',
  'Смысл — держать формулировку роли в одном месте: описать её один раз и переносить'
    + ' в маршруты проектов, а не выдумывать заново под каждый. Все поля карточки —'
    + ' рекомендации автору маршрута.',
];

const groups = computed(() => kinds
  .map((kind) => ({ ...kind, items: agents.value.filter((agent) => agent.kind === kind.v) }))
  .filter((group) => group.items.length));

const effortOptions = computed(() => efforts.value);

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
 * Подсказка к чипам списка. Чипы — рекомендации автору маршрута, а не то, чем этап
 * реально пойдёт: без этой оговорки они читаются как «вот на чём он запустится».
 */
function adviceTitle(agent: AgentCard): string {
  const parts: string[] = [];

  if (agent.tier) {
    parts.push(`модель класса «${tierLabel[agent.tier] || agent.tier}»`);
  }
  if (agent.effort) {
    parts.push(`effort ${agent.effort}`);
  }

  return `Рекомендация автору маршрута: ${parts.join(', ')}. На запуск не влияет —`
    + ' модель и effort берутся из runners.env проекта.';
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

    if (!selectedId.value && first) {
      await select(first.id);
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
  const agent = agents.value.find((item) => item.id === id);

  if (!agent) {
    return;
  }

  const dropChanges = !dirty.value
    || await confirmDialog('Есть несохранённые изменения — бросить?', { okText: 'Бросить' });

  if (!dropChanges) {
    return;
  }

  selectedId.value = id;
  isNew.value = false;
  notice.value = '';
  form.value = editableCopy(agent);
}

/**
 * Пустая карточка нового агента. Значения полей совпадают с серверными умолчаниями:
 * иначе создание молча меняло бы то, чего человек не заполнял.
 */
async function createNew(): Promise<void> {
  const dropChanges = !dirty.value
    || await confirmDialog('Есть несохранённые изменения — бросить?', { okText: 'Бросить' });

  if (!dropChanges) {
    return;
  }

  selectedId.value = '';
  isNew.value = true;
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
 * Сохраняет карточку и перечитывает список. Перечитывание обязательно: сервер
 * нормализует поля при записи, и оставленная форма разошлась бы с файлом на диске.
 */
async function save(): Promise<void> {
  const draft = form.value;

  if (!draft) {
    return;
  }

  saving.value = true;
  notice.value = '';

  try {
    if (isNew.value) {
      const created = await agentsApi.create(draft);

      isNew.value = false;
      selectedId.value = created.id;
    } else {
      await agentsApi.update(selectedId.value, draft);
    }

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

  try {
    await agentsApi.remove(selectedId.value);
    selectedId.value = '';
    form.value = null;
    await load();
  } catch (failure) {
    notice.value = `Ошибка: ${failureText(failure)}`;
  }
}

/**
 * Доустановка отсутствующих агентов из стандартного набора (server/seed/agents).
 * Create-only: свои правки и одноимённые агенты не перезаписываются, жать можно смело.
 */
async function install(): Promise<void> {
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
.agents-page { height: 100%; display: grid; grid-template-columns: 290px 1fr; min-height: 0; }

/* ── Список ── */
.list { border-right: 1px solid var(--line); background: var(--sidebar); overflow-y: auto; padding: 10px; }
.list-head { display: flex; align-items: center; gap: 7px; padding: 2px 4px 6px; }
.ttl { font-weight: 700; font-size: 13.5px; }
.page-tip { flex: none; }
/* Ответ на «что это вообще за раздел» виден без ховера: на планшете его иначе не прочитать */
.list-sub { margin: 0 4px 8px; font-size: 11px; line-height: 1.45; color: var(--ink-mid); }
/* Развёрнутое объяснение раздела внутри тултипа (он в body, но слот — из этого scope) */
.doc { display: flex; flex-direction: column; gap: 7px; }
.doc-ttl { font-size: 12.5px; }
.doc-p { display: block; }
.grp-ttl { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
  color: var(--ink-mid); padding: 10px 6px 4px; }
.item { width: 100%; margin-bottom: 4px; }
.item-content { display: grid; grid-template-columns: 20px minmax(0, 1fr); align-items: start; gap: 8px; width: 100%; min-width: 0; }
.item .ic { width: 20px; margin-top: 2px; font-size: 12px; text-align: center; }
.ic.k-code { color: var(--node-code); font-weight: 700; font-size: 10px; }
.item-main { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; width: 100%; }
.item .nm { display: block; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 18px; }
.advice { display: flex; align-items: center; gap: 4px; min-width: 0; max-width: 100%; margin-top: 2px; overflow: hidden; }
.chip { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px;
  line-height: 14px; color: var(--ink-mid); background: var(--surface-2); border: 1px solid var(--line);
  border-radius: 5px; padding: 0 5px; }
.tier-chip { flex: 0 1 auto; }
.effort-chip { flex: none; color: var(--accent); }
.pad { padding: 12px 8px; }
.empty-list { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; font-size: 12px; line-height: 1.45; }
.empty-list p { margin: 0; }

/* ── Редактор ── */
.editor { display: flex; flex-direction: column; min-width: 0; min-height: 0; padding: 14px 18px 18px; gap: 12px; }
.editor.empty { align-items: center; justify-content: center; }
.ehead { display: flex; align-items: center; gap: 10px; }
.eid { font-size: 14px; font-weight: 700; color: var(--node-code); }
.idfld { max-width: 280px; }
.grow { flex: 1; }
.notice { font-size: 12.5px; color: var(--good); }
.notice.bad { color: var(--bad); }

.fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px 14px; }
.fields.pro { padding: 12px; border: 1px dashed var(--line-2); border-radius: 10px; background: color-mix(in srgb, var(--surface) 55%, transparent); }
.f { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.f-label { grid-column: span 2; }
.lbl { font-size: 11px; font-weight: 600; color: var(--ink-mid); text-transform: uppercase; letter-spacing: .04em;
  display: inline-flex; align-items: center; gap: 5px; }
.fld { width: 100%; }

.row { display: flex; gap: 6px; flex-wrap: wrap; }
.tag { font-family: var(--mono); }

.prompt-wrap { flex: 1; display: flex; flex-direction: column; gap: 4px; min-height: 0; }
.prompt-lbl .sm { text-transform: none; letter-spacing: 0; font-weight: 400; font-size: 11px; }
.prompt { flex: 1; min-height: 180px; resize: none; line-height: 1.55; }

.bad { color: var(--bad); }
.sm { font-size: 11px; }

/* Планшет/узкий экран: список сверху, редактор ниже */
@media (max-width: 820px) {
  .agents-page { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  .list { border-right: none; border-bottom: 1px solid var(--line); max-height: 38vh; }
  .f-label { grid-column: span 1; }
}
</style>
