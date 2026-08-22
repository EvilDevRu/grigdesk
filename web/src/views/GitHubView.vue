<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../shared/api-client.js';
import { confirmDialog } from '../shared/ui/confirm.js';

const EMPTY_STATUS = Object.freeze({
  configured: false,
  state: null,
  repositoryId: null,
  fullName: null,
  connectedAt: null,
  connection: 'disconnected',
  reason: null,
  cleanupPending: false,
});

const loading = ref(true);
const unavailable = ref(false);
const error = ref('');
const notice = ref('');
const busy = ref('');
const status = ref({ ...EMPTY_STATUS });
const rules = ref([]);
const rulesLoaded = ref(false);
const policyFingerprint = ref('');
const agentSearch = ref(false);
// После неоднозначного transport failure прежнее значение больше не является
// фактом. Отдельный флаг не даёт false визуально превратиться в «точно закрыто».
const agentSearchKnown = ref(false);
const editingRule = ref(false);
const connectForm = reactive({ owner: '', repo: '', token: '' });
const ruleForm = reactive({
  project: '', kind: 'bug', responsibleId: '', groupId: '', priority: 1,
});
let preservedAutoTask = null;

const verified = computed(() => Boolean(status.value.repositoryId && status.value.fullName));
const providerWritable = computed(() => status.value.connection === 'connected'
  && status.value.state === 'connected');
const canConnect = computed(() => connectForm.owner.trim() && connectForm.repo.trim()
  && connectForm.token.trim() && !busy.value);
const validRule = computed(() => ruleForm.project.trim()
  && validOptionalId(ruleForm.responsibleId) && validOptionalId(ruleForm.groupId));

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

// Статус копируется по allowlist полей. Даже если version-skew server случайно
// добавит credential internals, шаблон не сможет отобразить token/secret/ingressRef.
function publicStatus(payload) {
  const raw = isPlainObject(payload?.status) ? payload.status : (isPlainObject(payload) ? payload : {});
  return {
    configured: raw.configured === true,
    state: typeof raw.state === 'string' ? raw.state : null,
    repositoryId: typeof raw.repositoryId === 'string' ? raw.repositoryId : null,
    fullName: typeof raw.fullName === 'string' ? raw.fullName : null,
    connectedAt: Number.isFinite(raw.connectedAt) ? raw.connectedAt : null,
    connection: typeof raw.connection === 'string' ? raw.connection : 'disconnected',
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    cleanupPending: raw.cleanupPending === true || raw.state === 'cleanup_pending',
  };
}

function isPluginDisabled(err) {
  return err?.status === 404 && err?.data?.error === 'plugin_disabled';
}

function applyRule(rule) {
  if (!isPlainObject(rule)) {
    ruleForm.project = '';
    ruleForm.kind = 'bug';
    ruleForm.responsibleId = '';
    ruleForm.groupId = '';
    ruleForm.priority = 1;
    preservedAutoTask = null;
    agentSearch.value = false;
    return;
  }
  ruleForm.project = typeof rule.project === 'string' ? rule.project : '';
  ruleForm.kind = rule.kind === 'wish' ? 'wish' : 'bug';
  ruleForm.responsibleId = rule.b24?.responsibleId == null ? '' : String(rule.b24.responsibleId);
  ruleForm.groupId = rule.b24?.groupId == null ? '' : String(rule.b24.groupId);
  ruleForm.priority = [0, 1, 2].includes(rule.b24?.priority) ? rule.b24.priority : 1;
  preservedAutoTask = isPlainObject(rule.autoTask) ? { ...rule.autoTask } : null;
  agentSearch.value = rule.agentSearch === true;
}

const POLICY_FINGERPRINT_RE = /^ghpol1:[0-9a-f]{64}$/u;

function applyRulesSnapshot(data) {
  rules.value = Array.isArray(data?.rules) ? data.rules.slice(0, 1) : [];
  policyFingerprint.value = typeof data?.policyFingerprint === 'string'
    && POLICY_FINGERPRINT_RE.test(data.policyFingerprint)
    ? data.policyFingerprint
    : '';
  agentSearchKnown.value = Boolean(policyFingerprint.value);
  applyRule(rules.value[0]);
  editingRule.value = false;
}

