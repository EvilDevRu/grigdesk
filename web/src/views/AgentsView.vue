<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { api } from '../shared/api-client.js';
import { confirmDialog } from '../shared/ui/confirm.js';
import HelpTip from '../shared/ui/HelpTip.vue';
import ToggleSwitch from '../shared/ui/ToggleSwitch.vue';
import NumberField from '../shared/ui/NumberField.vue';
import {
  familyLabel,
  familyModels,
  resolveModelFamily,
} from '../shared/model-family.js';

// База агентов (стадий конвейера): слева список, справа редактор карточки.
// Агент — базовая сущность; принадлежность к маршрутам здесь НЕ настраивается
// (это свойство маршрута — им займётся конструктор схем).
// Два уровня настроек: обычные (подпись, форма, модель, промпт) и «Профи»
// (ключ реестра, сноска, таймаут, бюджет, флаги) — скрыты за тумблером.
const agents = ref([]);
const loading = ref(false);
const error = ref('');
const selectedId = ref('');
const form = ref(null);        // редактируемая копия
const isNew = ref(false);      // режим создания нового агента
const saving = ref(false);
const notice = ref('');
const pro = ref(localStorage.getItem('cockpit-agents-pro') === '1');

const KINDS = [
  { v: 'agent', label: '🤖 Агент' },
  { v: 'human', label: '👤 Человек' },
  { v: 'code', label: '</> Код' },
];
const KIND_ICON = { agent: '🤖', human: '👤', code: '</>' };
// Семейства и их текущие модели/эффорты — из реестра исполнителей, без хардкода.
const providers = ref([]);

// Описания настроек для тултипов — языком человека, не движка.
const HELP = {
  label: 'Название блока — так этап подписан на схеме конвейера.',
  kind: 'Кто выполняет этап: агент Claude, человек (конвейер встаёт и ждёт решения в дашборде) или код (скрипт/проверка). Заодно определяет форму блока на схеме: прямоугольник, пилюля или ромб.',
  model: 'Какое семейство модели выполняет этап. Конкретную актуальную версию движок выбирает из живого каталога перед запуском. «Сессионная» — семейство прогона; точный id можно сохранить как явный pin для исключений.',
  effort: 'Сколько модель «думает» на этапе. «Дефолт движка» — не задавать явно. Механическим этапам хватает низкого, проверочным и планирующим — высокий и выше. Доступные ступени зависят от выбранной модели.',
  sub: 'Мелкая приписка под блоком на схеме — подсказка, чем этап занимается (например «pint · eslint»).',
  key: 'Имя ключа в реестре прогона, куда движок и агент пишут статус этапа: running, done, failed. По нему схема красит блок.',
  timeout: 'Максимум времени на этап в секундах. 0 — стандартный лимит движка. Агент, убитый по таймауту, теряет всю работу этапа — браузерным и видео-этапам лимит поднимают.',
  budget: 'Ориентир длительности этапа в минутах. Агенту говорят укладываться в него, сужая охват работы, а не работать дольше.',
  flags: '«read-only» — агенту запрещена запись в файлы проекта (для проверочных этапов: ревью, линт). «optional» — этап можно штатно пропустить, пропуск не считается аномалией.',
  prompt: 'Заготовка задания: при добавлении агента в схему копируется в узел и дальше живёт в самой схеме (правится кликом по узлу в «Маршрутах»). Правка шаблона уже расставленные узлы не меняет. Плейсхолдеры {{TASK}} и {{STATE_DIR}} движок заменяет на номер задачи и каталог состояния прогона.',
};

watch(pro, (v) => localStorage.setItem('cockpit-agents-pro', v ? '1' : '0'));

const groups = computed(() => KINDS
  .map((k) => ({ ...k, items: agents.value.filter((a) => a.kind === k.v) }))
  .filter((g) => g.items.length));

// По одному актуальному кандидату каждого семейства; значение селекта = family, не exact id.
const modelGroups = computed(() => providers.value
  .map((p) => ({ id: p.id, name: p.name, models: familyModels(p.models || []) }))
  .filter((g) => g.models.length));
const selectedModel = computed(() => resolveModelFamily(providers.value, form.value?.model));
const pinnedModel = computed(() => {
  if (!form.value?.model || !selectedModel.value || form.value.model === selectedModel.value.family) return null;
  const exact = selectedModel.value.matched?.id === form.value.model;
  return {
    value: form.value.model,
    label: exact
      ? `${form.value.model} (точный pin)`
      : selectedModel.value.family
        ? `${form.value.model} → ${familyLabel(selectedModel.value.family)}`
        : `${form.value.model} (алиас)`,
  };
});
// Эффорты доступной ступенью зависят от выбранной модели; без модели — объединение всех.
const effortOptions = computed(() => {
  const all = providers.value.flatMap((p) => p.models || []);
  const m = pinnedModel.value ? selectedModel.value?.matched : selectedModel.value?.model;
  const list = m?.efforts || [...new Set(all.flatMap((x) => x.efforts || []))];
  return list;
});

