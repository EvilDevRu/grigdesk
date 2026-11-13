<template>
  <UiWorkspacePage
    :data-perf-pending="loading ? '' : undefined">
      <template #title><h1>{{ t('core.pluginGithub') }}</h1></template>
      <template #actions>
        <UiIconButton :label="t('core.trackerUpdate')" data-context="workspace-toolbar"
                      :loading="loading" :disabled="!!busy" :loading-label="t('core.updating')" @click="load">
          <UiRefreshIcon />
        </UiIconButton>
      </template>
    <div class="github-page">
    <p class="ui-workspace-intro">{{ t('core.githubOdinProverennyyRepozitoriyKak') }}</p>

    <section v-if="unavailable" class="card" data-state="plugin-disabled">
      <h2>{{ t('core.githubGithubNedostupen') }}</h2>
      <p>{{ t('core.githubVklyuchitePlaginGithubV') }}</p>
    </section>

    <template v-else>
      <p v-if="error" class="banner bad" role="alert"
    :data-perf-error="!loading && error && !status.connectedAt ? '' : undefined">{{ error }}</p>
      <p v-if="notice" class="banner good" role="status">{{ notice }}</p>
      <GitHubLoading v-if="loading" :label="t('core.githubProveryayuGithub')"  :failed="Boolean(error)" />

      <div v-else class="grid">
        <section class="card connection-card">
          <h2>{{ t('core.machineConnectionTitle') }}</h2>
          <form v-if="!status.configured" class="form" @submit.prevent="connect">
            <p class="read-only" data-state="provider-disconnected"> {{ t('core.githubGithubNePodklyuchenNovye') }} </p>
            <UiField :label="t('core.githubOwner')" required><UiInput v-model="connectForm.owner" name="owner" autocomplete="off" :placeholder="'example-org'" /></UiField>
            <UiField :label="t('core.githubRepository')" required><UiInput v-model="connectForm.repo" name="repo" autocomplete="off" :placeholder="'grigdesk'" /></UiField>
            <UiField :label="t('core.githubPersonalAccessToken')" required>
              <UiPasswordInput v-model="connectForm.token" name="token" autocomplete="new-password" spellcheck="false" :placeholder="'github_pat_…'" />
            </UiField>
            <p class="hint">{{ t('core.githubPatIWebhookSecret') }}</p>
            <UiButton class="btn accent" type="submit" tone="accent" :loading="busy === 'connect'"
                      :disabled="!canConnect && busy !== 'connect'" :loading-label="t('core.githubPodklyuchayu')">{{ t('core.githubPodklyuchit') }}</UiButton>
          </form>
          <div v-else class="connection">
            <div class="connection-head">
              <strong>{{ status.fullName || t('core.githubRepozitoriyProveryaetsya') }}</strong>
              <span class="pill" :class="status.connection">{{ stateLabel(status.state) }}</span>
            </div>
            <details><summary>{{ t('core.githubDannyePodklyucheniya') }}</summary><dl>
              <template v-if="status.repositoryId"><dt>{{ t('core.githubRepositoryId') }}</dt><dd>{{ status.repositoryId }}</dd></template>

              <template v-if="status.connectedAt"><dt>{{ t('settings.connected') }}</dt><dd>{{ formatTime(status.connectedAt) }}</dd></template>
            </dl></details>
            <p v-if="status.state === 'pending'" class="warn">{{ t('core.githubPrivyazkaUzheSohranenaNo') }}</p>
            <p v-if="status.cleanupPending" class="bad">{{ t('core.githubOchistkaWebhookNeZavershena') }}</p>
            <p v-if="status.reason" class="bad">{{ status.reason }}</p>
            <p v-if="!providerWritable" class="read-only" data-state="provider-read-only"> {{ t('core.githubProviderSeychasNeGotov') }} </p>
            <p v-else class="lifecycle-note"> {{ t('core.githubPodklyuchenieNeVklyuchaetOchered') }} <a href="#/inbox">{{ t('core.githubObschihVhodyaschih') }}</a>.
            </p>
            <div class="actions">
              <UiButton class="btn" :loading="busy === 'recheck'" :disabled="!!busy && busy !== 'recheck'"
                        :loading-label="t('core.githubPereproveryayu')" @click="recheck">{{ t('settings.recheck') }}</UiButton>
              <UiButton class="btn danger" tone="danger" :loading="busy === 'disconnect'"
                        :disabled="!!busy && busy !== 'disconnect'" :loading-label="t('core.githubOtklyuchayu')" @click="disconnect">
                {{ status.cleanupPending ? t('core.githubPovtoritOtklyuchenie') : t('core.githubOtklyuchit') }}
              </UiButton>
            </div>
          </div>
        </section>

        <section class="card rules-card">
          <h2>{{ t('core.githubRazreshennyeIstochnikiInbox') }}</h2>
          <p v-if="!verified" class="hint">{{ t('core.githubSnachalaPodklyuchiteIProverte') }} </p>
          <UiLoadingState v-else-if="!rulesLoaded" :label="t('core.githubZagruzhayuPravilo')" variant="inline" />
          <template v-else-if="!rules.length && !editingRule">
            <div class="empty-allowlist" data-state="empty-allowlist">
              <strong>{{ t('core.githubAllowlistPust') }}</strong>
              <p>{{ t('core.githubIssuesEtogoRepozitoriyaNe') }}</p>
            </div>
            <UiButton class="btn accent" tone="accent" :disabled="!providerWritable || !!busy"
                      @click="editingRule = true">{{ t('core.githubDopustitVInbox') }}</UiButton>
          </template>
          <form v-else class="form" @submit.prevent="saveRules([rulePayload()])">
            <p v-if="!providerWritable" class="read-only"> {{ t('core.githubPraviloPokazanoBezPrava') }} </p>
            <UiField :label="t('core.taskEditProject')" required><UiInput v-model="ruleForm.project" name="project" :placeholder="'grigdesk'"
                     :disabled="!providerWritable || !!busy" /></UiField>
            <UiField :label="t('core.githubTip')">
              <UiSelect v-model="ruleForm.kind" name="kind" :disabled="!providerWritable || !!busy"><option value="bug">{{ t('core.error') }}</option><option value="wish">{{ t('core.githubPozhelanie') }}</option></UiSelect>
            </UiField>
            <details>
              <summary>{{ t('core.githubPolyaZadachiBitriks24Neobyazatelno') }}</summary>
              <div class="b24-grid">
                <UiField :label="t('core.githubResponsibleId')" :error="validOptionalId(ruleForm.responsibleId) ? '' : t('core.githubNuzhnoPolozhitelnoeTseloeChislo')">
                  <UiInput v-model="ruleForm.responsibleId" inputmode="numeric" name="responsibleId" :disabled="!providerWritable || !!busy" />
                </UiField>
                <UiField :label="t('core.githubGroupId')" :error="validOptionalId(ruleForm.groupId) ? '' : t('core.githubNuzhnoPolozhitelnoeTseloeChislo')">
                  <UiInput v-model="ruleForm.groupId" inputmode="numeric" name="groupId" :disabled="!providerWritable || !!busy" />
                </UiField>
                <UiField :label="t('core.taskEditPriority')">
                  <UiSelect v-model.number="ruleForm.priority" name="priority" :disabled="!providerWritable || !!busy"><option :value="0">0</option><option :value="1">1</option><option :value="2">2</option></UiSelect>
                </UiField>
              </div>
            </details>
            <div v-if="rules.length" class="agent-search-policy">
              <UiCheckbox class="check-row" name="agentSearch" :checked="agentSearchKnown && agentSearch"
                          :disabled="!providerWritable || !agentSearchKnown || !policyFingerprint || !!busy"
                          @change="changeAgentSearch">{{ t('core.githubRazreshitPoiskCodingAgentam') }}</UiCheckbox>
              <p class="hint"> {{ t('core.githubEtoOptInBuduschego') }} </p>
              <p v-if="!agentSearchKnown" class="warn" data-state="agent-search-unknown"> {{ t('core.githubSostoyanieDostupaNePodtverzhdeno') }} </p>
            </div>
            <p class="hint">{{ t('core.githubNovoePraviloNeVklyuchaet') }}</p>
            <div class="actions">
              <UiButton class="btn accent" type="submit" tone="accent" :loading="busy === 'rules'"
                        :disabled="!providerWritable || !validRule || (!!busy && busy !== 'rules')"
                        :loading-label="t('core.githubSohranyayu')">{{ t('core.save') }}</UiButton>
              <UiButton v-if="rules.length" class="btn danger" tone="danger" :disabled="!providerWritable || !!busy" @click="removeRule">{{ t('core.githubUbratIzInbox') }}</UiButton>
              <UiButton v-else class="btn" @click="editingRule = false">{{ t('core.cancel') }}</UiButton>
            </div>
          </form>
        </section>
      </div>
    </template>
    </div>
  </UiWorkspacePage>
