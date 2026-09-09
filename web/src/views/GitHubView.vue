<template>
  <main class="github-page">
    <header class="page-head">
      <div><h1>GitHub Issues</h1><p>Один проверенный репозиторий как канал общего Inbox.</p></div>
      <UiButton class="btn" :loading="loading" :disabled="!!busy"
                loading-label="Обновляю" @click="load">Обновить</UiButton>
    </header>

    <section v-if="unavailable" class="card" data-state="plugin-disabled">
      <h2>GitHub недоступен</h2>
      <p>Включите плагин GitHub в разделе «Настройки → Плагины».</p>
    </section>

    <template v-else>
      <p v-if="error" class="banner bad" role="alert">{{ error }}</p>
      <p v-if="notice" class="banner good" role="status">{{ notice }}</p>
      <section v-if="loading" class="card"><UiSpinner decorative /> Проверяю GitHub…</section>

      <div v-else class="grid">
        <section class="card connection-card">
          <h2>Подключение</h2>
          <form v-if="!status.configured" class="form" @submit.prevent="connect">
            <p class="read-only" data-state="provider-disconnected">
              GitHub не подключён: новые issues не принимаются. Ранее принятые обращения,
              если они есть, остаются в общем Inbox только для чтения.
            </p>
            <UiField label="Owner" required><UiInput v-model="connectForm.owner" name="owner" autocomplete="off" placeholder="example-org" /></UiField>
            <UiField label="Repository" required><UiInput v-model="connectForm.repo" name="repo" autocomplete="off" placeholder="ai-cockpit" /></UiField>
            <UiField label="Personal access token" required>
              <UiPasswordInput v-model="connectForm.token" name="token" autocomplete="new-password" spellcheck="false" placeholder="github_pat_…" />
            </UiField>
            <p class="hint">PAT и webhook secret хранятся только на сервере и не возвращаются в эту форму.</p>
            <UiButton class="btn accent" type="submit" tone="accent" :loading="busy === 'connect'"
                      :disabled="!canConnect && busy !== 'connect'" loading-label="Подключаю">Подключить</UiButton>
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
              <UiButton class="btn" :loading="busy === 'recheck'" :disabled="!!busy && busy !== 'recheck'"
                        loading-label="Перепроверяю" @click="recheck">Перепроверить</UiButton>
              <UiButton class="btn danger" tone="danger" :loading="busy === 'disconnect'"
                        :disabled="!!busy && busy !== 'disconnect'" loading-label="Отключаю" @click="disconnect">
                {{ status.cleanupPending ? 'Повторить отключение' : 'Отключить' }}
              </UiButton>
            </div>
          </div>
        </section>

        <section class="card rules-card">
          <h2>Allowlist Inbox</h2>
          <p v-if="!verified" class="hint">Сначала подключите и проверьте репозиторий.
          </p>
          <p v-else-if="!rulesLoaded" class="hint"><UiSpinner decorative /> Загружаю правило…</p>
          <template v-else-if="!rules.length && !editingRule">
            <div class="empty-allowlist" data-state="empty-allowlist">
              <strong>Allowlist пуст</strong>
              <p>Issues этого репозитория не попадут в Inbox, пока вы не зададите проект.</p>
            </div>
            <UiButton class="btn accent" tone="accent" :disabled="!providerWritable || !!busy"
                      @click="editingRule = true">Допустить в Inbox</UiButton>
          </template>
          <form v-else class="form" @submit.prevent="saveRules([rulePayload()])">
            <p v-if="!providerWritable" class="read-only">
              Правило показано без права записи, пока GitHub не переподключён.
            </p>
            <UiField label="Проект" required><UiInput v-model="ruleForm.project" name="project" placeholder="cockpit"
                     :disabled="!providerWritable || !!busy" /></UiField>
            <UiField label="Тип">
              <UiSelect v-model="ruleForm.kind" name="kind" :disabled="!providerWritable || !!busy"><option value="bug">Ошибка</option><option value="wish">Пожелание</option></UiSelect>
            </UiField>
            <details>
              <summary>Поля задачи Битрикс24 (необязательно)</summary>
              <div class="b24-grid">
                <UiField label="Responsible ID" :error="validOptionalId(ruleForm.responsibleId) ? '' : 'Нужно положительное целое число'">
                  <UiInput v-model="ruleForm.responsibleId" inputmode="numeric" name="responsibleId" :disabled="!providerWritable || !!busy" />
                </UiField>
                <UiField label="Group ID" :error="validOptionalId(ruleForm.groupId) ? '' : 'Нужно положительное целое число'">
                  <UiInput v-model="ruleForm.groupId" inputmode="numeric" name="groupId" :disabled="!providerWritable || !!busy" />
                </UiField>
                <UiField label="Приоритет">
                  <UiSelect v-model.number="ruleForm.priority" name="priority" :disabled="!providerWritable || !!busy"><option :value="0">0</option><option :value="1">1</option><option :value="2">2</option></UiSelect>
                </UiField>
              </div>
            </details>
            <div v-if="rules.length" class="agent-search-policy">
              <UiCheckbox class="check-row" name="agentSearch" :checked="agentSearchKnown && agentSearch"
                          :disabled="!providerWritable || !agentSearchKnown || !policyFingerprint || !!busy"
                          @change="changeAgentSearch">Разрешить поиск coding-агентам проекта</UiCheckbox>
              <p class="hint">
                Это opt-in будущего внешнего корпуса. Локальную базу знаний он не открывает;
                человеческий Inbox и его allowlist не расширяются.
              </p>
              <p v-if="!agentSearchKnown" class="warn" data-state="agent-search-unknown">
                Состояние доступа не подтверждено (неизвестно). Обновите правила перед новым изменением.
              </p>
            </div>
            <p class="hint">Новое правило не включает автоматическое создание задач.</p>
            <div class="actions">
              <UiButton class="btn accent" type="submit" tone="accent" :loading="busy === 'rules'"
                        :disabled="!providerWritable || !validRule || (!!busy && busy !== 'rules')"
                        loading-label="Сохраняю">Сохранить</UiButton>
              <UiButton v-if="rules.length" class="btn danger" tone="danger" :disabled="!providerWritable || !!busy" @click="removeRule">Убрать из Inbox</UiButton>
              <UiButton v-else class="btn" @click="editingRule = false">Отмена</UiButton>
            </div>
          </form>
        </section>
      </div>
    </template>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';

