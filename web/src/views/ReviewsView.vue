<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { storeToRefs } from 'pinia';
import TopbarActions from '../shared/layout/TopbarActions.vue';
import { confirmDialog } from '../shared/ui/confirm.js';
import {
  reviewMarkdownHtml,
  reviewPullTone,
  reviewTranslationRows,
} from '../shared/review-chip.js';
import { useReviewsStore } from '../stores/reviews.js';

const reviews = useReviewsStore();
const route = useRoute();
const {
  pulls, repositories, projects, loading, syncing, error, loadedAt,
} = storeToRefs(reviews);

const projectFilter = ref(
  typeof route.query.project === 'string' && route.query.project
    ? route.query.project
    : 'all',
);
const statusFilter = ref('all');
const scopeDrafts = reactive({});
const unavailableRepositories = computed(() => (repositories.value || [])
  .filter((repository) => repository.canFix !== true));
const fixingUnavailable = computed(() => (
  (repositories.value || []).length > 0
  && unavailableRepositories.value.length === (repositories.value || []).length
));
const fixingUnavailableReason = computed(() => {
  const messages = [...new Set(unavailableRepositories.value
    .map((repository) => String(repository.configurationError?.message || '').trim())
    .filter(Boolean))];
  return messages[0] || 'Для проектов ещё не подключён изолированный Factory review executor.';
});

const STATUS_OPTIONS = [
  { value: 'all', label: 'Все состояния' },
  { value: 'attention', label: 'Требуют внимания' },
  { value: 'manual', label: 'Нужен ручной анализ' },
  { value: 'decision', label: 'Нужно решение' },
  { value: 'error', label: 'Есть ошибка' },
  { value: 'running', label: 'Исправляются' },
  { value: 'ready', label: 'Готовы к приёмке' },
];

const SCOPE_ACTIONS = [
  { value: 'fix', label: 'Исправить', hint: 'Агенту разрешено менять код' },
  { value: 'reply', label: 'Ответить', hint: 'Изменять код не нужно' },
  { value: 'skip', label: 'Пропустить', hint: 'Сохраняется осознанная причина' },
  { value: 'decision', label: 'Нужно решение', hint: 'Запуск заблокирован до твоего выбора' },
];

function stateOf(value) {
  if (value && typeof value === 'object') return String(value.state || value.status || '').toLowerCase();
  return String(value || '').toLowerCase();
}

function pullStatus(pull) {
  const tone = reviewPullTone(pull);
  const run = stateOf(pull.run);
  if (tone === 'red') return 'error';
  if (pull.attention?.needsAnalysis) return 'manual';
  if (tone === 'yellow') return 'decision';
  if (['queued', 'preparing', 'running', 'verifying', 'publishing'].includes(run)) return 'running';
  if (pull.run?.canAccept || ['ready', 'verified', 'awaiting_acceptance'].includes(run)) return 'ready';
  if (tone) return 'attention';
  return 'quiet';
}

const filteredPulls = computed(() => pulls.value.filter((pull) => {
  if (projectFilter.value !== 'all' && String(pull.projectId) !== projectFilter.value) return false;
  if (statusFilter.value === 'all') return true;
  if (statusFilter.value === 'attention') return !!reviewPullTone(pull);
  return pullStatus(pull) === statusFilter.value;
}));

function scopeKey(pull, remark) {
  return `${pull.id}:${remark.id}`;
}

function normalizedScope(value) {
  if (value && typeof value === 'object') {
    return {
      action: String(value.action || ''),
      reason: String(value.reason || ''),
      acceptance: String(value.acceptance || ''),
      allowedPaths: normalizeAllowedPaths(value.allowedPaths),
    };
  }
  return {
    action: String(value || ''),
    reason: '',
    acceptance: '',
    allowedPaths: [],
  };
}

function normalizeAllowedPaths(value) {
  const rows = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
  return rows.map((item) => String(item || '').trim()).filter(Boolean);
}

function allowedPathInvalid(value) {
  const path = String(value || '');
  const parts = path.split('/');
  return !path
    || path.startsWith('/')
    || path.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(path)
    || parts.some((part) => !part || part === '.' || part === '..');
}

function invalidAllowedPaths(paths) {
  const normalized = normalizeAllowedPaths(paths);
  return !normalized.length
    || normalized.some(allowedPathInvalid)
    || new Set(normalized).size !== normalized.length;
}

watch(pulls, (rows) => {
  for (const pull of rows) {
    for (const remark of pull.remarks || []) {
      const key = scopeKey(pull, remark);
      if (!(key in scopeDrafts)) scopeDrafts[key] = normalizedScope(remark.scopeAction);
    }
  }
}, { immediate: true, deep: false });

function draftOf(pull, remark) {
  return scopeDrafts[scopeKey(pull, remark)] || normalizedScope(remark.scopeAction);
}

function setDraft(pull, remark, patch) {
  const key = scopeKey(pull, remark);
  scopeDrafts[key] = { ...draftOf(pull, remark), ...patch };
}

function selectScopeAction(pull, remark, action) {
  const draft = draftOf(pull, remark);
  setDraft(pull, remark, {
    action,
    ...(action === 'fix' && !draft.allowedPaths.length && remark.path
      ? { allowedPaths: [String(remark.path)] }
      : {}),
  });
}

function scopeItems(pull) {
  return activeRemarks(pull)
    .map((remark) => {
      const draft = draftOf(pull, remark);
      if (!draft.action) return null;
      return {
        remarkId: remark.id,
        action: draft.action,
        ...(draft.reason.trim() ? { reason: draft.reason.trim() } : {}),
        ...(draft.acceptance.trim() ? { acceptance: draft.acceptance.trim() } : {}),
        ...(draft.action === 'fix'
          ? { allowedPaths: normalizeAllowedPaths(draft.allowedPaths) }
          : {}),
      };
    })
    .filter(Boolean);
}

function activeRemarks(pull) {
  return (pull.remarks || []).filter((remark) => !remark.resolved && !remark.outdated);
}

function invalidScope(pull) {
  const items = scopeItems(pull);
  return !items.length
    || items.length !== activeRemarks(pull).length
    || items.some((item) => (
      (item.action === 'skip' && !item.reason)
      || (item.action === 'fix' && (
        !item.acceptance
        || invalidAllowedPaths(item.allowedPaths)
      ))
    ));
}

function scopeSignature(items) {
  return JSON.stringify(items.map((item) => ({
    remarkId: String(item.remarkId),
    action: item.action,
    reason: item.reason || '',
    acceptance: item.acceptance || '',
    allowedPaths: [...(item.allowedPaths || [])].sort(),
  })).sort((a, b) => a.remarkId.localeCompare(b.remarkId)));
}

function persistedScopeItems(pull) {
  return activeRemarks(pull)
    .map((remark) => {
      const saved = normalizedScope(remark.scopeAction);
      if (!saved.action) return null;
      return {
        remarkId: remark.id,
        action: saved.action,
        ...(saved.reason.trim() ? { reason: saved.reason.trim() } : {}),
        ...(saved.acceptance.trim() ? { acceptance: saved.acceptance.trim() } : {}),
        ...(saved.action === 'fix'
          ? { allowedPaths: normalizeAllowedPaths(saved.allowedPaths) }
          : {}),
      };
    })
    .filter(Boolean);
}

