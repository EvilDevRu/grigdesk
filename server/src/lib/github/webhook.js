// Чистая граница GitHub webhook: raw bytes сначала проходят HMAC, и только потом
// становятся JSON. Здесь нет HTTP/Fastify и нет записи в архив.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';

export const GITHUB_WEBHOOK_BODY_LIMIT = 1024 * 1024;

const DELIVERY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SIGNATURE_RE = /^sha256=([0-9a-f]{64})$/u;
const DECIMAL_RE = /^[1-9]\d*$/u;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export class GitHubWebhookError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'GitHubWebhookError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function fail(code, message, extra = {}) {
  throw new GitHubWebhookError(code, message, extra);
}

function rawBytes(rawBody) {
  if (!Buffer.isBuffer(rawBody) && !(rawBody instanceof Uint8Array)) {
    fail('github_raw_body_required', 'GitHub webhook должен проверяться по исходным байтам.');
  }
  return Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
}

function secretBytes(secret) {
  if (typeof secret !== 'string' || !secret || /[\u0000\r\n]/u.test(secret)) {
    fail('github_webhook_secret_invalid', 'Webhook secret не задан или некорректен.');
  }
  return Buffer.from(secret, 'utf8');
}

function singleHeader(headers, wanted) {
  let value = null;
  if (headers?.get && typeof headers.get === 'function') {
    value = headers.get(wanted);
  } else if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    const match = Object.entries(headers)
      .filter(([name]) => name.toLowerCase() === wanted)
      .map(([, found]) => found);
    if (match.length > 1) fail('github_header_ambiguous', `Заголовок ${wanted} повторён.`);
    [value = null] = match;
  }

  if (Array.isArray(value)) {
    if (value.length !== 1) fail('github_header_ambiguous', `Заголовок ${wanted} повторён.`);
    [value] = value;
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.includes(',')) {
    fail('github_header_ambiguous', `Заголовок ${wanted} пуст или неоднозначен.`);
  }
  return normalized;
}

function requiredHeader(headers, name) {
  const value = singleHeader(headers, name);
  if (value === null) fail('github_header_missing', `Нет обязательного заголовка ${name}.`, { header: name });
  return value;
}

function expectedDecimal(value, label) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!DECIMAL_RE.test(text)) {
    fail('github_expected_identity_invalid', `${label} должен быть положительным целым.`);
  }
  return text;
}

function payloadDecimal(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('github_payload_invalid', `${label} в GitHub payload некорректен.`);
  }
  return String(value);
}

/**
 * HMAC-SHA256 по точным raw bytes. Неверная форма подписи тоже даёт `false`,
 * а не сравнение строк переменной длительности.
 */