</template>

<script setup lang="ts">
import GitHubLoading from './GitHubLoading.vue';

import { computed, onMounted, reactive, ref } from 'vue';

import { errorMessage } from '../../../shared/lib/errors.ts';

import { githubApi, githubPluginDisabled } from '../shared/githubApi.ts';
import type {
  GitHubPolicy,
  GitHubRule,
  GitHubRuleAutoTask,
  GitHubRuleInput,
  GitHubStatus,
} from '../../../shared/inbox/githubContracts.ts';
import {
  UiButton, UiCheckbox, UiField, UiInput, UiIconButton, UiWorkspacePage, UiRefreshIcon,
  UiPasswordInput, UiSelect, confirmDialog, UiLoadingState, t, messageRef, uiLocale
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
      error.value = errorMessage(err, t('core.coreNeUdalosProchitatSostoyanie'));
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
    notice.value = t('core.coreRepozitoriyProverenOzhidayuSigned');
    await load();
  } catch (err) {
    error.value = errorMessage(err, t('core.coreGithubNePrinyalPodklyuchenie'));
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
    notice.value = t('core.coreSostoyanieGithubPereprovereno');
    await load();
  } catch (err) {
    error.value = errorMessage(err, t('core.corePereproverkaGithubNeVypolnena'));
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
    messageRef('core.githubOtklyuchitGithubWebhookBudet'),
    { okText: t('core.githubOtklyuchit') },
  );

  if (!confirmed) {
    return;
  }

  busy.value = 'disconnect';
  error.value = '';

  try {
    await githubApi.disconnect();
    notice.value = t('core.coreGithubOtklyuchen');
    await load();
  } catch (err) {
    error.value = errorMessage(err, t('core.coreOtklyuchenieGithubNeZaversheno'));
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
    notice.value =
   nextRules.length ? t('core.coreRepozitoriyDopuschenVInbox') : t('core.coreAllowlistGithubPust');
    await loadRules();
  } catch (err) {
    error.value = errorMessage(err, t('core.corePraviloGithubNeSohraneno'));
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
    messageRef('core.githubRazreshitCodingAgentamVybrannogo'),
    { okText: t('core.githubRazreshitAgentam') },
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
      ? t('core.corePoiskPoGithubIssues')
      : t('core.corePoiskPoGithubIssues2');
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
  const mutationMessage = errorMessage(failure, t('core.coreOtvetIzmeneniyaDostupaNe'));

  try {
    await readRulesSnapshot();
    rulesLoaded.value = true;

    if (!agentSearchKnown.value) {
      throw new Error(t('core.githubServerNeVernulDostovernyy'));
    }

    const actual = agentSearch.value;

    if (actual === enabled) {
      error.value = '';
      notice.value = t('core.corePovtornayaProverkaPodtverdilaPoisk', {
        actual: actual ? t('core.coreRazreshen') : t('core.routeZakryt'),
      });

      return;
    }

    notice.value = '';
    error.value = t('core.coreMutationmessagePovtornayaProverkaPodtverdila3', {
      mutationMessage: mutationMessage,
      actual: actual ? t('core.coreRazreshen') : t('core.routeZakryt'),
      enabled: enabled ? t('core.coreVklyuchenie') : t('core.coreVyklyuchenie'),
    });
  } catch (refreshError) {
    // Нельзя позволить повторный CAS со старым отпечатком и нельзя показывать
    // прежний boolean как достоверное состояние после ambiguous commit.
    policyFingerprint.value = '';
    agentSearchKnown.value = false;
    agentSearch.value = false;
    rulesLoaded.value = true;
    notice.value = '';
    error.value = t('core.coreMutationmessageSostoyanieDostupaNe', {
      mutationMessage: mutationMessage,
      errorMessagerefreshError: errorMessage(refreshError, t('core.corePravilaNeUdalosPerechitat')),
    });
  }
}

