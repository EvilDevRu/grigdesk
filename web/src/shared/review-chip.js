// Чип ревью показывает количество PR, а не количество комментариев. Сервер присылает
// готовую сводку, но reducer остаётся и на клиенте: он нужен для первого снимка, тестов
// контракта и безопасного фолбэка во время поэтапной выкладки сервера и фронта.
import { mdToHtml } from './md.js';

const TONE_PRIORITY = Object.freeze({ blue: 1, yellow: 2, red: 3 });

const RED_STATES = new Set([
  'error', 'failed', 'failure', 'analysis_failed', 'translation_failed',
  'stale', 'outdated', 'interrupted', 'blocked',
]);
const YELLOW_STATES = new Set([
  'decision', 'needs-decision', 'needs_decision', 'human', 'waiting', 'approval',
  'needs-approval', 'needs_approval', 'product-decision', 'product_decision',
  'decision-required', 'decision_required',
]);
const BLUE_STATES = new Set([
  'blue', 'new', 'unread', 'pending', 'queued', 'running', 'analyzing', 'ready',
]);

function asState(value) {
  if (value && typeof value === 'object') {
    return String(
      value.state || value.status || value.tone || value.kind || value.action || value.decision || '',
    ).toLowerCase();
  }
  return String(value || '').toLowerCase();
}

/** Приводит серверное или вычисленное имя цвета к трём состояниям интерфейса. */
export function normalizeReviewTone(value) {
  const state = asState(value);
  if (state === 'red' || RED_STATES.has(state)) return 'red';
  if (state === 'yellow' || YELLOW_STATES.has(state)) return 'yellow';
  if (state === 'blue' || BLUE_STATES.has(state)) return 'blue';
  return '';
}

function strongestTone(...tones) {
  return tones
    .map(normalizeReviewTone)
    .reduce((best, tone) => ((TONE_PRIORITY[tone] || 0) > (TONE_PRIORITY[best] || 0)
      ? tone
      : best), '');
}

