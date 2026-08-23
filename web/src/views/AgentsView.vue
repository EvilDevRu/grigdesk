<template>
  <div class="agents-page">
    <!-- Список -->
    <aside class="list">
      <div class="list-head">
        <span class="ttl">База агентов</span>
        <!-- toggle: на планшете ховера нет, а объяснение раздела длинное — его читают, а не задевают мышью -->
        <HelpTip class="page-tip" toggle align="left" :tip-style="{ maxWidth: '330px' }">
          <template #tip>
            <span class="doc">
              <b class="doc-ttl">Библиотека ролей конвейера</b>
              <span v-for="(p, i) in helpPage" :key="i" class="doc-p">{{ p }}</span>
            </span>
          </template>

        </HelpTip>
        <span class="grow"></span>
        <UiButton class="btn" :loading="installing"
                title="Доустановить отсутствующих агентов из стандартного набора. Существующие и ваши правки не перезаписываются"
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
              <span class="nm" :title="a.label || a.id">{{ a.label || a.id }}</span>
              <span v-if="a.tier || a.effort" class="advice" :title="adviceTitle(a)">
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
                  title="Редкие поля роли: сноска под блоком, ключ в реестре задачи, таймаут, бюджет и флаги">профи</UiSwitch>
        <UiButton v-if="!isNew" class="btn danger" tone="danger" @click="del">Удалить</UiButton>
        <UiButton class="btn accent" tone="accent" :loading="saving"
                  :disabled="!dirty || (isNew && !form.id)" loading-label="Сохраняю" @click="save">Сохранить</UiButton>
      </header>

      <!-- Обычные настройки -->
      <div class="fields">
        <label class="f f-label">
          <span class="lbl">Подпись <HelpTip :text="help.label" align="left" /></span>
          <UiInput v-model="form.label" class="fld" placeholder="Название блока на схеме" />
        </label>
        <label class="f">
          <span class="lbl">Форма блока <HelpTip :text="help.kind" /></span>
          <UiSelect v-model="form.kind" class="fld">
            <option v-for="k in kinds" :key="k.v" :value="k.v">{{ k.label }}</option>
          </UiSelect>
        </label>
        <label class="f">
          <span class="lbl">Класс модели <HelpTip :text="help.tier" /></span>
          <UiSelect v-model="form.tier" class="fld">
            <option value="">без рекомендации</option>
            <option v-for="t in tiers" :key="t.v" :value="t.v">{{ t.label }}</option>
          </UiSelect>
        </label>
        <label class="f">
          <span class="lbl">Рекомендация effort <HelpTip :text="help.effort" /></span>
          <UiSelect v-model="form.effort" class="fld">
            <option value="">без рекомендации</option>
            <option v-for="e in effortOptions" :key="e" :value="e">{{ e }}</option>
          </UiSelect>
        </label>
      </div>

      <!-- Профи-настройки -->
      <div v-if="pro" class="fields pro">
        <label class="f">
          <span class="lbl">Сноска <HelpTip :text="help.sub" align="left" /></span>
          <UiInput v-model="form.sub" class="fld" placeholder="под блоком (напр. lint · tests)" />
        </label>
        <label class="f">
          <span class="lbl">Ключ реестра <HelpTip :text="help.key" /></span>
          <UiInput v-model="form.key" class="fld mono" placeholder="SCOUT" spellcheck="false" />
        </label>
        <label class="f">
          <span class="lbl">Таймаут, сек <HelpTip :text="help.timeout" /></span>
          <UiNumberField :model-value="form.timeout" :min="0" :step="60" placeholder="0 = дефолт"
                         @update:model-value="form.timeout = typeof $event === 'number' ? $event : 0" />
        </label>
        <label class="f">
          <span class="lbl">Бюджет <HelpTip :text="help.budget" /></span>
          <UiNumberField :model-value="form.budget" :min="0" placeholder="0 = нет"
                         @update:model-value="form.budget = typeof $event === 'number' ? $event : 0" />
        </label>
        <div class="f">
          <span class="lbl">Флаги <HelpTip :text="help.flags" /></span>
          <div class="row">
            <UiToggleButton v-model="form.readonly" class="tag"
                    title="Советовать запрет записи в репозиторий: этап только смотрит и отчитывается"
                    >read-only</UiToggleButton>
            <UiToggleButton v-model="form.optional" class="tag"
                    title="Советовать разрешить пропуск: конвейер идёт дальше, если этап нечего делать"
                    >optional</UiToggleButton>
          </div>
        </div>
      </div>

      <div class="prompt-wrap">
        <div class="lbl prompt-lbl">Заготовка задания <HelpTip :text="help.prompt" align="left" /> <span class="muted sm">— основа для промпта этапа; боевой текст живёт в маршруте проекта</span></div>
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
import { api } from '../shared/api-client.js';
import {
  UiButton,
  UiInput,
  UiNumberField,
  UiSelect,
  UiSelectableRow,
  UiSpinner,
  UiSwitch,
  UiTextarea,
  UiToggleButton,
  confirmDialog,
} from '../ui';
import { useUiContextSource } from '../composables/useUiContextSource.js';
import HelpTip from '../shared/ui/HelpTip.vue';