async function readRulesSnapshot() {
  const data = await api.get('/api/github/rules');
  applyRulesSnapshot(data);
  return data;
}

async function loadRules() {
  rulesLoaded.value = false;
  if (!verified.value) {
    rules.value = [];
    policyFingerprint.value = '';
    agentSearchKnown.value = false;
    applyRule(null);
    rulesLoaded.value = true;
    return;
  }
  await readRulesSnapshot();
  rulesLoaded.value = true;
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await api.get('/api/github/status');
    status.value = publicStatus(data);
    unavailable.value = false;
    await loadRules();
  } catch (err) {
    if (isPluginDisabled(err)) {
      unavailable.value = true;
      status.value = { ...EMPTY_STATUS };
      rules.value = [];
      error.value = '';
    } else {
      error.value = err?.message || 'Не удалось прочитать состояние GitHub.';
    }
  } finally {
    loading.value = false;
  }
}

async function connect() {
  if (!canConnect.value) return;
  busy.value = 'connect';
  error.value = '';
  try {
    await api.post('/api/github/connect', {
      owner: connectForm.owner.trim(),
      repo: connectForm.repo.trim(),
      token: connectForm.token.trim(),
    });
    connectForm.token = '';
    notice.value = 'Репозиторий проверен; ожидаю signed ping от webhook.';
    await load();
  } catch (err) {
    error.value = err?.message || 'GitHub не принял подключение.';
  } finally {
    busy.value = '';
  }
}

async function recheck() {
  if (busy.value) return;
  busy.value = 'recheck';
  error.value = '';
  try {
    await api.post('/api/github/recheck', {});
    notice.value = 'Состояние GitHub перепроверено.';
    await load();
  } catch (err) {
    error.value = err?.message || 'Перепроверка GitHub не выполнена.';
  } finally {
    busy.value = '';
  }
}

async function disconnect() {
  if (busy.value || !(await confirmDialog(
    'Отключить GitHub? Webhook будет удалён, а секреты стёрты. Ранее принятые обращения останутся в Inbox для чтения.',
    { okText: 'Отключить' },
  ))) return;
  busy.value = 'disconnect';
  error.value = '';
  try {
    await api.post('/api/github/disconnect', {});
    notice.value = 'GitHub отключён.';
    await load();
  } catch (err) {
    error.value = err?.message || 'Отключение GitHub не завершено.';
  } finally {
    busy.value = '';
  }
}

function validOptionalId(value) {
  return !String(value).trim() || /^[1-9]\d*$/u.test(String(value).trim());
}

function idOrNull(value) {
  const text = String(value).trim();
  return text ? Number(text) : null;
}

function rulePayload() {
  const rule = {
    repositoryId: status.value.repositoryId,
    project: ruleForm.project.trim(),
    kind: ruleForm.kind,
  };
  const responsibleId = idOrNull(ruleForm.responsibleId);
  const groupId = idOrNull(ruleForm.groupId);
  if (responsibleId !== null || groupId !== null || rules.value[0]?.b24) {
    rule.b24 = { responsibleId, groupId, priority: Number(ruleForm.priority) };
  }
  // Минимальная форма не редактирует autoTask, поэтому существующее
  // безопасное значение сохраняем; для нового rule server включит auto off default.
  if (preservedAutoTask) rule.autoTask = { ...preservedAutoTask };
  return rule;
}

async function saveRules(nextRules) {
  if (busy.value || !providerWritable.value) return;
  busy.value = 'rules';
  error.value = '';
  try {
    await api.put('/api/github/rules', {
      repositoryId: status.value.repositoryId,
      rules: nextRules,
    });
    notice.value = nextRules.length ? 'Репозиторий допущен в Inbox.' : 'Allowlist GitHub пуст.';
    await loadRules();
  } catch (err) {
    error.value = err?.message || 'Правило GitHub не сохранено.';
  } finally {
    busy.value = '';
  }
}