import { githubApi, githubErrorMessage, githubPluginDisabled } from '../shared/githubApi.ts';
import type {
  GitHubPolicy,
  GitHubRule,
  GitHubRuleAutoTask,
  GitHubRuleInput,
  GitHubStatus,
} from '../../../shared/githubContracts.ts';
import {
  UiButton,
  UiCheckbox,
  UiField,
  UiInput,
  UiPasswordInput,
  UiSelect,
  UiSpinner,
  confirmDialog,
} from '../ui';

const emptyStatus: GitHubStatus = Object.freeze({
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
const status = ref<GitHubStatus>({ ...emptyStatus });
const rules = ref<GitHubRule[]>([]);
const rulesLoaded = ref(false);
const policyFingerprint = ref('');
const agentSearch = ref(false);
// После неоднозначного transport failure прежнее значение больше не является
// фактом. Отдельный флаг не даёт false визуально превратиться в «точно закрыто».
const agentSearchKnown = ref(false);
const editingRule = ref(false);
const connectForm = reactive({
  owner: '',
  repo: '',
  token: '',
});
const ruleForm = reactive({
  project: '',
  kind: 'bug' as 'bug' | 'wish',
  responsibleId: '',
  groupId: '',
  priority: 1,
});
let preservedAutoTask: GitHubRuleAutoTask | null = null;

const verified = computed(() => Boolean(status.value.repositoryId && status.value.fullName));
const providerWritable = computed(() => status.value.connection === 'connected'
  && status.value.state === 'connected');
const canConnect = computed(() => connectForm.owner.trim() && connectForm.repo.trim()
  && connectForm.token.trim() && !busy.value);
const validRule = computed(() => ruleForm.project.trim()
  && validOptionalId(ruleForm.responsibleId) && validOptionalId(ruleForm.groupId));

/**
 * Правило в форму. Отсутствующее правило чистит форму целиком: показать поля прошлого
 * репозитория рядом с пустым allowlist значило бы предложить сохранить чужие данные.
 */
function applyRule(rule: GitHubRule | undefined): void {
  if (!rule) {
    ruleForm.project = '';
    ruleForm.kind = 'bug';
    ruleForm.responsibleId = '';
    ruleForm.groupId = '';
    ruleForm.priority = 1;
    preservedAutoTask = null;
    agentSearch.value = false;

    return;
  }

  ruleForm.project = rule.project;
  ruleForm.kind = rule.kind;
  ruleForm.responsibleId = rule.b24?.responsibleId == null ? '' : String(rule.b24.responsibleId);
  ruleForm.groupId = rule.b24?.groupId == null ? '' : String(rule.b24.groupId);
  ruleForm.priority = rule.b24?.priority ?? 1;
  preservedAutoTask = rule.autoTask ? { ...rule.autoTask } : null;
  agentSearch.value = rule.agentSearch === true;
}

/**
 * Снимок политики на экран. Отпечаток бывает пустым у ещё не подключённого канала —
 * тогда галочка доступа агентам показывается как «неизвестно», а не как «закрыто»:
 * без отпечатка CAS невозможен, и обещать точное состояние нельзя.
 */
function applyPolicy(policy: GitHubPolicy): void {
  rules.value = policy.rules.slice(0, 1);
  policyFingerprint.value = policy.policyFingerprint || '';
  agentSearchKnown.value = Boolean(policyFingerprint.value);
  applyRule(rules.value[0]);
  editingRule.value = false;
}

async function readRulesSnapshot(): Promise<GitHubPolicy> {
  const policy = await githubApi.rules();

  applyPolicy(policy);

  return policy;
}

/**
 * Правила читаются только у проверенного репозитория: до этого читать нечего, а
 * пустой ответ на экране выглядел бы как подтверждённый пустой allowlist.
 */
async function loadRules(): Promise<void> {
  rulesLoaded.value = false;

  if (!verified.value) {
    rules.value = [];
    policyFingerprint.value = '';
    agentSearchKnown.value = false;
    applyRule(undefined);
    rulesLoaded.value = true;

    return;
  }

  await readRulesSnapshot();
  rulesLoaded.value = true;
}

/**
 * Состояние раздела целиком. Выключенный плагин — не ошибка: раздел показывает,
 * что его выключил человек, а не красную полосу поверх пустого экрана.
 */
async function load(): Promise<void> {
  loading.value = true;
  error.value = '';

  try {
    status.value = await githubApi.status();
    unavailable.value = false;
    await loadRules();
  } catch (err) {
    if (githubPluginDisabled(err)) {
      unavailable.value = true;
      status.value = { ...emptyStatus };
      rules.value = [];
      error.value = '';
    } else {
      error.value = githubErrorMessage(err, 'Не удалось прочитать состояние GitHub.');
    }
  } finally {
    loading.value = false;
  }
}

/**
 * Подключение репозитория. Токен стирается из формы сразу после отправки: он ушёл на
 * сервер и обратно не возвращается, а оставшийся в поле переживёт уход со страницы.
 */
async function connect(): Promise<void> {
  if (!canConnect.value) {
    return;
  }

  busy.value = 'connect';
  error.value = '';

  try {
    await githubApi.connect(
      connectForm.owner.trim(),
      connectForm.repo.trim(),
      connectForm.token.trim(),
    );
    connectForm.token = '';
    notice.value = 'Репозиторий проверен; ожидаю signed ping от webhook.';
    await load();
  } catch (err) {
    error.value = githubErrorMessage(err, 'GitHub не принял подключение.');
  } finally {
    busy.value = '';
  }
}

/**
 * Перепроверка живого канала. Отдельная кнопка нужна потому, что канал может
 * протухнуть без единого события: hook удалили на стороне GitHub, и узнать об
 * этом иначе можно только по молчанию очереди.
 */
async function recheck(): Promise<void> {
  if (busy.value) {
    return;
  }

  busy.value = 'recheck';
  error.value = '';

  try {
    await githubApi.recheck();
    notice.value = 'Состояние GitHub перепроверено.';
    await load();
  } catch (err) {
    error.value = githubErrorMessage(err, 'Перепроверка GitHub не выполнена.');
  } finally {
    busy.value = '';
  }
}

/**
 * Отключение спрашивает человека: вместе с локальным ingress удаляется remote hook, а
 * секреты стираются. Уже принятые обращения при этом остаются в Inbox для чтения.
 */
async function disconnect(): Promise<void> {
  const confirmed = !busy.value && await confirmDialog(
    'Отключить GitHub? Webhook будет удалён, а секреты стёрты. '
      + 'Ранее принятые обращения останутся в Inbox для чтения.',
    { okText: 'Отключить' },
  );

  if (!confirmed) {
    return;
  }

  busy.value = 'disconnect';
  error.value = '';

  try {
    await githubApi.disconnect();
    notice.value = 'GitHub отключён.';
    await load();
  } catch (err) {
    error.value = githubErrorMessage(err, 'Отключение GitHub не завершено.');
  } finally {
    busy.value = '';
  }
}

// Пустое поле законно: идентификатор в Битрикс24 необязателен. Ноль и минус — нет.
function validOptionalId(value: string): boolean {
  return !String(value).trim() || /^[1-9]\d*$/u.test(String(value).trim());
}

function idOrNull(value: string): number | null {
  const text = String(value).trim();

  return text ? Number(text) : null;
}

/**
 * Правило из формы. Автомат создания задач эта форма не редактирует, поэтому уже
 * сохранённое значение переносится как есть: пропустив его, человек молча выключил
 * бы автомат, о котором в этой форме нет ни слова.
 */
function rulePayload(): GitHubRuleInput {
  const repositoryId = status.value.repositoryId || '';
  const responsibleId = idOrNull(ruleForm.responsibleId);
  const groupId = idOrNull(ruleForm.groupId);
  const rule: GitHubRuleInput = {
    repositoryId,
    project: ruleForm.project.trim(),
    kind: ruleForm.kind,
  };

  if (responsibleId !== null || groupId !== null || rules.value[0]?.b24) {
    rule.b24 = {
      responsibleId,
      groupId,
      priority: priorityOf(ruleForm.priority),
    };
  }

  if (preservedAutoTask) {
    rule.autoTask = { ...preservedAutoTask };
  }

  return rule;
}

// Ступень приоритета закрыта контрактом; форма отдаёт число, и оно приводится здесь.
function priorityOf(value: number): 0 | 1 | 2 {
  return value === 0 || value === 2 ? value : 1;
}

/**
 * Сохранение allowlist. Пустой список — это осознанное «ничего не допущено», поэтому
 * он проходит тем же путём, что и правило: убрать репозиторий из Inbox иначе нечем.
 */
async function saveRules(nextRules: GitHubRuleInput[]): Promise<void> {
  if (busy.value || !providerWritable.value) {
    return;
  }

  busy.value = 'rules';
  error.value = '';

  try {
    await githubApi.saveRules(status.value.repositoryId || '', nextRules);
    notice.value = nextRules.length ? 'Репозиторий допущен в Inbox.' : 'Allowlist GitHub пуст.';
    await loadRules();
  } catch (err) {
    error.value = githubErrorMessage(err, 'Правило GitHub не сохранено.');
  } finally {
    busy.value = '';
  }
}

// Галочка остаётся контролируемой: DOM откатывается к известному состоянию, а новое
// значение появится только после подтверждённого ответа сервера.
function restoreAgentSearchBox(target: HTMLInputElement | null): void {
  if (target) {
    target.checked = agentSearchKnown.value && agentSearch.value;
  }
}

/**
 * Изменение доступа агентам. Это не обычная галочка: у неё CAS по отпечатку политики,
 * подтверждение человека на включение и отдельный разбор потерянного ответа — после
 * него прежнее значение перестаёт быть фактом, и выдавать его за факт нельзя.
 */
async function changeAgentSearch(event: Event): Promise<void> {
  const target = event.target instanceof HTMLInputElement ? event.target : null;
  const enabled = target?.checked === true;

  restoreAgentSearchBox(target);

  if (busy.value || !providerWritable.value || rules.value.length !== 1
      || !agentSearchKnown.value || !policyFingerprint.value) {
    return;
  }

  const confirmed = !enabled || await confirmDialog(
    'Разрешить coding-агентам выбранного проекта искать содержимое GitHub Issues? '
      + 'Человеческий Inbox от этой настройки не изменится.',
    { okText: 'Разрешить агентам' },
  );

  if (!confirmed) {
    return;
  }

  busy.value = 'agent-search';
  error.value = '';
  notice.value = '';

  try {
    await githubApi.setAgentSearch(
      status.value.repositoryId || '',
      policyFingerprint.value,
      enabled,
    );
    notice.value = enabled
      ? 'Поиск по GitHub Issues разрешён агентам выбранного проекта.'
      : 'Поиск по GitHub Issues для агентов закрыт.';
    await loadRules();
  } catch (err) {
    await reportAmbiguousAgentSearch(err, enabled);
  } finally {
    busy.value = '';
  }
}

/**
 * Ответ на изменение доступа потерян. Единственный честный ход — перечитать политику
 * и сказать человеку, что на сервере на самом деле: запрошенное могло примениться,
 * могло не примениться, а если не читается и это — состояние неизвестно.
 */
async function reportAmbiguousAgentSearch(failure: unknown, enabled: boolean): Promise<void> {
  const mutationMessage = githubErrorMessage(failure, 'Ответ изменения доступа не получен.');

  try {
    await readRulesSnapshot();
    rulesLoaded.value = true;

    if (!agentSearchKnown.value) {
      throw new Error('Сервер не вернул достоверный policy fingerprint.');
    }

    const actual = agentSearch.value;

    if (actual === enabled) {
      error.value = '';
      notice.value = `Повторная проверка подтвердила: поиск агентам ${
        actual ? 'разрешён' : 'закрыт'}.`;

      return;
    }

    notice.value = '';
    error.value = `${mutationMessage} Повторная проверка подтвердила: `
      + `поиск агентам ${actual ? 'разрешён' : 'закрыт'}, `
      + `запрошенное ${enabled ? 'включение' : 'выключение'} не применено.`;
  } catch (refreshError) {
    // Нельзя позволить повторный CAS со старым отпечатком и нельзя показывать
    // прежний boolean как достоверное состояние после ambiguous commit.
    policyFingerprint.value = '';
    agentSearchKnown.value = false;
    agentSearch.value = false;
    rulesLoaded.value = true;
    notice.value = '';
    error.value = `${mutationMessage} Состояние доступа не подтверждено (неизвестно): `
      + `${githubErrorMessage(refreshError, 'правила не удалось перечитать')}`;
  }
}

async function removeRule(): Promise<void> {
  const confirmed = providerWritable.value && await confirmDialog(
    'Убрать репозиторий из allowlist? Новые issues не будут попадать в Inbox.',
    { okText: 'Убрать' },
  );

  if (confirmed) {
    await saveRules([]);
  }
}

function formatTime(value: number): string {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU');
}

function stateLabel(value: GitHubStatus['state']): string {
  return ({
    pending: 'Ожидает webhook ping',
    connected: 'Подключён',
    cleanup_pending: 'Очистка не завершена',
  })[String(value)] || 'Не подключён';
}

onMounted(load);
</script>

<style scoped>
.github-page { height: 100%; overflow: auto; padding: 22px; background: var(--ground); }.page-head, .grid, .banner, .card { max-width: 980px; margin-left: auto; margin-right: auto; }
.page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 18px; }.page-head h1 { margin: 0; font-size: 24px; }.page-head p, .hint { color: var(--ink-mid); margin: 4px 0; }
.grid { display: grid; grid-template-columns: minmax(300px, 1fr) minmax(340px, 1fr); gap: 14px; }.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); padding: 18px; }.card h2 { margin: 0 0 13px; font-size: 17px; }
.form { display: grid; gap: 11px; }
.connection-head, .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }.connection-head { justify-content: space-between; }.pill { border-radius: 999px; background: var(--surface-2); padding: 3px 8px; font-size: 12px; }.pill.connected, .good { color: var(--good); }.pill.degraded, .bad, .read-only { color: var(--bad); }.pill.connecting, .warn { color: var(--warn); }.lifecycle-note { color: var(--ink-mid); }.lifecycle-note a { color: var(--accent); }
dl { display: grid; grid-template-columns: auto 1fr; gap: 5px 12px; }dt { color: var(--ink-mid); }dd { margin: 0; overflow-wrap: anywhere; }.actions { margin-top: 13px; }
.banner { padding: 10px 13px; border: 1px solid currentColor; border-radius: 9px; }.empty-allowlist { padding: 13px; margin-bottom: 12px; border: 1px dashed var(--warn); border-radius: 9px; }.empty-allowlist p { margin-bottom: 0; color: var(--ink-mid); }details { border-top: 1px solid var(--line); padding-top: 9px; }summary { cursor: pointer; }.b24-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 9px; }
.agent-search-policy { border-top: 1px solid var(--line); padding-top: 10px; }.check-row { justify-self: start; }
@media (max-width: 760px) { .github-page { padding: 14px; }.grid { grid-template-columns: 1fr; }.b24-grid { grid-template-columns: 1fr; } }
</style>