function agentModelLabel(agent) {
  if (!agent?.model) return 'сессия';
  const resolved = resolveModelFamily(providers.value, agent.model);
  if (!resolved) return agent.model;
  if (!resolved.family) return `${agent.model} 🔒`;
  return `${familyLabel(resolved.family)}${agent.model === resolved.family ? '' : ' 🔒'}`;
}

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

// Смена модели: если выбранный эффорт этой модели недоступен — сбрасываем на дефолт.
function onModelChange() {
  if (form.value.effort && !effortOptions.value.includes(form.value.effort)) form.value.effort = '';
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
    id: '', kind: 'agent', label: '', sub: '', key: '', model: '', effort: '',
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

onMounted(load);
</script>

<template>
  <div class="agents-page">
    <!-- Список -->
    <aside class="list">
      <div class="list-head">
        <span class="ttl">База агентов</span>
        <button class="btn accent" @click="createNew">+ Новый</button>
      </div>
      <div v-if="loading && !agents.length" class="pad muted"><span class="spin"></span> Загружаю…</div>
      <div v-else-if="error && !agents.length" class="pad bad">{{ error }}</div>
      <template v-for="g in groups" :key="g.v">
        <div class="grp-ttl">{{ g.label }}</div>
        <button v-for="a in g.items" :key="a.id" class="item" :class="{ sel: a.id === selectedId && !isNew }" @click="select(a.id)">
          <span class="ic" :class="`k-${a.kind}`">{{ KIND_ICON[a.kind] }}</span>
          <span class="nm">{{ a.label || a.id }}</span>
          <span v-if="a.model || a.effort" class="chip mono">{{ [agentModelLabel(a), a.effort].filter(Boolean).join(' · ') }}</span>
        </button>
      </template>
    </aside>

    <!-- Редактор -->
    <section v-if="form" class="editor">
      <header class="ehead">
        <template v-if="isNew">
          <input v-model.trim="form.id" class="fld idfld mono" placeholder="id (латиница, напр. my_agent)" spellcheck="false" />
        </template>
        <template v-else>
          <span class="eid mono">{{ selectedId }}</span>
        </template>
        <span class="grow"></span>
        <span v-if="notice" class="notice" :class="{ bad: notice.startsWith('Ошибка') }">{{ notice }}</span>
        <ToggleSwitch v-model="pro" label="профи" title="Показать профи-настройки" />
        <button v-if="!isNew" class="btn danger" @click="del">Удалить</button>
        <button class="btn accent" :disabled="saving || !dirty || (isNew && !form.id)" @click="save">
          <span v-if="saving" class="spin"></span> Сохранить
        </button>
      </header>

      <!-- Обычные настройки -->
      <div class="fields">
        <label class="f f-label">
          <span class="lbl">Подпись <HelpTip :text="HELP.label" align="left" /></span>
          <input v-model="form.label" class="fld" placeholder="Название блока на схеме" />
        </label>
        <label class="f">
          <span class="lbl">Форма блока <HelpTip :text="HELP.kind" /></span>
          <select v-model="form.kind" class="fld">
            <option v-for="k in KINDS" :key="k.v" :value="k.v">{{ k.label }}</option>
          </select>
        </label>
        <label class="f">
          <span class="lbl">Семейство модели <HelpTip :text="HELP.model" /></span>
          <select v-model="form.model" class="fld" @change="onModelChange">
            <option value="">сессионное (семейство прогона)</option>
            <optgroup v-for="g in modelGroups" :key="g.id" :label="g.name">
              <option v-for="m in g.models" :key="m.id" :value="m.family">
                {{ familyLabel(m.family) }} · сейчас {{ m.name }}
              </option>
            </optgroup>
            <!-- Старый exact/alias не теряем: он остаётся осознанным pin до смены выбора. -->
            <option v-if="pinnedModel" :value="pinnedModel.value">{{ pinnedModel.label }}</option>
            <option v-else-if="form.model && !selectedModel"
                    :value="form.model">{{ form.model }} (нет в реестре)</option>
          </select>
        </label>
        <label class="f">
          <span class="lbl">Эффорт <HelpTip :text="HELP.effort" /></span>
          <select v-model="form.effort" class="fld">
            <option value="">дефолт движка</option>
            <option v-for="e in effortOptions" :key="e" :value="e">{{ e }}</option>
          </select>
        </label>
      </div>

      <!-- Профи-настройки -->
      <div v-if="pro" class="fields pro">
        <label class="f">
          <span class="lbl">Сноска <HelpTip :text="HELP.sub" align="left" /></span>
          <input v-model="form.sub" class="fld" placeholder="под блоком (напр. pint · eslint)" />
        </label>
        <label class="f">
          <span class="lbl">Ключ реестра <HelpTip :text="HELP.key" /></span>
          <input v-model="form.key" class="fld mono" placeholder="SCOUT" spellcheck="false" />
        </label>
        <label class="f">
          <span class="lbl">Таймаут, сек <HelpTip :text="HELP.timeout" /></span>
          <NumberField v-model="form.timeout" :step="60" placeholder="0 = дефолт" />
        </label>
        <label class="f">
          <span class="lbl">Бюджет <HelpTip :text="HELP.budget" /></span>
          <NumberField v-model="form.budget" placeholder="0 = нет" />
        </label>
        <div class="f">
          <span class="lbl">Флаги <HelpTip :text="HELP.flags" /></span>
          <div class="row">
            <button class="tag" :class="{ on: form.readonly }" title="Запрет записи в каталоги проекта" @click="form.readonly = !form.readonly">read-only</button>
            <button class="tag" :class="{ on: form.optional }" title="Этап можно штатно пропускать" @click="form.optional = !form.optional">optional</button>
          </div>
        </div>
      </div>

      <div class="prompt-wrap">
        <div class="lbl prompt-lbl">Заготовка промпта <HelpTip :text="HELP.prompt" align="left" /> <span class="muted sm">— копируется в узел при добавлении в схему; боевой текст правится в самой схеме</span></div>
        <textarea v-model="form.prompt" class="prompt mono" spellcheck="false"
                  :placeholder="form.kind === 'human' ? 'У человеческих ворот промпта нет — движок ждёт решения в дашборде' : 'Заготовка задания для новых узлов…'"></textarea>
      </div>
    </section>

    <section v-else class="editor empty">
      <p class="muted">Выбери агента слева или создай нового</p>
    </section>
  </div>
</template>

<style scoped>
.agents-page { height: 100%; display: grid; grid-template-columns: 290px 1fr; min-height: 0; }

/* ── Список ── */
.list { border-right: 1px solid var(--line); background: var(--sidebar); overflow-y: auto; padding: 10px; }
.list-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 4px 10px; }
.ttl { font-weight: 700; font-size: 13.5px; }
.grp-ttl { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
  color: var(--ink-mid); padding: 10px 6px 4px; }