async function changeAgentSearch(event) {
  const enabled = event?.target?.checked === true;
  if (event?.target) event.target.checked = agentSearchKnown.value && agentSearch.value;
  if (busy.value || !providerWritable.value || rules.value.length !== 1
      || !agentSearchKnown.value || !policyFingerprint.value) return;
  if (enabled && !(await confirmDialog(
    'Разрешить coding-агентам выбранного проекта искать содержимое GitHub Issues? Человеческий Inbox от этой настройки не изменится.',
    { okText: 'Разрешить агентам' },
  ))) return;

  busy.value = 'agent-search';
  error.value = '';
  notice.value = '';
  try {
    await api.put('/api/github/rules/agent-search', {
      repositoryId: status.value.repositoryId,
      expectedPolicyFingerprint: policyFingerprint.value,
      enabled,
    });
    notice.value = enabled
      ? 'Поиск по GitHub Issues разрешён агентам выбранного проекта.'
      : 'Поиск по GitHub Issues для агентов закрыт.';
    await loadRules();
  } catch (err) {
    const mutationMessage = err?.message || 'Ответ изменения доступа не получен.';
    try {
      await readRulesSnapshot();
      rulesLoaded.value = true;
      if (!agentSearchKnown.value) {
        throw new Error('Сервер не вернул достоверный policy fingerprint.');
      }
      const actual = agentSearch.value;
      if (actual === enabled) {
        error.value = '';
        notice.value = `Повторная проверка подтвердила: поиск агентам ${actual ? 'разрешён' : 'закрыт'}.`;
      } else {
        notice.value = '';
        error.value = `${mutationMessage} Повторная проверка подтвердила: `
          + `поиск агентам ${actual ? 'разрешён' : 'закрыт'}, `
          + `запрошенное ${enabled ? 'включение' : 'выключение'} не применено.`;
      }
    } catch (refreshError) {
      // Нельзя позволить повторный CAS со старым отпечатком и нельзя показывать
      // прежний boolean как достоверное состояние после ambiguous commit.
      policyFingerprint.value = '';
      agentSearchKnown.value = false;
      agentSearch.value = false;
      rulesLoaded.value = true;
      notice.value = '';
      error.value = `${mutationMessage} Состояние доступа не подтверждено (неизвестно): `
        + `${refreshError?.message || 'правила не удалось перечитать'}`;
    }
  } finally {
    busy.value = '';
  }
}

async function removeRule() {
  if (!providerWritable.value || !(await confirmDialog(
    'Убрать репозиторий из allowlist? Новые issues не будут попадать в Inbox.',
    { okText: 'Убрать' },
  ))) return;
  await saveRules([]);
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU');
}

function stateLabel(value) {
  return ({ pending: 'Ожидает webhook ping', connected: 'Подключён', cleanup_pending: 'Очистка не завершена' })[value]
    || 'Не подключён';
}

onMounted(load);
</script>