function scopeDirty(pull) {
  return scopeSignature(scopeItems(pull)) !== scopeSignature(persistedScopeItems(pull));
}

function launchBlocked(pull) {
  if (pull.canRun === false
      || pull.runBlockedReason
      || invalidScope(pull)
      || scopeDirty(pull)
      || scopeLocked(pull)) return true;
  return scopeItems(pull).some((item) => item.action === 'decision');
}

function scopeLocked(pull) {
  if (!pull.run) return false;
  const raw = String(pull.run.rawState || stateOf(pull.run));
  return ![
    'failed',
    'stale',
    'published',
    'cancelled',
    'verification_failed',
    'blocked',
  ].includes(raw);
}

function runBlockedText(pull) {
  const reason = pull.runBlockedReason;
  if (!reason) return '';
  if (typeof reason === 'object') {
    return String(reason.message || reason.reason || reason.code || 'Запуск сейчас недоступен');
  }
  return String(reason);
}

async function saveScope(pull) {
  if (invalidScope(pull) || scopeLocked(pull)) return;
  try {
    await reviews.setScope(pull.id, scopeItems(pull));
    const savedPull = pulls.value.find((item) => item.id === pull.id);
    for (const remark of savedPull?.remarks || []) {
      scopeDrafts[scopeKey(savedPull, remark)] = normalizedScope(remark.scopeAction);
    }
  } catch { /* ошибка уже видна на странице */ }
}

async function syncNow() {
  try { await reviews.sync(); } catch { /* ошибка уже видна на странице */ }
}

async function markRead(pull) {
  try { await reviews.markRead(pull.id); } catch { /* ошибка уже видна на странице */ }
}

async function retryAnalysis(pull, remark) {
  try {
    await reviews.analyze(pull.id, remark.id);
  } catch { /* ошибка уже видна на странице */ }
}

async function launch(pull) {
  if (launchBlocked(pull)) return;
  const ok = await confirmDialog(
    `Запустить отдельное исправление для ${pull.repoSlug || pull.repoKey || pull.projectId} #${pull.number}?`,
    { title: 'Запустить исправление', okText: 'Запустить' },
  );
  if (!ok) return;
  try { await reviews.run(pull.id); } catch { /* серверные ворота покажут точную причину */ }
}

async function accept(pull) {
  if (!runIdOf(pull.run)) return;
  const ok = await confirmDialog(
    `Принять проверенный результат для PR #${pull.number}?`,
    { title: 'Принять результат', okText: 'Принять' },
  );
  if (!ok) return;
  try { await reviews.accept(runIdOf(pull.run)); } catch { /* ошибка уже видна на странице */ }
}

async function abandon(pull) {
  if (!runIdOf(pull.run) || !canAbandon(pull.run)) return;
  const ok = await confirmDialog(
    `Отказаться от проверенного результата для PR #${pull.number}? Этот candidate больше нельзя будет принять или опубликовать.`,
    { title: 'Отказаться от результата', okText: 'Отказаться' },
  );
  if (!ok) return;
  try { await reviews.abandon(runIdOf(pull.run)); } catch { /* ошибка уже видна на странице */ }
}

async function publish(pull) {
  if (!runIdOf(pull.run)) return;
  const ok = await confirmDialog(
    `Опубликовать принятые изменения в ветку PR #${pull.number}? Cockpit сверит SHA перед push.`,
    { title: 'Опубликовать результат', okText: 'Опубликовать' },
  );
  if (!ok) return;
  try { await reviews.publish(runIdOf(pull.run)); } catch { /* ошибка уже видна на странице */ }
}

async function reconcilePublication(pull) {
  if (!runIdOf(pull.run) || !publicationUnknown(pull.run)) return;
  try { await reviews.publish(runIdOf(pull.run)); } catch { /* ошибка уже видна на странице */ }
}

async function retryPublication(pull) {
  if (!runIdOf(pull.run) || !publicationUnknown(pull.run)) return;
  const ok = await confirmDialog(
    `Повторно отправить candidate в ветку PR #${pull.number}? Это новый push после неизвестного результата предыдущей попытки.`,
    { title: 'Повторить push', okText: 'Да, повторить push' },
  );
  if (!ok) return;
  try {
    await reviews.publish(runIdOf(pull.run), { retryUnknown: true });
  } catch { /* ошибка уже видна на странице */ }
}

async function cleanup(pull) {
  if (!runIdOf(pull.run)) return;
  const ok = await confirmDialog(
    `Удалить отдельную рабочую среду запуска для PR #${pull.number}? История и отчёт сохранятся.`,
    { title: 'Удалить рабочую среду', okText: 'Удалить' },
  );
  if (!ok) return;
  try { await reviews.cleanup(runIdOf(pull.run)); } catch { /* ошибка уже видна на странице */ }
}