async function removeRule(): Promise<void> {
  const confirmed = providerWritable.value && await confirmDialog(
    messageRef('core.githubUbratRepozitoriyIzAllowlist'),
    { okText: t('settings.remove') },
  );

  if (confirmed) {
    await saveRules([]);
  }
}

function formatTime(value: number): string {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(uiLocale.value);
}

function stateLabel(value: GitHubStatus['state']): string {
  return ({
    pending: t('core.coreOzhidaetWebhookPing'),
    connected: t('settings.connected'),
    cleanup_pending: t('core.coreOchistkaNeZavershena'),
  })[String(value)] || t('core.trackerNone');
}

onMounted(load);
</script>

<style scoped>
.github-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.grid { max-width: 1100px; }

.grid { display: grid; grid-template-columns: minmax(300px, 1fr) minmax(340px, 1fr); gap: 14px; }.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); padding: 18px; }.card h2 { margin: 0 0 13px; font-size: 17px; }
.form { display: grid; gap: 11px; }
.connection-head, .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }.connection-head { justify-content: space-between; }.pill { border-radius: 999px; background: var(--surface-2); padding: 3px 8px; font-size: 12px; }.pill.connected, .good { color: var(--good); }.pill.degraded, .bad, .read-only { color: var(--bad); }.pill.connecting, .warn { color: var(--warn); }.lifecycle-note { color: var(--ink-mid); }.lifecycle-note a { color: var(--accent); }
dl { display: grid; grid-template-columns: auto 1fr; gap: 5px 12px; }dt { color: var(--ink-mid); }dd { margin: 0; overflow-wrap: anywhere; }.actions { margin-top: 13px; }
.banner { padding: 10px 13px; border: 1px solid currentColor; border-radius: 9px; }.empty-allowlist { padding: 13px; margin-bottom: 12px; border: 1px dashed var(--warn); border-radius: 9px; }.empty-allowlist p { margin-bottom: 0; color: var(--ink-mid); }details { border-top: 1px solid var(--line); padding-top: 9px; }summary { cursor: pointer; }.b24-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 9px; }
.agent-search-policy { border-top: 1px solid var(--line); padding-top: 10px; }.check-row { justify-self: start; }
@media (max-width: 760px) { .grid { grid-template-columns: 1fr; }.b24-grid { grid-template-columns: 1fr; } }
</style>