function valuesOf(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function remarkAttentionTone(remark) {
  if (!remark || remark.resolved || remark.outdated) return '';
  const analysisState = asState(remark.analysisStatus);
  const decision = asState(
    remark.analysis?.decisionId
      || remark.analysis?.decision
      || remark.analysis?.recommendation
      || remark.scopeAction,
  );
  if (RED_STATES.has(analysisState)) return 'red';
  if (analysisState === 'manual_required') return 'yellow';
  if (YELLOW_STATES.has(decision)) return 'yellow';
  return '';
}

/**
 * Возвращает самый важный цвет внимания для одного PR.
 * `attention` — главный серверный источник; остальные поля нужны как совместимый фолбэк.
 */
export function reviewPullTone(pull) {
  if (!pull || ['closed', 'merged'].includes(asState(pull.state))) return '';
  const attention = pull.attention;
  if (attention === false || attention == null) return '';
  if (typeof attention === 'object'
    && (attention.active === false
      || attention.required === false
      || attention.needsAttention === false)) return '';

  let tone = normalizeReviewTone(attention);
  if (attention === true) tone = 'blue';

  if (attention && typeof attention === 'object') {
    if (attention.failed || attention.error || attention.stale || attention.outdated) tone = 'red';
    else if (
      attention.needsDecision
      || attention.needsAnalysis
      || attention.waitingForHuman
      || attention.needsApproval
    ) {
      tone = strongestTone(tone, 'yellow');
    } else if (attention.unread || attention.isNew || attention.analyzing) {
      tone = strongestTone(tone, 'blue');
    }
    tone = strongestTone(tone, ...valuesOf(attention.reasons));
  }

  tone = strongestTone(
    tone,
    pull.run?.stale ? 'red' : '',
    pull.run?.state,
    ...(pull.remarks || []).map(remarkAttentionTone),
  );
  return tone;
}

export function reviewPullKey(pull) {
  if (pull?.id != null && String(pull.id)) return String(pull.id);
  const repo = pull?.repoKey || pull?.repoSlug || pull?.projectId || '';
  const number = pull?.number ?? '';
  return repo && number !== '' ? `${repo}#${number}` : '';
}

function pluralPr(count) {
  const n = Math.abs(Number(count)) % 100;
  const last = n % 10;
  if (n > 10 && n < 20) return 'PR требуют внимания';
  if (last === 1) return 'PR требует внимания';
  return 'PR требуют внимания';
}

/** Чистый reducer: одинаковый PR встречается в результате не больше одного раза. */
export function summarizeReviews(pulls = []) {
  const distinct = new Map();
  for (const pull of Array.isArray(pulls) ? pulls : []) {
    const key = reviewPullKey(pull);
    const tone = reviewPullTone(pull);
    if (!key || !tone) continue;
    const previous = distinct.get(key);
    if (!previous || TONE_PRIORITY[tone] > TONE_PRIORITY[previous.tone]) {
      distinct.set(key, { pull, tone });
    }
  }

  let tone = '';
  for (const row of distinct.values()) tone = strongestTone(tone, row.tone);
  const count = distinct.size;
  return {
    count,
    tone,
    title: count ? `${count} ${pluralPr(count)}` : 'Нет PR, требующих внимания',
    version: null,
  };
}

/** Нормализует серверную сводку и не пытается складывать SSE-события. */
export function normalizeReviewSummary(summary, pulls = []) {
  const fallback = summarizeReviews(pulls);
  if (!summary || typeof summary !== 'object') return fallback;
  const numeric = Number(summary.count);
  const count = Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : fallback.count;
  const tone = count ? (normalizeReviewTone(summary.tone) || fallback.tone || 'blue') : '';
  return {
    count,
    tone,
    title: String(summary.title || (count
      ? `${count} ${pluralPr(count)}`
      : 'Нет PR, требующих внимания')),
    version: summary.version ?? null,
  };
}

/** Представление сводки для уже существующих классов AppShell: blue / wait / stall. */
export function reviewChipModel(summary, pulls = []) {
  const normalized = normalizeReviewSummary(summary, pulls);
  return {
    ...normalized,
    visible: normalized.count > 0,
    label: normalized.count > 99 ? '99+' : String(normalized.count),
    kind: normalized.tone === 'red' ? 'stall' : normalized.tone === 'yellow' ? 'wait' : '',
  };
}

export function emptyReviewsSummary() {
  return {
    count: 0,
    tone: '',
    title: 'Нет PR, требующих внимания',
    version: null,
  };
}

export function normalizeReviewsSnapshot(payload) {
  const pulls = Array.isArray(payload?.pulls) ? payload.pulls : [];
  const repositories = Array.isArray(payload?.repositories) ? payload.repositories : [];
  return {
    pulls,
    summary: normalizeReviewSummary(payload?.summary, pulls),
    repositories,
  };
}

/** Какой канонический снимок запросить после SSE/reconnect. */
export function reviewRefreshTarget(eventName, fullLoaded) {
  if (!['hello', 'reviews-change'].includes(eventName)) return '';
  return fullLoaded ? 'full' : 'summary';
}

/** Общая для store и unit-теста реакция на SSE: только чтение полного снимка/сводки. */
export async function refreshReviewsFromSignal(eventName, {
  fullLoaded,
  loadFull,
  loadSummary,
}) {
  const target = reviewRefreshTarget(eventName, fullLoaded);
  if (target === 'full') {
    await loadFull();
  } else if (target === 'summary') {
    await loadSummary();
  }
  return target;
}

// И исходный GitHub-текст, и результат модели недоверенные. Экран обязан проходить через
// общий mdToHtml, чтобы правила ссылок и raw HTML не разъехались с чатами и конвейером.
export function reviewMarkdownHtml(source) {
  return mdToHtml(source);
}

const TRANSLATION_FIELDS = Object.freeze([
  {
    key: 'request',
    label: 'Что просит ревьюер',
    aliases: [
      'request', 'reviewerRequest', 'reviewer_request', 'asks',
      'whatReviewerWants', 'what_reviewer_wants',
      'requestedChange', 'requested_change', 'what',
    ],
  },
  {
    key: 'recommendation',
    label: 'Стоит ли делать',
    aliases: [
      'recommendation', 'shouldDo', 'should_do', 'verdict',
      'decisionText', 'decision_text', 'decision',
    ],
  },
  {
    key: 'reason',
    label: 'Почему',
    aliases: ['reason', 'why', 'rationale'],
  },
  {
    key: 'change',
    label: 'Что изменится',
    aliases: ['change', 'impact', 'whatChanges', 'what_changes', 'expectedChange', 'expected_change'],
  },
  {
    key: 'risks',
    label: 'Риски',
    aliases: ['risks', 'risk'],
  },
  {
    key: 'userDecision',
    label: 'Что решить',
    aliases: [
      'userDecision', 'user_decision', 'decisionNeeded', 'decision_needed',
      'whatToDecide', 'what_to_decide', 'needsDecision', 'needs_decision',
    ],
  },
]);

function readableValue(value) {
  if (Array.isArray(value)) return value.map(readableValue).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    return readableValue(value.text ?? value.label ?? value.message ?? value.summary ?? '');
  }
  return value == null ? '' : String(value).trim();
}

/** Поля карточки переводчика в фиксированном, понятном человеку порядке. */
export function reviewTranslationRows(remark) {
  const translation = remark?.translation?.fields
    || remark?.translation?.card
    || remark?.translation?.sections
    || remark?.translation
    || {};
  const analysis = remark?.analysis || {};
  return TRANSLATION_FIELDS.map((field) => {
    let value = '';
    for (const key of field.aliases) {
      value = readableValue(translation?.[key]);
      if (value) break;
    }
    // Во время поэтапной миграции технический результат лучше пустой карточки.
    if (!value && field.key === 'recommendation') {
      value = readableValue(analysis.recommendationText || analysis.recommendation || analysis.decision);
    }
    if (!value && field.key === 'reason') value = readableValue(analysis.reason || analysis.summary);
    if (!value && field.key === 'risks') value = readableValue(analysis.risks);
    return { key: field.key, label: field.label, value };
  });
}