function formatDate(value) {
  if (!value) return 'неизвестно';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('ru', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function remarkKind(kind) {
  return {
    review: 'Общее ревью',
    review_body: 'Общее ревью',
    thread: 'Обсуждение кода',
    inline: 'Комментарий к коду',
    comment: 'Комментарий к PR',
    issue_comment: 'Комментарий к PR',
  }[kind] || 'Замечание';
}

function statusLabel(value) {
  const state = stateOf(value);
  return {
    queued: 'В очереди',
    running: 'Анализируется',
    analyzing: 'Анализируется',
    translating: 'Переводится',
    ready: 'Разбор готов',
    completed: 'Разбор готов',
    failed: 'Не удалось разобрать',
    error: 'Не удалось разобрать',
    stale: 'Результат устарел',
    manual_required: 'Нужен ручной запуск',
    resolved: 'Обсуждение закрыто',
    outdated: 'Старая версия кода',
  }[state] || (state ? state : 'Ожидает разбора');
}

function runLabel(run) {
  if (String(run?.rawState || '') === 'publication_unknown') {
    return 'Результат публикации неизвестен';
  }
  const state = stateOf(run);
  return {
    queued: 'Ждёт запуска',
    preparing: 'Готовится отдельная среда',
    running: 'Исправляет замечания',
    verifying: 'Проверяет результат',
    ready: 'Готов к приёмке',
    verified: 'Проверки пройдены',
    awaiting_acceptance: 'Ждёт твоей приёмки',
    accepted: 'Принят, можно публиковать',
    publishing: 'Публикуется',
    published: 'Опубликован',
    failed: 'Запуск завершился ошибкой',
    stale: 'Результат устарел',
    cancelled: 'Отменён',
  }[state] || run?.label || state || 'Создан';
}

function canAccept(run) {
  return !!run?.canAccept || ['ready', 'verified', 'awaiting_acceptance'].includes(stateOf(run));
}

function canAbandon(run) {
  return ['verified', 'accepted'].includes(String(run?.rawState || stateOf(run)));
}

function acceptanceEvidenceProblem(run) {
  if (!run?.candidate?.commit || !run?.candidate?.tree) {
    return 'Нет exact commit/tree candidate.';
  }
  if (!Array.isArray(run.candidate.diff?.files)
      || !run.candidate.diff.files.length
      || !run.candidate.diff.patch) {
    return 'Нет полного списка файлов или exact patch candidate.';
  }
  if (run.candidate.diff.patchTruncated) {
    return 'Exact patch обрезан сервером.';
  }
  const report = verifyReport(run);
  if (!report?.candidateTreeDigest) return 'Нет digest доказательств VERIFY.';
  if (!verifyCommands(run).length) return 'Нет результатов VERIFY-команд.';
  if (!verifyCriteria(run).length) return 'Нет связи с критериями приёмки.';
  if (!metadataArtifacts(run).length) return 'Нет метаданных доказательств.';
  return '';
}

function canPublish(run) {
  return !!run?.canPublish
    || ['accepted', 'ready_to_publish'].includes(stateOf(run));
}

function publicationUnknown(run) {
  return !!run?.canReconcile
    || String(run?.rawState || '') === 'publication_unknown';
}

function canCleanup(run) {
  return !run?.cleanup?.status
    && ['failed', 'stale', 'published', 'verification_failed', 'blocked'].includes(
      String(run?.rawState || stateOf(run)),
    );
}

function runIdOf(run) {
  return run?.id || run?.reviewRunId || '';
}

function attentionLabel(pull) {
  const tone = reviewPullTone(pull);
  if (tone === 'red') return 'Нужно разобраться';
  if (pull.attention?.needsAnalysis) return 'Нужен ручной анализ';
  if (tone === 'yellow') return 'Ждёт твоего решения';
  if (tone === 'blue') return 'Новый разбор';
  return 'Просмотрено';
}

function hasUnread(pull) {
  const attention = pull.attention;
  return reviewPullTone(pull) === 'blue'
    || (attention && typeof attention === 'object' && (attention.unread || attention.isNew));
}

function analysisFailed(remark) {
  if (remark?.resolved || remark?.outdated) return false;
  return ['failed', 'error', 'stale', 'interrupted', 'manual_required']
    .includes(stateOf(remark.analysisStatus));
}

function translationRows(remark) {
  return reviewTranslationRows(remark);
}

function hasTranslation(remark) {
  return translationRows(remark).some((row) => row.value);
}

function safeUrl(value) {
  const url = String(value || '').trim();
  if (/^https?:\/\//i.test(url) || /^\/(?!\/)/.test(url)) return url;
  return '';
}

function artifacts(run) {
  const rows = [];
  for (const item of run?.screenshots || []) {
    const url = safeUrl(typeof item === 'string' ? item : item.url);
    if (url) rows.push({ url, label: item.label || item.name || 'Скриншот' });
  }
  for (const item of run?.artifacts || []) {
    const url = safeUrl(typeof item === 'string' ? item : item.url);
    if (url) rows.push({ url, label: item.label || item.name || 'Отчёт' });
  }
  return rows;
}

function candidateFiles(run) {
  return Array.isArray(run?.candidate?.diff?.files) ? run.candidate.diff.files : [];
}

function verifyReport(run) {
  return run?.verification?.report || run?.verify?.report || null;
}

function verifyCommands(run) {
  const report = verifyReport(run);
  return Array.isArray(report?.commands) ? report.commands : [];
}

function verifyCriteria(run) {
  const report = verifyReport(run);
  return Array.isArray(report?.criteria) ? report.criteria : [];
}

function metadataArtifacts(run) {
  const report = verifyReport(run);
  return Array.isArray(report?.artifacts) ? report.artifacts : [];
}

function candidateDigest(run) {
  const report = verifyReport(run);
  return report?.candidateTreeDigest || run?.candidate?.tree || '';
}

function metadataJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value || '');
  }
}

function commandLabel(command) {
  if (command?.command) {
    return [command.command, ...(command.args || [])].join(' ');
  }
  return command?.label || command?.id || 'Проверка';
}

function commandResult(command) {
  if (command?.effectiveOk === true) return 'достаточное доказательство';
  if (command?.effectiveOk === false) return 'проверка не принята';
  return command?.ok === true ? 'пройдена' : 'не пройдена';
}

function deltaLabel(delta) {
  return {
    'candidate-only': 'проверен только candidate',
    'unchanged-pass': 'candidate и baseline проходят',
    regression: 'новая регрессия',
    resolved: 'ошибка baseline исправлена',
    'known-failure': 'известная ошибка baseline без ухудшения',
    'changed-failure': 'ошибка изменилась — результат не принят',
    'baseline-unavailable': 'baseline недоступен',
    'not-configured': 'проверка не настроена',
  }[delta?.classification] || delta?.classification || 'дельта не вычислялась';
}

function criterionLabel(criterion) {
  return {
    passed: 'доказан',
    failed: 'не пройден',
    unchecked: 'не проверен',
    'not-required': 'не обязателен',
  }[criterion?.status] || criterion?.status || 'без результата';
}

function previousRuns(pull) {
  const currentId = runIdOf(pull.run);
  return (pull.history || []).filter((run) => runIdOf(run) !== currentId);
}

onMounted(() => {
  reviews.load().catch(() => {});
});
</script>