<template>
  <main class="github-page">
    <header class="page-head">
      <div><h1>GitHub Issues</h1><p>Один проверенный репозиторий как канал общего Inbox.</p></div>
      <button class="btn" type="button" :disabled="loading || !!busy" @click="load">Обновить</button>
    </header>

    <section v-if="unavailable" class="card" data-state="plugin-disabled">
      <h2>GitHub недоступен</h2>
      <p>Включите плагин GitHub в разделе «Настройки → Плагины».</p>
    </section>

    <template v-else>
      <p v-if="error" class="banner bad" role="alert">{{ error }}</p>
      <p v-if="notice" class="banner good" role="status">{{ notice }}</p>
      <section v-if="loading" class="card"><span class="spin"></span> Проверяю GitHub…</section>

      <div v-else class="grid">
        <section class="card connection-card">
          <h2>Подключение</h2>
          <form v-if="!status.configured" class="form" @submit.prevent="connect">
            <p class="read-only" data-state="provider-disconnected">
              GitHub не подключён: новые issues не принимаются. Ранее принятые обращения,
              если они есть, остаются в общем Inbox только для чтения.
            </p>
            <label>Owner<input v-model="connectForm.owner" name="owner" autocomplete="off" placeholder="example-org"></label>
            <label>Repository<input v-model="connectForm.repo" name="repo" autocomplete="off" placeholder="ai-cockpit"></label>
            <label>Personal access token
              <input v-model="connectForm.token" name="token" type="password" autocomplete="new-password" spellcheck="false" placeholder="github_pat_…">
            </label>
            <p class="hint">PAT и webhook secret хранятся только на сервере и не возвращаются в эту форму.</p>
            <button class="btn accent" type="submit" :disabled="!canConnect">Подключить</button>
          </form>
          <div v-else class="connection">
            <div class="connection-head">
              <strong>{{ status.fullName || 'Репозиторий проверяется' }}</strong>
              <span class="pill" :class="status.connection">{{ stateLabel(status.state) }}</span>
            </div>
            <dl>
              <template v-if="status.repositoryId"><dt>Repository ID</dt><dd>{{ status.repositoryId }}</dd></template>
              <template v-if="status.connectedAt"><dt>Подключён</dt><dd>{{ formatTime(status.connectedAt) }}</dd></template>
            </dl>
            <p v-if="status.state === 'pending'" class="warn">Привязка уже сохранена, но канал станет active только после signed ping.</p>
            <p v-if="status.cleanupPending" class="bad">Очистка webhook не завершена. Повторите отключение.</p>
            <p v-if="status.reason" class="bad">{{ status.reason }}</p>
            <p v-if="!providerWritable" class="read-only" data-state="provider-read-only">
              Provider сейчас не готов к записи. Ранее принятые обращения доступны в Inbox только для чтения.
            </p>
            <p v-else class="lifecycle-note">
              Подключение provider не включает очередь автоматически. Allowlist задаётся справа,
              а начать или остановить приём новых issues можно отдельно в
              <a href="#/inbox">общем Inbox</a>.
            </p>
            <div class="actions">
              <button class="btn" type="button" :disabled="!!busy" @click="recheck">Перепроверить</button>
              <button class="btn danger" type="button" :disabled="!!busy" @click="disconnect">
                {{ status.cleanupPending ? 'Повторить отключение' : 'Отключить' }}
              </button>
            </div>
          </div>
        </section>

        <section class="card rules-card">
          <h2>Allowlist Inbox</h2>
          <p v-if="!verified" class="hint">Сначала подключите и проверьте репозиторий.
          </p>
          <p v-else-if="!rulesLoaded" class="hint"><span class="spin"></span> Загружаю правило…</p>
          <template v-else-if="!rules.length && !editingRule">
            <div class="empty-allowlist" data-state="empty-allowlist">
              <strong>Allowlist пуст</strong>
              <p>Issues этого репозитория не попадут в Inbox, пока вы не зададите проект.</p>
            </div>
            <button class="btn accent" type="button" :disabled="!providerWritable || !!busy"
                    @click="editingRule = true">Допустить в Inbox</button>
          </template>
          <form v-else class="form" @submit.prevent="saveRules([rulePayload()])">
            <p v-if="!providerWritable" class="read-only">
              Правило показано без права записи, пока GitHub не переподключён.
            </p>
            <label>Проект<input v-model="ruleForm.project" name="project" placeholder="cockpit"
                                 :disabled="!providerWritable || !!busy"></label>
            <label>Тип
              <select v-model="ruleForm.kind" name="kind" :disabled="!providerWritable || !!busy"><option value="bug">Ошибка</option><option value="wish">Пожелание</option></select>
            </label>
            <details>
              <summary>Поля задачи Битрикс24 (необязательно)</summary>
              <div class="b24-grid">
                <label>Responsible ID<input v-model="ruleForm.responsibleId" inputmode="numeric" name="responsibleId" :disabled="!providerWritable || !!busy"></label>
                <label>Group ID<input v-model="ruleForm.groupId" inputmode="numeric" name="groupId" :disabled="!providerWritable || !!busy"></label>
                <label>Приоритет<select v-model.number="ruleForm.priority" name="priority" :disabled="!providerWritable || !!busy"><option :value="0">0</option><option :value="1">1</option><option :value="2">2</option></select></label>
              </div>
            </details>
            <div v-if="rules.length" class="agent-search-policy">
              <label class="check-row">
                <input name="agentSearch" type="checkbox" :checked="agentSearchKnown && agentSearch"
                       :disabled="!providerWritable || !agentSearchKnown || !policyFingerprint || !!busy"
                       @change="changeAgentSearch">
                <span>Разрешить поиск coding-агентам проекта</span>
              </label>
              <p class="hint">
                Это отдельный opt-in только для агентского поиска. Человеческий Inbox и его
                allowlist не расширяются.
              </p>
              <p v-if="!agentSearchKnown" class="warn" data-state="agent-search-unknown">
                Состояние доступа не подтверждено (неизвестно). Обновите правила перед новым изменением.
              </p>
            </div>
            <p class="hint">Новое правило не включает автоматическое создание задач.</p>
            <div class="actions">
              <button class="btn accent" type="submit" :disabled="!providerWritable || !validRule || !!busy">Сохранить</button>
              <button v-if="rules.length" class="btn danger" type="button" :disabled="!providerWritable || !!busy" @click="removeRule">Убрать из Inbox</button>
              <button v-else class="btn" type="button" @click="editingRule = false">Отмена</button>
            </div>
          </form>
        </section>
      </div>
    </template>
  </main>