// База агентов (ролей конвейера): слева список, справа редактор карточки.
// Агент — заготовка роли: метаданные + начало задания. Ни одно поле не исполняется:
// боевой промпт этапа живёт в маршруте профиля (routes/<маршрут>/prompts/), модель и
// лимиты — в runners.env. Отсюда текст переносят в маршрут, а не наоборот.
// Тексты подсказок пишем в этой логике: сначала что это для человека, потом где лежит
// боевое значение — иначе раздел читается как настройки запуска, которыми он не является.
// Два уровня рекомендаций: обычные (подпись, форма, класс модели, промпт) и «Профи»
// (ключ реестра, сноска, таймаут, бюджет, флаги) — скрыты за тумблером.
const agents = ref([]);
const loading = ref(false);
const error = ref('');
const selectedId = ref('');
const form = ref(null);        // редактируемая копия
const isNew = ref(false);      // режим создания нового агента
const saving = ref(false);
const notice = ref('');
const installing = ref(false);   // идёт установка стандартного набора
const installNotice = ref('');   // итог установки в шапке списка
const pro = ref(localStorage.getItem('cockpit-agents-pro') === '1');
const agentsContext = useUiContextSource('agents', { layer: 'page', active: false });
watch(selectedId, (agentId) => {
  if (agentId) agentsContext.focus({ details: { agentId } });
  else agentsContext.blur();
}, { immediate: true });

const kinds = [
  { v: 'agent', label: '🤖 Агент' },
  { v: 'human', label: '👤 Человек' },
  { v: 'code', label: '</> Код' },
];
const kindIcon = { agent: '🤖', human: '👤', code: '</>' };
// Класс модели, а не семейство: база агентов общая для всех проектов, а проекты
// живут на разных исполнителях. Какое семейство закрывает класс — дело runners.env.
const tiers = [
  { v: 'reasoning', label: 'Рассуждающая — сложный анализ' },
  { v: 'balanced', label: 'Сбалансированная — рутина по спецификации' },
  { v: 'cheap', label: 'Экономная — механика и проверки' },
];
const tierLabel = Object.fromEntries(tiers.map((t) => [t.v, t.label.split(' — ')[0]]));
// Чипы в списке — это рекомендации, а не то, чем этап реально пойдёт: пишем это прямо
// в подсказке, иначе они читаются как «вот на чём он запустится».
function adviceTitle(a) {
  const parts = [];
  if (a.tier) parts.push(`модель класса «${tierLabel[a.tier] || a.tier}»`);
  if (a.effort) parts.push(`effort ${a.effort}`);
  return `Рекомендация автору маршрута: ${parts.join(', ')}. На запуск не влияет — модель и effort берутся из runners.env проекта.`;
}
// Эффорты — из реестра исполнителей, без хардкода.
const providers = ref([]);

// Описания настроек для тултипов — языком человека, не движка.
const help = {
  label: 'Как этап будет подписан на схеме конвейера — текст внутри блока. Например «Разведка» или «Приёмка кода».',
  kind: 'Кто делает этап: 🤖 агент — работает ИИ; 👤 человек — конвейер останавливается и ждёт решения человека; </> код — выполняется команда на хосте. Здесь это заготовка для нового блока: у этапов уже собранной схемы форма задана самой схемой.',
  tier: 'Насколько сильная модель нужна этапу: рассуждающая — для сложного анализа, сбалансированная — для рутины по готовой спецификации, экономная — для механики и проверок. Конкретную модель (opus, sonnet…) здесь не выбирают: база агентов общая для всех проектов, а какой моделью закрыть класс — решает runners.env проекта. Это пометка человеку, который собирает маршрут; запуск её не читает.',
  effort: 'Сколько усилий модели тратить на обдумывание хода — пометка тому, кто собирает маршрут. На запуск не влияет: фактический effort этапа берётся из runners.env проекта.',
  sub: 'Мелкая приписка под названием блока на схеме — уточнение, чем этап занят (например «lint · tests»).',
  key: 'Короткое имя этапа в реестре задачи (runKey): под ним движок хранит результат этапа и показывает его в дашборде и логах. Здесь — предложение для нового узла; у собранной схемы ключ берётся из неё.',
  timeout: 'За сколько секунд этап должен уложиться — ориентир тому, кто собирает маршрут; 0 — без рекомендации. Боевой лимит принадлежит опубликованному маршруту, и агент узнаёт его из служебного «регламента времени» в конце промпта.',
  budget: 'Ориентир объёма работы этапа для автора маршрута; 0 — без рекомендации. В маршрутах бюджет задан именованным классом (standard, large), так что число отсюда никуда не едет.',
  flags: 'Две пометки для нового узла: read-only — этапу нельзя писать в репозиторий (только смотрит и отчитывается), optional — этап разрешено штатно пропустить. Настоящую файловую политику и допустимые исходы задаёт маршрут.',
  prompt: 'С чего начинается задание этапа. Это заготовка: боевой текст живёт в маршруте профиля (routes/<маршрут>/prompts/), туда его переносят отсюда — правка заготовки собранные маршруты не меняет. Данные задачи (номер, ветку, отчёты предыдущих этапов) движок подставляет сам отдельными блоками.',
};