<template>
  <TopbarActions>
    <span v-if="loadedAt" class="updated">обновлено {{ formatDate(loadedAt) }}</span>
    <button class="top-action" :disabled="syncing" @click="syncNow">
      <span v-if="syncing" class="spin"></span>
      {{ syncing ? 'Проверяю…' : 'Проверить сейчас' }}
    </button>
  </TopbarActions>

  <div class="reviews-page">
    <section class="intro">
      <div>
        <h2>Замечания из Pull Request</h2>
        <p>
          Cockpit сам получает новые замечания и объясняет их обычным языком.
          Код можно менять только после твоего выбора, когда для Project подключён
          изолированный Factory review executor.
        </p>
      </div>
      <div class="filters" aria-label="Фильтры ревью">
        <label>
          <span>Проект</span>
          <select v-model="projectFilter">
            <option value="all">Все проекты</option>
            <option v-for="project in projects" :key="project.id" :value="project.id">
              {{ project.label }}
            </option>
          </select>
        </label>
        <label>
          <span>Состояние</span>
          <select v-model="statusFilter">
            <option v-for="option in STATUS_OPTIONS" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
      </div>
    </section>

    <div v-if="error" class="page-error" role="alert">
      <strong>Не получилось выполнить действие.</strong>
      <span>{{ error }}</span>
    </div>

    <section v-if="fixingUnavailable" class="capability-notice">
      <strong>Сейчас доступны просмотр и анализ PR</strong>
      <span>
        Автоматическое исправление пока отключено. {{ fixingUnavailableReason }}
        Настройка и состояние привязки видны в разделе
        <router-link to="/projects">«Проекты»</router-link>.
      </span>
    </section>

    <div v-if="loading && !pulls.length" class="empty">
      <span class="spin"></span>
      Получаю актуальные PR…
    </div>

    <div v-else-if="!pulls.length" class="empty">
      <strong>Открытых PR пока нет</strong>
      <span>
        Привяжи GitHub-репозитории в разделе
        <router-link to="/projects">«Проекты»</router-link>
        или запусти проверку вручную.
      </span>
    </div>

    <div v-else-if="!filteredPulls.length" class="empty">
      <strong>По этим фильтрам ничего нет</strong>
      <span>Измени проект или состояние.</span>
    </div>

    <div v-else class="pull-list">
      <article
        v-for="pull in filteredPulls"
        :key="pull.id"
        class="pull-card"
        :class="`tone-${reviewPullTone(pull) || 'quiet'}`"
      >
        <header class="pull-head">
          <div class="pull-main">
            <div class="pull-eyebrow">
              <span class="project">{{ pull.projectId }}</span>
              <span class="sep">/</span>
              <span class="repo">{{ pull.repoSlug || pull.repoKey }}</span>
              <span class="pr-number">#{{ pull.number }}</span>
            </div>
            <h3>
              <a v-if="safeUrl(pull.url)" :href="safeUrl(pull.url)" target="_blank" rel="noopener noreferrer">
                {{ pull.title }}
              </a>
              <span v-else>{{ pull.title }}</span>
            </h3>
            <div class="pull-meta">
              <span>автор: {{ pull.author || 'неизвестен' }}</span>
              <span>ветка: <code>{{ pull.headRef || '—' }}</code></span>
              <span :title="pull.headSha"><code>{{ pull.headSha?.slice(0, 9) || 'SHA неизвестен' }}</code></span>
              <span>обновлён {{ formatDate(pull.updatedAt) }}</span>
            </div>
          </div>
          <div class="pull-attention">
            <span class="attention-chip" :class="reviewPullTone(pull) || 'quiet'">
              {{ attentionLabel(pull) }}
            </span>
            <button
              v-if="hasUnread(pull)"
              class="text-action"
              :disabled="reviews.isBusy(`read:${pull.id}`)"
              @click="markRead(pull)"
            >
              Отметить прочитанным
            </button>
          </div>
        </header>

        <section class="remarks">
          <div v-if="!(pull.remarks || []).length" class="no-remarks">
            У этого PR пока нет открытых замечаний.
          </div>

          <article v-for="remark in pull.remarks || []" :key="remark.id" class="remark">
            <header class="remark-head">
              <div>
                <span class="remark-kind">{{ remarkKind(remark.kind) }}</span>
                <span class="remark-author">{{ remark.author || 'неизвестный автор' }}</span>
              </div>
              <div class="remark-place">
                <code v-if="remark.path">{{ remark.path }}<template v-if="remark.line">:{{ remark.line }}</template></code>
                <a
                  v-if="safeUrl(remark.url)"
                  :href="safeUrl(remark.url)"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Открыть в GitHub ↗
                </a>
              </div>
            </header>

            <div class="source-label">Исходное замечание</div>
            <div class="markdown source" v-html="reviewMarkdownHtml(remark.body)"></div>

            <section class="translator" :class="{ failed: analysisFailed(remark) }">
              <header>
                <div>
                  <span class="translator-name">Переводчик</span>
                  <span class="analysis-status">{{ statusLabel(remark.analysisStatus) }}</span>
                </div>
                <button
                  v-if="analysisFailed(remark)"
                  class="text-action"
                  :disabled="reviews.isBusy(`analyze:${pull.id}`)"
                  @click="retryAnalysis(pull, remark)"
                >
                  {{ stateOf(remark.analysisStatus) === 'manual_required'
                    ? 'Запустить анализ'
                    : 'Повторить анализ' }}
                </button>
              </header>

              <div v-if="remark.resolved || remark.outdated" class="analysis-message">
                {{ remark.resolved
                  ? 'Обсуждение уже закрыто — новый анализ не запускается.'
                  : 'Комментарий относится к старой версии кода — новый анализ не запускается.' }}
              </div>
              <div
                v-else-if="stateOf(remark.analysisStatus) === 'manual_required'"
                class="analysis-message"
              >
                {{ remark.autoAnalysis?.message || 'Для этого замечания нужен ручной запуск анализа.' }}
              </div>
              <div v-else-if="hasTranslation(remark)" class="translation-grid">
                <div v-for="row in translationRows(remark)" :key="row.key" class="translation-row">
                  <dt>{{ row.label }}</dt>
                  <dd
                    v-if="row.value"
                    class="markdown"
                    v-html="reviewMarkdownHtml(row.value)"
                  ></dd>
                  <dd v-else class="missing">Переводчик не заполнил это поле</dd>
                </div>
              </div>
              <div v-else-if="analysisFailed(remark)" class="analysis-message">
                Исходный комментарий сохранён. Можно повторить безопасный разбор — песочница
                и изменение кода для этого не запускаются.
              </div>
              <div v-else class="analysis-message">
                Технический анализ и понятное объяснение ещё готовятся.
              </div>
            </section>

            <section v-if="!remark.resolved && !remark.outdated" class="scope">
              <header>
                <strong>Что сделать с замечанием</strong>
                <span>Рекомендация агента — подсказка, окончательный выбор остаётся за тобой.</span>
              </header>
              <div class="scope-actions">
                <button
                  v-for="action in SCOPE_ACTIONS"
                  :key="action.value"
                  :class="{ selected: draftOf(pull, remark).action === action.value }"
                  :title="action.hint"
                  :disabled="scopeLocked(pull)"
                  @click="selectScopeAction(pull, remark, action.value)"
                >
                  {{ action.label }}
                </button>
              </div>
              <label v-if="draftOf(pull, remark).action === 'skip'" class="scope-field">
                <span>Почему пропускаем <b>обязательно</b></span>
                <textarea
                  :value="draftOf(pull, remark).reason"
                  data-scope-field="reason"
                  rows="2"
                  :disabled="scopeLocked(pull)"
                  placeholder="Причина останется в истории ревью"
                  @input="setDraft(pull, remark, { reason: $event.target.value })"
                ></textarea>
              </label>
              <label v-if="draftOf(pull, remark).action === 'fix'" class="scope-field">
                <span>Как понять, что исправление готово</span>
                <textarea
                  :value="draftOf(pull, remark).acceptance"
                  data-scope-field="acceptance"
                  rows="2"
                  :disabled="scopeLocked(pull)"
                  placeholder="Например: тест проходит, а форма сохраняет значение"
                  @input="setDraft(pull, remark, { acceptance: $event.target.value })"
                ></textarea>
              </label>
              <label v-if="draftOf(pull, remark).action === 'fix'" class="scope-field">
                <span>
                  Какие относительные файлы агенту разрешено менять
                  <b>обязательно, по одному на строку</b>
                </span>
                <textarea
                  :value="draftOf(pull, remark).allowedPaths.join('\n')"
                  data-scope-field="allowed-paths"
                  rows="3"
                  :disabled="scopeLocked(pull)"
                  placeholder="src/form.js"
                  @input="setDraft(pull, remark, {
                    allowedPaths: normalizeAllowedPaths($event.target.value),
                  })"
                ></textarea>
                <small>
                  Абсолютные пути, <code>..</code>, обратные слеши и повторяющиеся строки
                  не принимаются. Этот список задаёт точную границу записи для запуска.
                </small>
              </label>
              <div v-if="scopeLocked(pull)" class="scope-locked">
                Выбор зафиксирован активным запуском. Для другого объёма понадобится новый запуск.
              </div>
            </section>

            <div v-else class="remark-closed">
              {{ remark.resolved ? 'Обсуждение закрыто' : 'Комментарий относится к старой версии кода' }}
            </div>
          </article>
        </section>

        <section class="pull-actions">
          <div class="scope-summary">
            <strong>Объём работы</strong>
            <span v-if="runBlockedText(pull)" class="blocked-reason">
              {{ runBlockedText(pull) }}
            </span>
            <span v-else-if="scopeLocked(pull)">
              Объём работы зафиксирован активным запуском и сейчас не редактируется.
            </span>
            <span v-else-if="invalidScope(pull)">
              Выбери действие для всех замечаний. Для пропуска нужна причина,
              для исправления — критерий готовности и точный список разрешённых файлов.
            </span>
            <span v-else-if="scopeDirty(pull)">Сначала сохрани изменённый выбор.</span>
            <span v-else-if="launchBlocked(pull)">Есть пункт «Нужно решение» — запуск пока заблокирован.</span>
            <span v-else>Выбор можно сохранить и передать в отдельный запуск этого PR.</span>
          </div>
          <button
            class="secondary"
            :disabled="invalidScope(pull) || scopeLocked(pull) || reviews.isBusy(`scope:${pull.id}`)"
            @click="saveScope(pull)"
          >
            {{ reviews.isBusy(`scope:${pull.id}`) ? 'Сохраняю…' : 'Сохранить выбор' }}
          </button>
          <button
            class="primary"
            :disabled="launchBlocked(pull) || reviews.isBusy(`run:${pull.id}`)"
            @click="launch(pull)"
          >
            {{ reviews.isBusy(`run:${pull.id}`) ? 'Запускаю…' : 'Запустить исправление' }}
          </button>
        </section>

        <section v-if="pull.run" class="run-card">
          <header>
            <div>
              <span class="run-label">Отдельный запуск</span>
              <strong>{{ runLabel(pull.run) }}</strong>
            </div>
            <code v-if="runIdOf(pull.run)">{{ runIdOf(pull.run) }}</code>
          </header>
          <div class="run-meta">
            <span v-if="pull.run.branch">ветка <code>{{ pull.run.branch }}</code></span>
            <span v-if="pull.run.sandbox">песочница <code>{{ pull.run.sandbox }}</code></span>
            <span v-if="pull.run.updatedAt">обновлён {{ formatDate(pull.run.updatedAt) }}</span>
          </div>

          <section v-if="pull.run.candidate" class="candidate-evidence">
            <header class="evidence-head">
              <strong>Точный candidate для приёмки</strong>
              <span>Ниже показаны именно те Git-объекты и изменения, которые будут приняты.</span>
            </header>
            <dl class="digest-grid">
              <div>
                <dt>Commit</dt>
                <dd><code>{{ pull.run.candidate.commit || '—' }}</code></dd>
              </div>
              <div>
                <dt>Tree</dt>
                <dd><code>{{ pull.run.candidate.tree || '—' }}</code></dd>
              </div>
              <div v-if="candidateDigest(pull.run)">
                <dt>Digest доказательств</dt>
                <dd><code>{{ candidateDigest(pull.run) }}</code></dd>
              </div>
            </dl>

            <div class="evidence-block">
              <strong>Файлы candidate ({{ candidateFiles(pull.run).length }})</strong>
              <ul v-if="candidateFiles(pull.run).length" class="file-list">
                <li v-for="file in candidateFiles(pull.run)" :key="`${file.status}:${file.previousPath}:${file.path}`">
                  <code class="file-status">{{ file.status || '?' }}</code>
                  <code v-if="file.previousPath">{{ file.previousPath }} → {{ file.path }}</code>
                  <code v-else>{{ file.path }}</code>
                </li>
              </ul>
              <span v-else class="missing">Список изменённых файлов пуст.</span>
            </div>

            <div v-if="pull.run.candidate.buildEvidence?.allowedPaths?.length" class="evidence-block">
              <strong>Разрешённые человеком пути</strong>
              <ul class="file-list">
                <li
                  v-for="path in pull.run.candidate.buildEvidence.allowedPaths"
                  :key="path"
                >
                  <code>{{ path }}</code>
                </li>
              </ul>
            </div>

            <div v-if="pull.run.candidate.diff?.stat" class="evidence-block">
              <strong>Git stat</strong>
              <pre class="evidence-text">{{ pull.run.candidate.diff.stat }}</pre>
            </div>
            <div v-if="pull.run.candidate.diff?.patch" class="evidence-block">
              <strong>Exact patch</strong>
              <pre class="candidate-patch">{{ pull.run.candidate.diff.patch }}</pre>
              <span v-if="pull.run.candidate.diff.patchTruncated" class="evidence-warning">
                Сервер ограничил размер patch. Приёмка заблокирована до просмотра полной версии.
              </span>
            </div>
            <div v-if="pull.run.candidate.buildEvidence?.summary" class="evidence-block">
              <strong>Отчёт BUILD</strong>
              <pre class="evidence-text">{{ pull.run.candidate.buildEvidence.summary }}</pre>
            </div>
          </section>

          <section v-if="verifyReport(pull.run)" class="verify-evidence">
            <header class="evidence-head">
              <strong>Доказательства VERIFY</strong>
              <span>
                {{ verifyReport(pull.run).passed
                  ? 'Обязательные проверки приняты.'
                  : 'Обязательные проверки не дают права на приёмку.' }}
              </span>
            </header>

            <div v-if="verifyCommands(pull.run).length" class="evidence-block">
              <strong>Команды и сравнение с baseline</strong>
              <article
                v-for="command in verifyCommands(pull.run)"
                :key="command.id"
                class="command-result"
              >
                <header>
                  <code>{{ commandLabel(command) }}</code>
                  <span :class="{ passed: command.effectiveOk === true, failed: command.effectiveOk === false }">
                    {{ commandResult(command) }}
                  </span>
                </header>
                <div class="command-meta">
                  <span>ID: <code>{{ command.id }}</code></span>
                  <span>{{ command.required ? 'обязательная' : 'необязательная' }}</span>
                  <span>
                    baseline: {{ command.compareBaseline || command.delta?.requested ? 'да' : 'нет' }}
                  </span>
                  <span>дельта: {{ deltaLabel(command.delta) }}</span>
                  <span>candidate exit: {{ command.exitCode ?? '—' }}</span>
                  <span v-if="command.baseline?.available">
                    baseline exit: {{ command.baseline.exitCode ?? '—' }}
                  </span>
                </div>
                <details v-if="command.stdout || command.stderr" class="command-output">
                  <summary>Вывод candidate</summary>
                  <pre v-if="command.stdout">{{ command.stdout }}</pre>
                  <pre v-if="command.stderr">{{ command.stderr }}</pre>
                </details>
                <details
                  v-if="command.baseline?.stdout || command.baseline?.stderr || command.baseline?.reason"
                  class="command-output"
                >
                  <summary>Вывод baseline</summary>
                  <pre v-if="command.baseline.stdout">{{ command.baseline.stdout }}</pre>
                  <pre v-if="command.baseline.stderr">{{ command.baseline.stderr }}</pre>
                  <pre v-if="command.baseline.reason">{{ command.baseline.reason }}</pre>
                </details>
              </article>
            </div>
            <div v-else class="evidence-warning">В отчёте нет выполненных VERIFY-команд.</div>

            <div v-if="verifyCriteria(pull.run).length" class="evidence-block">
              <strong>Критерии приёмки</strong>
              <article
                v-for="criterion in verifyCriteria(pull.run)"
                :key="criterion.id"
                class="criterion-result"
              >
                <header>
                  <code>{{ criterion.id }}</code>
                  <span>{{ criterionLabel(criterion) }}</span>
                </header>
                <pre v-if="criterion.acceptanceCriterion" class="evidence-text">{{ criterion.acceptanceCriterion }}</pre>
                <p>{{ criterion.reason }}</p>
                <div class="command-meta">
                  <span>
                    Команды:
                    <code>{{ (criterion.commandIds || []).join(', ') || 'не привязаны' }}</code>
                  </span>
                  <span>
                    Diff artifacts:
                    <code>{{ (criterion.diffArtifactIds || []).join(', ') || 'не привязаны' }}</code>
                  </span>
                </div>
              </article>
            </div>

            <details v-if="metadataArtifacts(pull.run).length" class="metadata-artifacts">
              <summary>Метаданные доказательств ({{ metadataArtifacts(pull.run).length }})</summary>
              <article
                v-for="artifact in metadataArtifacts(pull.run)"
                :key="artifact.id || metadataJson(artifact)"
              >
                <strong>{{ artifact.kind || artifact.id || 'artifact' }}</strong>
                <pre>{{ metadataJson(artifact) }}</pre>
              </article>
            </details>
          </section>

          <pre
            v-if="pull.run.report || pull.run.verification?.summary"
            class="run-report evidence-text"
          >{{ pull.run.report || pull.run.verification.summary }}</pre>
          <pre v-if="pull.run.error" class="run-error">{{ metadataJson(pull.run.error) }}</pre>
          <div
            v-if="canAccept(pull.run) && acceptanceEvidenceProblem(pull.run)"
            class="evidence-warning acceptance-blocked"
          >
            Приёмка недоступна: {{ acceptanceEvidenceProblem(pull.run) }}
          </div>
          <div v-if="artifacts(pull.run).length" class="artifacts">
            <a
              v-for="item in artifacts(pull.run)"
              :key="item.url"
              :href="item.url"
              target="_blank"
              rel="noopener noreferrer"
            >
              {{ item.label }} ↗
            </a>
          </div>
          <footer>
            <button
              v-if="canAbandon(pull.run)"
              class="danger"
              :disabled="reviews.isBusy(`abandon:${runIdOf(pull.run)}`)"
              @click="abandon(pull)"
            >
              {{ reviews.isBusy(`abandon:${runIdOf(pull.run)}`)
                ? 'Отказываюсь…'
                : 'Отказаться от результата' }}
            </button>
            <button
              v-if="canCleanup(pull.run)"
              class="secondary"
              :disabled="reviews.isBusy(`cleanup:${runIdOf(pull.run)}`)"
              @click="cleanup(pull)"
            >
              {{ reviews.isBusy(`cleanup:${runIdOf(pull.run)}`)
                ? 'Удаляю среду…'
                : 'Удалить рабочую среду' }}
            </button>
            <button
              v-if="canAccept(pull.run)"
              class="secondary"
              :disabled="acceptanceEvidenceProblem(pull.run)
                || reviews.isBusy(`accept:${runIdOf(pull.run)}`)"
              :title="acceptanceEvidenceProblem(pull.run)"
              @click="accept(pull)"
            >
              {{ reviews.isBusy(`accept:${runIdOf(pull.run)}`) ? 'Принимаю…' : 'Принять результат' }}
            </button>
            <button
              v-if="publicationUnknown(pull.run)"
              class="secondary"
              :disabled="reviews.isBusy(`publish:${runIdOf(pull.run)}`)"
              @click="reconcilePublication(pull)"
            >
              {{ reviews.isBusy(`publish:${runIdOf(pull.run)}`) ? 'Сверяю…' : 'Сверить' }}
            </button>
            <button
              v-if="publicationUnknown(pull.run)"
              class="danger"
              :disabled="reviews.isBusy(`publish:${runIdOf(pull.run)}`)"
              @click="retryPublication(pull)"
            >
              {{ reviews.isBusy(`publish:${runIdOf(pull.run)}`) ? 'Проверяю…' : 'Повторить push' }}
            </button>
            <button
              v-else-if="canPublish(pull.run)"
              class="primary"
              :disabled="reviews.isBusy(`publish:${runIdOf(pull.run)}`)"
              @click="publish(pull)"
            >
              {{ reviews.isBusy(`publish:${runIdOf(pull.run)}`)
                ? 'Публикую…'
                : 'Опубликовать в PR' }}
            </button>
          </footer>
        </section>

        <details v-if="previousRuns(pull).length" class="run-history">
          <summary>История прошлых запусков ({{ previousRuns(pull).length }})</summary>
          <article v-for="run in previousRuns(pull)" :key="runIdOf(run)">
            <header>
              <div>
                <strong>{{ runLabel(run) }}</strong>
                <code>{{ runIdOf(run) }}</code>
              </div>
              <span>{{ formatDate(run.updatedAt) }}</span>
            </header>
            <dl v-if="run.candidate" class="digest-grid">
              <div>
                <dt>Commit</dt>
                <dd><code>{{ run.candidate.commit || '—' }}</code></dd>
              </div>
              <div>
                <dt>Tree</dt>
                <dd><code>{{ run.candidate.tree || '—' }}</code></dd>
              </div>
              <div v-if="candidateDigest(run)">
                <dt>Digest</dt>
                <dd><code>{{ candidateDigest(run) }}</code></dd>
              </div>
            </dl>
            <ul v-if="candidateFiles(run).length" class="file-list">
              <li v-for="file in candidateFiles(run)" :key="`${file.status}:${file.previousPath}:${file.path}`">
                <code>{{ file.status || '?' }} {{ file.previousPath ? `${file.previousPath} → ` : '' }}{{ file.path }}</code>
              </li>
            </ul>
            <pre v-if="run.candidate?.diff?.patch" class="candidate-patch">{{ run.candidate.diff.patch }}</pre>
            <pre v-if="run.report || run.verification?.summary" class="evidence-text">{{ run.report || run.verification.summary }}</pre>
          </article>
        </details>
      </article>
    </div>
  </div>