</template>

<style scoped>
.github-page { height: 100%; overflow: auto; padding: 22px; background: var(--ground); }.page-head, .grid, .banner, .card { max-width: 980px; margin-left: auto; margin-right: auto; }
.page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 18px; }.page-head h1 { margin: 0; font-size: 24px; }.page-head p, .hint { color: var(--ink-mid); margin: 4px 0; }
.grid { display: grid; grid-template-columns: minmax(300px, 1fr) minmax(340px, 1fr); gap: 14px; }.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); padding: 18px; }.card h2 { margin: 0 0 13px; font-size: 17px; }
.form { display: grid; gap: 11px; }.form label { display: grid; gap: 5px; color: var(--ink-mid); font-size: 12px; }.form input, .form select { min-height: 38px; border: 1px solid var(--line-2); border-radius: 8px; color: var(--ink); background: var(--ground); padding: 7px 9px; font: inherit; }.form input:focus, .form select:focus { outline: 1px solid var(--accent); }
.connection-head, .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }.connection-head { justify-content: space-between; }.pill { border-radius: 999px; background: var(--surface-2); padding: 3px 8px; font-size: 12px; }.pill.connected, .good { color: var(--good); }.pill.degraded, .bad, .read-only { color: var(--bad); }.pill.connecting, .warn { color: var(--warn); }.lifecycle-note { color: var(--ink-mid); }.lifecycle-note a { color: var(--accent); }
dl { display: grid; grid-template-columns: auto 1fr; gap: 5px 12px; }dt { color: var(--ink-mid); }dd { margin: 0; overflow-wrap: anywhere; }.actions { margin-top: 13px; }.btn { min-height: 36px; padding: 7px 12px; border: 1px solid var(--line-2); border-radius: 8px; color: var(--ink); background: var(--surface-2); cursor: pointer; }.btn.accent { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 24%, var(--surface)); }.btn.danger { border-color: color-mix(in srgb, var(--bad) 65%, var(--line)); }.btn:disabled { opacity: .45; cursor: default; }
.banner { padding: 10px 13px; border: 1px solid currentColor; border-radius: 9px; }.empty-allowlist { padding: 13px; margin-bottom: 12px; border: 1px dashed var(--warn); border-radius: 9px; }.empty-allowlist p { margin-bottom: 0; color: var(--ink-mid); }details { border-top: 1px solid var(--line); padding-top: 9px; }summary { cursor: pointer; }.b24-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 9px; }
.agent-search-policy { border-top: 1px solid var(--line); padding-top: 10px; }.check-row { display: flex !important; grid-template-columns: none; align-items: center; gap: 8px !important; color: var(--ink) !important; }.check-row input { min-height: 0; width: 16px; height: 16px; margin: 0; padding: 0; }
@media (max-width: 760px) { .github-page { padding: 14px; }.grid { grid-template-columns: 1fr; }.b24-grid { grid-template-columns: 1fr; } }
</style>