// Что это за раздел вообще — главный вопрос к нему. Держим ответ в трёх абзацах:
// что здесь лежит, чего оно НЕ делает и зачем тогда нужно.
const helpPage = [
  'Агент здесь — описание роли конвейера: как этап подписан на схеме, какого класса модель ему нужна и с чего начинается его задание.',
  'Это библиотека, а не настройки запуска. Прогон задачи отсюда не читает ничего: боевой промпт этапа лежит в маршруте проекта (profiles/<проект>/routes/<маршрут>/prompts/), а модель, effort и лимиты — в runners.env профиля. Правка карточки не трогает ни собранные маршруты, ни бегущие задачи.',
  'Смысл — держать формулировку роли в одном месте: описать её один раз и переносить в маршруты проектов, а не выдумывать заново под каждый. Все поля карточки — рекомендации автору маршрута.',
];

watch(pro, (v) => localStorage.setItem('cockpit-agents-pro', v ? '1' : '0'));

const groups = computed(() => kinds
  .map((k) => ({ ...k, items: agents.value.filter((a) => a.kind === k.v) }))
  .filter((g) => g.items.length));

// Модель шаблоном не выбирается, поэтому и ступени эффорта берём объединением по
// всем исполнителям реестра: какая из них применится — решит политика профиля.
const effortOptions = computed(() => [...new Set(providers.value
  .flatMap((p) => p.models || [])
  .flatMap((m) => m.efforts || []))]);

const original = computed(() => agents.value.find((a) => a.id === selectedId.value) || null);
const dirty = computed(() => {
  if (isNew.value) return true;
  if (!form.value || !original.value) return false;
  return JSON.stringify(form.value) !== JSON.stringify(original.value);
});

async function load() {
  loading.value = true; error.value = '';
  try {
    agents.value = (await api.get('/api/agents')).agents || [];
    if (!selectedId.value && agents.value.length) select(agents.value[0].id);
  } catch (e) { error.value = e.message; }
  finally { loading.value = false; }
  // Реестр моделей — отдельно и без блокировки списка (селекты дозаполнятся).
  try { providers.value = (await api.get('/api/providers')).providers || []; } catch { /* остаётся пусто */ }
}

async function select(id) {
  const a = agents.value.find((x) => x.id === id);
  if (!a) return;
  if (dirty.value && !(await confirmDialog('Есть несохранённые изменения — бросить?', { okText: 'Бросить' }))) return;
  selectedId.value = id; isNew.value = false; notice.value = '';
  form.value = JSON.parse(JSON.stringify(a));
}

async function createNew() {
  if (dirty.value && !(await confirmDialog('Есть несохранённые изменения — бросить?', { okText: 'Бросить' }))) return;
  selectedId.value = ''; isNew.value = true; notice.value = '';
  form.value = {
    id: '', kind: 'agent', label: '', sub: '', key: '', tier: '', effort: '',
    timeout: 0, budget: 0, readonly: false, optional: false, prompt: '',
  };
}

async function save() {
  if (!form.value) return;
  saving.value = true; notice.value = '';
  try {
    if (isNew.value) {
      const created = await api.post('/api/agents', form.value);
      isNew.value = false; selectedId.value = created.id;
    } else {
      await api.put(`/api/agents/${selectedId.value}`, form.value);
    }
    await load();
    const cur = agents.value.find((a) => a.id === selectedId.value);
    if (cur) form.value = JSON.parse(JSON.stringify(cur));
    notice.value = 'Сохранено';
    setTimeout(() => { notice.value = ''; }, 2000);
  } catch (e) { notice.value = `Ошибка: ${e.message}`; }
  finally { saving.value = false; }
}

async function del() {
  if (!selectedId.value || isNew.value) return;
  if (!(await confirmDialog(`Удалить агента «${form.value.label || selectedId.value}»?`, { danger: true, okText: 'Удалить' }))) return;
  try {
    await api.del(`/api/agents/${selectedId.value}`);
    selectedId.value = ''; form.value = null;
    await load();
  } catch (e) { notice.value = `Ошибка: ${e.message}`; }
}

// Доустановка отсутствующих агентов из стандартного набора (server/seed/agents).
// Create-only: свои правки и одноимённые агенты не перезаписываются, жать можно смело.
async function install() {
  installing.value = true; installNotice.value = '';
  try {
    const r = await api.post('/api/agents/install');
    await load();
    installNotice.value = r.created?.length
      ? `Установлено агентов: ${r.created.length}`
      : 'Все агенты набора уже есть';
    setTimeout(() => { installNotice.value = ''; }, 4000);
  } catch (e) { installNotice.value = `Ошибка: ${e.message}`; }
  finally { installing.value = false; }
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
