// Activation marker GitHub Issues: локальная последовательность защищает от записи
// после boundary, provider occurrence time — от поздней redelivery старого issue.

export class GitHubActivationError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GitHubActivationError';
    this.code = code;
  }
}

// Граница активации: локальный номер строки и время события у провайдера. Одного
// номера мало — поздняя доставка старого issue пришла бы уже после границы.
export interface GitHubActivationMarker {
  schema: 1;
  afterSeq: number;
  afterOccurredAt: number;
}

export interface GitHubActivationWindow {
  epoch: number;
  startMarker: unknown;
  endMarker: unknown;
}

export interface GitHubArchiveRow {
  seq: number;
  occurredAt: number;
}

// Явная аннотация типа обязательна: без неё TypeScript не считает вызов обрывом
// потока, и после проверки значение остаётся прежним.
const fail: (message: string) => never = (message) => {
  throw new GitHubActivationError('github_activation_invalid', message);
};

const exactObject = (value: unknown, keys: string[], where: string): void => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${where}: ожидался объект.`);
  }
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${where}: поля не совпадают с GitHub activation marker v1.`);
  }
};

const nonNegativeInt = (value: unknown, where: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${where}: ожидалось неотрицательное целое.`);
  }

  return value;
};

/** Channel-specific codec для InboxStateStore. */
export const githubActivationCodec = Object.freeze({
  encode(marker: unknown): GitHubActivationMarker {
    exactObject(marker, ['schema', 'afterSeq', 'afterOccurredAt'], 'GitHub marker');
    const value = marker as Record<string, unknown>;
    if (value.schema !== 1) fail('GitHub marker: поддерживается только schema 1.');
    return {
      schema: 1,
      afterSeq: nonNegativeInt(value.afterSeq, 'GitHub marker.afterSeq'),
      afterOccurredAt: nonNegativeInt(value.afterOccurredAt, 'GitHub marker.afterOccurredAt'),
    };
  },
  decode(persisted: unknown): GitHubActivationMarker {
    // Одинаковая strict-нормализация в обе стороны даёт canonical round-trip.
    return this.encode(persisted);
  },
});

/** Снимок границы после обязательной reconciliation до текущего head. */
export function githubActivationMarker(
  { afterSeq, nowMs = Date.now() }: { afterSeq?: unknown; nowMs?: number } = {},
): GitHubActivationMarker {
  nonNegativeInt(nowMs, 'nowMs');
  return githubActivationCodec.encode({
    schema: 1,
    afterSeq: nonNegativeInt(afterSeq, 'afterSeq'),
    afterOccurredAt: Math.floor(nowMs / 1000),
  });
}

function rowPosition(row: unknown): GitHubArchiveRow {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('GitHub archive row некорректна.');
  const value = row as Record<string, unknown>;

  return {
    seq: nonNegativeInt(value.seq, 'row.seq'),
    occurredAt: nonNegativeInt(value.occurredAt, 'row.occurredAt'),
  };
}

/**
 * Возвращает epoch, в которую одновременно попали local seq и issue.created_at.
 * Равенство start boundary считается history; строка после закрывающего marker — gap.
 */
export function githubActivationEpochFor(row: unknown, windows: unknown): number | null {
  const position = rowPosition(row);
  if (!Array.isArray(windows)) fail('activationWindows должен быть массивом.');
  let matched: number | null = null;
  for (const [index, window] of (windows as GitHubActivationWindow[]).entries()) {
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
export function githubIssueBundleKey(message: unknown): { kind: 'issue'; id: string } {
  const value = message as Record<string, unknown> | null;
  if (!value || value.channel !== 'github' || typeof value.id !== 'string' || !value.id) {
    fail('GitHub grouping получил невалидное InboxMessage.');
  }

  return { kind: 'issue', id: value.id as string };
}