</template>

<style scoped>
.reviews-page { max-width: 1180px; margin: 0 auto; }
.intro {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 24px;
  margin-bottom: 18px;
}
.intro h2 { margin: 0; font-size: 18px; font-weight: 680; }
.intro p { margin: 5px 0 0; max-width: 680px; color: var(--ink-mid); font-size: 13px; }
.updated { color: var(--ink-mid); font-size: 11px; white-space: nowrap; }
.top-action, .pull-actions button, .run-card button {
  border: 1px solid var(--line-2); border-radius: 8px; padding: 6px 11px;
  background: var(--surface-2); color: var(--ink); cursor: pointer; font-size: 12px;
}
.top-action:disabled, button:disabled { opacity: .48; cursor: default; }

.filters { display: flex; gap: 9px; flex: none; }
.filters label { display: flex; flex-direction: column; gap: 3px; color: var(--ink-mid); font-size: 10.5px; }
.filters select {
  min-width: 160px; border: 1px solid var(--line); border-radius: 8px;
  padding: 7px 28px 7px 9px; background: var(--surface); color: var(--ink); font-size: 12px;
}

.page-error {
  display: flex; gap: 8px; align-items: baseline; margin-bottom: 14px; padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--bad) 50%, var(--line));
  border-radius: 10px; background: color-mix(in srgb, var(--bad) 9%, var(--surface));
  color: var(--bad); font-size: 12.5px;
}
.capability-notice {
  display: flex; flex-direction: column; gap: 3px; margin-bottom: 14px; padding: 11px 13px;
  border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--line));
  border-radius: 10px; background: color-mix(in srgb, var(--warn) 8%, var(--surface));
  color: var(--ink-mid); font-size: 12.5px;
}
.capability-notice strong { color: var(--ink); }
.capability-notice a { color: var(--accent); }
.empty {
  min-height: 220px; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 6px; color: var(--ink-mid); text-align: center;
}
.empty strong { color: var(--ink); font-size: 15px; }
.empty a { color: var(--accent); }
.pull-list { display: flex; flex-direction: column; gap: 16px; }
.pull-card {
  overflow: hidden; border: 1px solid var(--line); border-left-width: 3px;
  border-radius: 13px; background: var(--surface); box-shadow: var(--shadow);
}
.pull-card.tone-blue { border-left-color: var(--accent); }
.pull-card.tone-yellow { border-left-color: var(--warn); }
.pull-card.tone-red { border-left-color: var(--bad); }
.pull-card.tone-quiet { border-left-color: var(--line-2); }
.pull-head {
  display: flex; justify-content: space-between; gap: 18px; padding: 16px 18px;
  border-bottom: 1px solid var(--line);
}
.pull-main { min-width: 0; }
.pull-eyebrow { display: flex; align-items: center; gap: 5px; color: var(--ink-mid); font-size: 11px; }
.pull-eyebrow .project { color: var(--accent); }
.pull-eyebrow .pr-number { margin-left: 5px; font-family: var(--mono); color: var(--ink); }
.pull-head h3 { margin: 4px 0 6px; font-size: 16px; font-weight: 650; line-height: 1.35; }
.pull-head h3 a:hover { color: var(--accent); }
.pull-meta { display: flex; flex-wrap: wrap; gap: 5px 13px; color: var(--ink-mid); font-size: 11px; }
code { font-family: var(--mono); font-size: .94em; }
.pull-attention { display: flex; flex-direction: column; align-items: flex-end; gap: 7px; flex: none; }
.attention-chip {
  border-radius: 999px; padding: 4px 9px; background: var(--surface-2);
  color: var(--ink-mid); font-size: 10.5px; font-weight: 650;
}
.attention-chip.blue { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
.attention-chip.yellow { background: color-mix(in srgb, var(--warn) 16%, transparent); color: var(--warn); }
.attention-chip.red { background: color-mix(in srgb, var(--bad) 16%, transparent); color: var(--bad); }
.text-action {
  border: 0; padding: 0; background: none; color: var(--accent); cursor: pointer; font-size: 11px;
}
.text-action:disabled { opacity: .45; }

.remarks { padding: 0 18px; }
.remark { padding: 17px 0 19px; border-bottom: 1px solid var(--line); }
.remark:last-child { border-bottom: 0; }
.remark-head { display: flex; justify-content: space-between; gap: 14px; margin-bottom: 12px; }
.remark-kind {
  margin-right: 8px; padding: 3px 8px; border-radius: 999px;
  background: var(--surface-2); color: var(--ink); font-size: 10.5px;
}
.remark-author { color: var(--ink-mid); font-size: 11.5px; }
.remark-place { display: flex; align-items: center; gap: 10px; color: var(--ink-mid); font-size: 11px; }
.remark-place code { max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.remark-place a { color: var(--accent); }
.source-label { margin-bottom: 5px; color: var(--ink-mid); font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; }
.review-text, .evidence-text, .candidate-patch, .command-output pre,
.metadata-artifacts pre, .run-error {
  margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink);
  font: 12px/1.5 var(--mono);
}
.review-text.source {
  padding: 10px 12px; border-left: 2px solid var(--line-2); border-radius: 0 7px 7px 0;
  background: color-mix(in srgb, var(--surface-2) 55%, transparent);
}
.markdown { color: var(--ink); font-size: 13px; overflow-wrap: anywhere; }
.markdown.source {
  padding: 10px 12px; border-left: 2px solid var(--line-2); border-radius: 0 7px 7px 0;
  background: color-mix(in srgb, var(--surface-2) 55%, transparent);
}
.markdown :deep(p) { margin: 0 0 8px; }
.markdown :deep(p:last-child) { margin-bottom: 0; }
.markdown :deep(pre) { overflow: auto; padding: 9px; border-radius: 7px; background: var(--ground); }
.markdown :deep(code) { font-family: var(--mono); }
.markdown :deep(a) { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.markdown :deep(img) { max-width: 100%; border-radius: 8px; }

.translator {
  margin-top: 12px; border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line));
  border-radius: 10px; background: color-mix(in srgb, var(--accent) 5%, var(--surface-2));
}
.translator.failed { border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
.translator > header {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 9px 11px; border-bottom: 1px solid var(--line);
}
.translator-name { margin-right: 8px; color: var(--accent); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.analysis-status { color: var(--ink-mid); font-size: 11px; }
.translation-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.translation-row { margin: 0; padding: 10px 12px; border-bottom: 1px solid var(--line); }
.translation-row:nth-child(odd) { border-right: 1px solid var(--line); }
.translation-row:nth-last-child(-n + 2) { border-bottom: 0; }
.translation-row dt { margin-bottom: 3px; color: var(--ink-mid); font-size: 10.5px; }
.translation-row dd { margin: 0; }
.translation-row .missing { color: var(--ink-mid); font-size: 11.5px; font-style: italic; }
.analysis-message { padding: 11px 12px; color: var(--ink-mid); font-size: 12px; }

.scope {
  margin-top: 12px; padding: 11px 12px; border: 1px solid var(--line); border-radius: 10px;
  background: color-mix(in srgb, var(--surface-2) 55%, transparent);
}
.scope > header { display: flex; align-items: baseline; gap: 9px; margin-bottom: 9px; }
.scope > header strong { font-size: 12px; }
.scope > header span { color: var(--ink-mid); font-size: 10.5px; }
.scope-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.scope-actions button {
  border: 1px solid var(--line-2); border-radius: 7px; padding: 5px 9px;
  background: var(--surface); color: var(--ink-mid); cursor: pointer; font-size: 11px;
}
.scope-actions button:hover, .scope-actions button.selected { border-color: var(--accent); color: var(--accent); }
.scope-actions button.selected { background: color-mix(in srgb, var(--accent) 10%, var(--surface)); }
.scope-field { display: flex; flex-direction: column; gap: 4px; margin-top: 9px; color: var(--ink-mid); font-size: 10.5px; }
.scope-field b { color: var(--warn); font-weight: 600; }
.scope-field small { color: var(--ink-mid); font-size: 10px; }
.scope-field textarea {
  resize: vertical; width: 100%; border: 1px solid var(--line); border-radius: 7px;
  padding: 7px 9px; background: var(--ground); color: var(--ink); font: 12px/1.45 var(--sans);
}
.scope-locked {
  margin-top: 9px; padding: 7px 9px; border-radius: 7px;
  background: color-mix(in srgb, var(--warn) 10%, transparent);
  color: var(--warn); font-size: 10.5px;
}
.remark-closed { margin-top: 10px; color: var(--ink-mid); font-size: 11px; }
.no-remarks { padding: 20px 0; color: var(--ink-mid); text-align: center; }

.pull-actions {
  display: flex; align-items: center; gap: 8px; padding: 12px 18px;
  border-top: 1px solid var(--line); background: color-mix(in srgb, var(--surface-2) 42%, transparent);
}
.scope-summary { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.scope-summary strong { font-size: 11.5px; }
.scope-summary span { color: var(--ink-mid); font-size: 10.5px; }
.scope-summary .blocked-reason { color: var(--warn); }
.pull-actions .primary, .run-card .primary { border-color: var(--accent); background: var(--accent); color: #fff; font-weight: 600; }
.run-card .danger {
  border-color: var(--bad); background: color-mix(in srgb, var(--bad) 14%, var(--surface-2));
  color: var(--bad); font-weight: 600;
}

.run-card { margin: 0 18px 16px; padding: 12px; border: 1px solid var(--line-2); border-radius: 10px; background: var(--ground); }
.run-card > header { display: flex; justify-content: space-between; gap: 12px; }
.run-card > header > div { display: flex; flex-direction: column; }
.run-label { color: var(--ink-mid); font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
.run-card > header strong { font-size: 13px; }
.run-card > header code { color: var(--ink-mid); font-size: 10px; }
.run-meta { display: flex; flex-wrap: wrap; gap: 5px 12px; margin-top: 8px; color: var(--ink-mid); font-size: 10.5px; }
.run-report { margin-top: 9px; padding-top: 9px; border-top: 1px solid var(--line); }
.candidate-evidence, .verify-evidence {
  margin-top: 11px; padding-top: 11px; border-top: 1px solid var(--line);
}
.evidence-head { display: flex; flex-direction: column; gap: 2px; }
.evidence-head strong, .evidence-block > strong { font-size: 11.5px; }
.evidence-head span { color: var(--ink-mid); font-size: 10.5px; }
.digest-grid {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px;
  margin: 9px 0 0;
}
.digest-grid > div {
  min-width: 0; padding: 7px 8px; border: 1px solid var(--line); border-radius: 7px;
  background: var(--surface);
}
.digest-grid dt { color: var(--ink-mid); font-size: 9.5px; text-transform: uppercase; }
.digest-grid dd { margin: 2px 0 0; overflow-wrap: anywhere; font-size: 10.5px; }
.evidence-block { margin-top: 10px; }
.file-list { display: flex; flex-direction: column; gap: 3px; margin: 5px 0 0; padding: 0; list-style: none; }
.file-list li { display: flex; align-items: baseline; gap: 7px; min-width: 0; color: var(--ink); font-size: 10.5px; }
.file-list code { overflow-wrap: anywhere; }
.file-status {
  min-width: 20px; padding: 1px 4px; border-radius: 4px; background: var(--surface-2);
  color: var(--accent); text-align: center;
}
.evidence-text, .candidate-patch, .run-error {
  margin-top: 5px; padding: 8px 9px; border: 1px solid var(--line);
  border-radius: 7px; background: var(--surface); max-height: 420px; overflow: auto;
}
.candidate-patch { white-space: pre; font-size: 10.5px; }
.evidence-warning, .run-error {
  display: block; margin-top: 7px; color: var(--bad); font-size: 10.5px;
}
.command-result, .criterion-result {
  margin-top: 6px; padding: 8px 9px; border: 1px solid var(--line);
  border-radius: 8px; background: var(--surface);
}
.command-result > header, .criterion-result > header {
  display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
  font-size: 10.5px;
}
.command-result > header code, .criterion-result > header code { overflow-wrap: anywhere; }
.command-result .passed { color: var(--good); }
.command-result .failed { color: var(--bad); }
.command-meta {
  display: flex; flex-wrap: wrap; gap: 3px 10px; margin-top: 5px;
  color: var(--ink-mid); font-size: 9.5px;
}
.command-output { margin-top: 6px; color: var(--ink-mid); font-size: 10px; }
.command-output pre, .metadata-artifacts pre {
  margin-top: 5px; padding: 7px 8px; border-radius: 6px; background: var(--ground);
  max-height: 300px; overflow: auto; font-size: 10px;
}
.criterion-result p { margin: 5px 0 0; color: var(--ink-mid); font-size: 10.5px; }
.metadata-artifacts { margin-top: 10px; color: var(--ink-mid); font-size: 10.5px; }
.metadata-artifacts article {
  margin-top: 6px; padding: 7px 8px; border: 1px solid var(--line); border-radius: 7px;
}
.metadata-artifacts article > strong { color: var(--ink); font-size: 10.5px; }
.artifacts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 9px; }
.artifacts a { color: var(--accent); font-size: 11px; }
.run-card footer { display: flex; justify-content: flex-end; gap: 7px; margin-top: 10px; }
.run-history {
  margin: 0 18px 16px; padding: 10px 12px; border: 1px solid var(--line);
  border-radius: 10px; color: var(--ink-mid); font-size: 10.5px;
}
.run-history > article { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
.run-history > article > header {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;
}
.run-history > article > header > div { display: flex; flex-direction: column; gap: 2px; }
.run-history > article > header strong { color: var(--ink); font-size: 11.5px; }

@media (max-width: 800px) {
  .intro { flex-direction: column; }
  .filters { width: 100%; }
  .filters label { flex: 1; }
  .filters select { width: 100%; min-width: 0; }
  .pull-head, .remark-head { flex-direction: column; }
  .pull-attention { align-items: flex-start; }
  .translation-grid { grid-template-columns: 1fr; }
  .translation-row:nth-child(odd) { border-right: 0; }
  .translation-row:nth-last-child(2) { border-bottom: 1px solid var(--line); }
  .pull-actions { align-items: stretch; flex-direction: column; }
  .pull-actions button { width: 100%; }
  .digest-grid { grid-template-columns: 1fr; }
  .command-result > header, .criterion-result > header { flex-direction: column; gap: 3px; }
}
</style>