export function verifyGitHubWebhookSignature(rawBody, signature, secret) {
  const bytes = rawBytes(rawBody);
  const key = secretBytes(secret);
  if (typeof signature !== 'string') return false;
  const match = SIGNATURE_RE.exec(signature);
  if (!match) return false;
  const supplied = Buffer.from(match[1], 'hex');
  const expected = createHmac('sha256', key).update(bytes).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/**
 * Проверяет provider headers без I/O. Target ID обязателен отдельно от payload:
 * одна подпись не должна разрешать hook другого repository той же integration.
 */
export function validateGitHubWebhookHeaders(headers, {
  expectedEvent = 'issues',
  expectedHookId,
  expectedRepositoryId,
} = {}) {
  const event = requiredHeader(headers, 'x-github-event');
  if (event !== expectedEvent) {
    fail('github_event_mismatch', `Ожидалось событие ${expectedEvent}, получено ${event}.`, { event });
  }

  const deliveryId = requiredHeader(headers, 'x-github-delivery');
  if (!DELIVERY_RE.test(deliveryId)) {
    fail('github_delivery_invalid', 'X-GitHub-Delivery не является корректным GUID.');
  }

  const hookId = requiredHeader(headers, 'x-github-hook-id');
  if (!DECIMAL_RE.test(hookId)) fail('github_hook_invalid', 'X-GitHub-Hook-ID некорректен.');
  const trustedHookId = expectedDecimal(expectedHookId, 'expectedHookId');
  if (hookId !== trustedHookId) {
    fail('github_hook_mismatch', 'Webhook пришёл не от текущего GitHub hook.', { hookId });
  }

  const targetType = requiredHeader(headers, 'x-github-hook-installation-target-type');
  if (targetType !== 'repository') {
    fail('github_target_mismatch', 'GitHub webhook адресован не repository.', { targetType });
  }

  const targetId = requiredHeader(headers, 'x-github-hook-installation-target-id');
  if (!DECIMAL_RE.test(targetId)) fail('github_target_invalid', 'Target ID GitHub webhook некорректен.');
  const trustedRepositoryId = expectedDecimal(expectedRepositoryId, 'expectedRepositoryId');
  if (targetId !== trustedRepositoryId) {
    fail('github_repository_mismatch', 'GitHub webhook адресован другому repository.', { targetId });
  }

  return {
    event,
    deliveryId: deliveryId.toLowerCase(),
    hookId,
    repositoryId: trustedRepositoryId,
  };
}

/** Проверяет только семантику payload `issues/opened` и immutable repository ID. */
export function validateOpenedIssuePayload(payload, { expectedRepositoryId } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('github_payload_invalid', 'GitHub webhook payload должен быть объектом.');
  }
  if (payload.action !== 'opened') {
    fail('github_action_ignored', 'GitHub payload не является issues/opened.', { action: payload.action ?? null });
  }
  if (!payload.repository || typeof payload.repository !== 'object' || Array.isArray(payload.repository)) {
    fail('github_payload_invalid', 'В GitHub payload нет repository.');
  }
  const repositoryId = payloadDecimal(payload.repository.id, 'repository.id');
  const trustedRepositoryId = expectedDecimal(expectedRepositoryId, 'expectedRepositoryId');
  if (repositoryId !== trustedRepositoryId) {
    fail('github_repository_mismatch', 'GitHub payload относится к другому repository.', { repositoryId });
  }
  if (!payload.issue || typeof payload.issue !== 'object' || Array.isArray(payload.issue)) {
    fail('github_payload_invalid', 'В GitHub payload нет issue.');
  }
  if (Object.hasOwn(payload.issue, 'pull_request')) {
    fail('github_pull_request_ignored', 'Pull request не входит в канал GitHub Issues v1.');
  }
  const issueId = payloadDecimal(payload.issue.id, 'issue.id');
  return { action: 'opened', repositoryId, issueId };
}

/**
 * Проверяет подпись и только затем декодирует JSON. Остальные provider checks
 * оставлены отдельными pure-функциями, чтобы ping и issues использовали одну границу.
 */
export function parseVerifiedGitHubWebhook(rawBody, {
  headers,
  secret,
  maxBodyBytes = GITHUB_WEBHOOK_BODY_LIMIT,
} = {}) {
  const bytes = rawBytes(rawBody);
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    fail('github_body_limit_invalid', 'Предел GitHub webhook body некорректен.');
  }
  if (bytes.length > maxBodyBytes) {
    fail('github_body_too_large', `GitHub webhook больше допустимых ${maxBodyBytes} байт.`, {
      limit: maxBodyBytes,
    });
  }

  const signature = requiredHeader(headers, 'x-hub-signature-256');
  if (!verifyGitHubWebhookSignature(bytes, signature, secret)) {
    fail('github_signature_invalid', 'Подпись GitHub webhook не совпала.');
  }

  let payload;
  try {
    payload = JSON.parse(UTF8.decode(bytes));
  } catch {
    fail('github_json_invalid', 'GitHub webhook содержит невалидный UTF-8 или JSON.');
  }
  return {
    payload,
    rawSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** Полная pure-проверка единственного принимаемого data event v1. */
export function parseOpenedIssueWebhook(rawBody, {
  headers,
  secret,
  expectedHookId,
  expectedRepositoryId,
  maxBodyBytes = GITHUB_WEBHOOK_BODY_LIMIT,
} = {}) {
  const parsed = parseVerifiedGitHubWebhook(rawBody, { headers, secret, maxBodyBytes });
  const envelope = validateGitHubWebhookHeaders(headers, {
    expectedEvent: 'issues',
    expectedHookId,
    expectedRepositoryId,
  });
  const issue = validateOpenedIssuePayload(parsed.payload, { expectedRepositoryId });
  return { ...envelope, ...issue, payload: parsed.payload, rawSha256: parsed.rawSha256 };
}