.item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: none;
  border: none; color: var(--ink); padding: 7px 8px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.item:hover { background: var(--surface); }
.item.sel { background: color-mix(in srgb, var(--accent) 16%, transparent); }
.item .ic { flex: none; width: 20px; font-size: 12px; text-align: center; }
.ic.k-code { color: var(--node-code); font-weight: 700; font-size: 10px; }
.item .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip { flex: none; font-size: 10px; color: var(--ink-mid); background: var(--surface-2);
  border: 1px solid var(--line); border-radius: 5px; padding: 1px 5px; }
.pad { padding: 12px 8px; }

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
.fld { background: var(--surface); border: 1px solid var(--line); color: var(--ink); border-radius: 8px;
  padding: 7px 10px; font-size: 13px; font-family: inherit; width: 100%; }
.fld:focus { outline: none; border-color: var(--line-2); }
select.fld { cursor: pointer; }

.row { display: flex; gap: 6px; flex-wrap: wrap; }
.tag { background: var(--surface); border: 1px solid var(--line); color: var(--ink-mid); border-radius: 7px;
  padding: 6px 11px; font-size: 12px; cursor: pointer; font-family: var(--mono); }
.tag.on { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
  background: color-mix(in srgb, var(--accent) 10%, transparent); }

.prompt-wrap { flex: 1; display: flex; flex-direction: column; gap: 4px; min-height: 0; }
.prompt-lbl .sm { text-transform: none; letter-spacing: 0; font-weight: 400; font-size: 11px; }
.prompt { flex: 1; min-height: 180px; resize: none; background: var(--ground); border: 1px solid var(--line);
  color: var(--ink); border-radius: 10px; padding: 12px 14px; font-size: 12.5px; line-height: 1.55; }
.prompt:focus { outline: none; border-color: var(--line-2); }

.btn { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink); border-radius: 8px;
  padding: 7px 13px; font-size: 12.5px; cursor: pointer; white-space: nowrap; }
.btn:hover { border-color: var(--line-2); }
.btn:disabled { opacity: .45; cursor: default; }
.btn.accent { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
.btn.danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 35%, var(--line)); }
.bad { color: var(--bad); }
.sm { font-size: 11px; }

/* Планшет/узкий экран: список сверху, редактор ниже */
@media (max-width: 820px) {
  .agents-page { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  .list { border-right: none; border-bottom: 1px solid var(--line); max-height: 38vh; }
  .f-label { grid-column: span 1; }
}
</style>
