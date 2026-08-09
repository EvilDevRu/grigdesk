// Activation marker GitHub Issues: локальная последовательность защищает от записи
// после boundary, provider occurrence time — от поздней redelivery старого issue.

export class GitHubActivationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GitHubActivationError';
    this.code = code;
  }
}

const fail = (message) => {
  throw new GitHubActivationError('github_activation_invalid', message);
};

const exactObject = (value, keys, where) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${where}: ожидался объект.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${where}: поля не совпадают с GitHub activation marker v1.`);
  }
};

const nonNegativeInt = (value, where) => {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${where}: ожидалось неотрицательное целое.`);
  return value;
};

/** Channel-specific codec для InboxStateStore. */
export const githubActivationCodec = Object.freeze({
  encode(marker) {
    exactObject(marker, ['schema', 'afterSeq', 'afterOccurredAt'], 'GitHub marker');
    if (marker.schema !== 1) fail('GitHub marker: поддерживается только schema 1.');
    return {
      schema: 1,
      afterSeq: nonNegativeInt(marker.afterSeq, 'GitHub marker.afterSeq'),
      afterOccurredAt: nonNegativeInt(marker.afterOccurredAt, 'GitHub marker.afterOccurredAt'),
    };
  },
  decode(persisted) {
    // Одинаковая strict-нормализация в обе стороны даёт canonical round-trip.
    return this.encode(persisted);
  },
});

/** Снимок границы после обязательной reconciliation до текущего head. */
export function githubActivationMarker({ afterSeq, nowMs = Date.now() } = {}) {
  nonNegativeInt(nowMs, 'nowMs');
  return githubActivationCodec.encode({
    schema: 1,
    afterSeq: nonNegativeInt(afterSeq, 'afterSeq'),
    afterOccurredAt: Math.floor(nowMs / 1000),
  });
}

function rowPosition(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('GitHub archive row некорректна.');
  return {
    seq: nonNegativeInt(row.seq, 'row.seq'),
    occurredAt: nonNegativeInt(row.occurredAt, 'row.occurredAt'),
  };
}

/**
 * Возвращает epoch, в которую одновременно попали local seq и issue.created_at.
 * Равенство start boundary считается history; строка после закрывающего marker — gap.
 */
export function githubActivationEpochFor(row, windows) {
  const position = rowPosition(row);
  if (!Array.isArray(windows)) fail('activationWindows должен быть массивом.');
  let matched = null;
  for (const [index, window] of windows.entries()) {
    exactObject(window, ['epoch', 'startMarker', 'endMarker'], `activationWindows[${index}]`);
    if (!Number.isSafeInteger(window.epoch) || window.epoch !== index + 1) {
      fail(`activationWindows[${index}].epoch должен идти с 1 без дыр.`);
    }
    const start = githubActivationCodec.decode(window.startMarker);
    const end = window.endMarker === null ? null : githubActivationCodec.decode(window.endMarker);
    const afterStart = position.seq > start.afterSeq
      && position.occurredAt > start.afterOccurredAt;
    const throughEnd = end === null || (
      position.seq <= end.afterSeq && position.occurredAt <= end.afterOccurredAt
    );
    if (!afterStart || !throughEnd) continue;
    if (matched !== null) fail('GitHub row неоднозначно попала в пересекающиеся activation windows.');
    matched = window.epoch;
  }
  return matched;
}

/** GitHub v1: один issue всегда является одной атомарной связкой. */
export function githubIssueBundleKey(message) {
  if (!message || message.channel !== 'github' || typeof message.id !== 'string' || !message.id) {
    fail('GitHub grouping получил невалидное InboxMessage.');
  }
  return { kind: 'issue', id: message.id };
}
