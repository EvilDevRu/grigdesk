// Provider-neutral triage общего Inbox. Модель видит только normalized presentation
// fields; channel-native IDs, attachment refs и credentials в prompt не попадают.

import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

import { resolveModelRef } from '../chat/model-ref.js';
import { getExecutor } from '../executors/index.js';
import { getModelsRegistry } from '../models-registry.js';
import { inboxTranscript, INBOX_DRAFT_LIMITS } from './draft.js';

export const INBOX_TRIAGE_KINDS = Object.freeze(['bug', 'wish', 'none']);
export const INBOX_TRIAGE_LIMITS = Object.freeze({
  transcript: 24_000,
  summary: 4_000,
  reason: 2_000,
  modelSegment: 256,
  attachmentContext: 12_000,
  attachmentPaths: 24,
  attachmentBytes: 20 * 1024 * 1024,
  attachmentTotalBytes: 80 * 1024 * 1024,
});
export const INBOX_AUTO_MAX_AGE_MS = 86_400_000;

const VERDICT_KEYS = ['kind', 'confidence', 'title', 'description', 'reason'];
const KIND_HINT = Object.freeze({
  bug: 'баги и поломки',
  wish: 'идеи и пожелания',
});
const VISUAL_MEDIA_TYPES = Object.freeze(new Map([
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]));
const text = (value) => (typeof value === 'string' ? value.trim() : '');

function bounded(value, limit) {
  const result = text(value);
  if (result.length > limit || Buffer.byteLength(result, 'utf8') > limit * 4) return null;
  return result;
}

function clamp(value, limit) {
  const result = text(value);
  if (!Number.isSafeInteger(limit) || limit < 1) return '';
  if (result.length <= limit) return result;
  return `${result.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function exactVerdict(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...VERDICT_KEYS].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

export function normalizeInboxTriageModel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const provider = bounded(value.provider, INBOX_TRIAGE_LIMITS.modelSegment);
  const model = bounded(value.model, INBOX_TRIAGE_LIMITS.modelSegment);
  return provider && model ? { provider, model } : null;
}

function safeAttachmentAnalysis(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { text: '', visualPaths: [], visualOverflow: false, visualInvalid: false };
  }
  const analysisText = clamp(value.text, INBOX_TRIAGE_LIMITS.attachmentContext);
  const rawPaths = Array.isArray(value.visualPaths) ? value.visualPaths : [];
  const absolutePaths = rawPaths
    .filter((entry) => typeof entry === 'string' && path.isAbsolute(entry));
  return {
    text: analysisText,
    visualPaths: absolutePaths.slice(0, INBOX_TRIAGE_LIMITS.attachmentPaths),
    visualOverflow: absolutePaths.length > INBOX_TRIAGE_LIMITS.attachmentPaths,
    visualInvalid: absolutePaths.length !== rawPaths.length,
  };
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function hasImageSignature(bytes, mediaType) {
  if (mediaType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mediaType === 'image/png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  }
  if (mediaType === 'image/gif') {
    const signature = bytes.subarray(0, 6).toString('ascii');
    return signature === 'GIF87a' || signature === 'GIF89a';
  }
  if (mediaType === 'image/webp') {
    return bytes.length >= 12
      && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return mediaType === 'image/bmp'
    && bytes.length >= 2
    && bytes.subarray(0, 2).toString('ascii') === 'BM';
}

/**
 * Visual paths — внутренний transport анализатора, а не доступ модели к файловой
 * системе. Читаем их сервером из единственного cache root и дальше передаём адаптеру
 * только media type + base64. Ни cwd, ни writable/readable root модель не получает.
 */
export async function loadInboxVisualInputs(visualPaths, { config = {}, fsImpl = fs } = {}) {
  const paths = Array.isArray(visualPaths) ? visualPaths : [];
  if (!paths.length) return { ok: true, images: [] };
  const configuredRoot = typeof config?.mediaDir === 'string' && config.mediaDir
    ? path.join(config.mediaDir, 'inbox-attachment-analysis')
    : '';
  if (!configuredRoot) return { ok: false, error: 'invalid_attachment_path' };

  let root;
  try { root = await fsImpl.realpath(configuredRoot); } catch {
    return { ok: false, error: 'invalid_attachment_path' };
  }

  const images = [];
  let totalBytes = 0;
  for (const sourcePath of paths) {
    let resolved;
    try { resolved = await fsImpl.realpath(sourcePath); } catch {
      return { ok: false, error: 'invalid_attachment_path' };
    }
    if (!isInside(root, resolved)) return { ok: false, error: 'invalid_attachment_path' };

    const mediaType = VISUAL_MEDIA_TYPES.get(path.extname(resolved).toLowerCase());
    if (!mediaType) return { ok: false, error: 'unsupported_media' };

    let handle;
    try {
      handle = await fsImpl.open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > INBOX_TRIAGE_LIMITS.attachmentBytes) {
        return { ok: false, error: 'attachment_media_limit' };
      }
      totalBytes += stat.size;
      if (totalBytes > INBOX_TRIAGE_LIMITS.attachmentTotalBytes) {
        return { ok: false, error: 'attachment_media_limit' };
      }
      const bytes = await handle.readFile();
      if (bytes.length !== stat.size || !hasImageSignature(bytes, mediaType)) {
        return { ok: false, error: 'invalid_attachment_media' };
      }
      images.push({ mediaType, data: bytes.toString('base64') });
    } catch {
      return { ok: false, error: 'invalid_attachment_path' };
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return { ok: true, images };
}

export function buildInboxTriagePrompt(item, { attachmentAnalysis = null } = {}) {
  const label = text(item?.channelLabel) || text(item?.channel) || 'канал';
  const source = text(item?.source?.title) || 'без названия';
  const hint = KIND_HINT[item?.policy?.kind] || 'обращения пользователей';
  const transcript = inboxTranscript(item?.messages || [], {
    limit: INBOX_TRIAGE_LIMITS.transcript,
  }).text;
  const attachments = safeAttachmentAnalysis(attachmentAnalysis);
  const attachmentBlock = attachments.text
    ? ['', 'Содержимое вложений, подготовленное сервером:', attachments.text]
    : [];
  const visualBlock = attachments.visualPaths.length
    ? [
      '',
      `Вместе с запросом переданы визуальные вложения и кадры видео: ${attachments.visualPaths.length}.`,
      'Обязательно изучи сами изображения перед решением.',
    ]
    : [];
  return {
    system: [
      'Ты разбираешь обращение из рабочего канала и решаешь, нужна ли по нему задача.',
      'Ответь одним JSON-объектом без markdown и любого другого текста.',
      'Обязательные поля: kind ("bug"|"wish"|"none"), confidence (число 0..1),',
      'title (одна строка), description (только подтверждённая обращением суть),',
      'reason (одно краткое предложение с причиной решения).',
      'Ничего не додумывай. Благодарность, разговор или вопрос без задачи — kind "none".',
      'Если не уверен, снижай confidence: обращение останется человеку.',
    ].join('\n'),
    user: [
      `Канал: ${label}. Источник: ${source}.`,
      `По правилу сюда поступают: ${hint}. Это подсказка, а не готовый ответ.`,
      '',
      'Обращение:',
      transcript,
      ...attachmentBlock,
      ...visualBlock,
    ].join('\n'),
  };
}

export function parseInboxTriageVerdict(reply) {
  const source = text(reply);
  if (!source) return null;
  const candidates = [];
  const fence = source.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fence) candidates.push(fence[1]);
  const open = source.indexOf('{');
  const close = source.lastIndexOf('}');
  if (open >= 0 && close > open) candidates.push(source.slice(open, close + 1));
  candidates.push(source);

  for (const candidate of candidates) {
    let raw;
    try { raw = JSON.parse(candidate); } catch { continue; }
    if (!exactVerdict(raw) || !INBOX_TRIAGE_KINDS.includes(raw.kind)) continue;
    const title = bounded(raw.title, INBOX_DRAFT_LIMITS.title);
    const description = bounded(raw.description, INBOX_TRIAGE_LIMITS.summary);
    const reason = bounded(raw.reason, INBOX_TRIAGE_LIMITS.reason);
    if (title === null || description === null || reason === null) continue;
    const confidence = typeof raw.confidence === 'number'
      && Number.isFinite(raw.confidence)
      && raw.confidence >= 0
      && raw.confidence <= 1
      ? raw.confidence
      : 0;
    return { kind: raw.kind, confidence, title, description, reason };
  }
  return null;
}

export function decideInboxAutoAction({ item, verdict, createdToday = 0, nowMs = 0 } = {}) {
  const auto = item?.policy?.autoTask || {};
  if (!auto.enabled) return { action: 'off', reason: 'auto_disabled' };
  if (item?.status !== 'new') return { action: 'skip', reason: 'not_new' };
  if (!item?.cold) return { action: 'wait', reason: 'hot' };
  const ageMs = Math.max(0, Number(nowMs) - Number(item?.lastAt || 0) * 1000);
  if (ageMs > INBOX_AUTO_MAX_AGE_MS) return { action: 'old', reason: 'older_than_24h' };
  if (createdToday >= auto.maxPerDay) return { action: 'limit', reason: 'quota' };
  if (verdict === undefined) return { action: 'judge', reason: 'model_required' };
  if (!verdict) return { action: 'unclear', reason: 'invalid_verdict' };
  if (!INBOX_TRIAGE_KINDS.includes(verdict.kind)
      || !Number.isFinite(verdict.confidence)
      || verdict.confidence < 0
      || verdict.confidence > 1) {
    return { action: 'unclear', reason: 'invalid_verdict' };
  }
  if (verdict.confidence < auto.minConfidence) return { action: 'unsure', reason: 'low_confidence' };
  if (verdict.kind === 'none') return { action: 'dismiss', reason: verdict.reason || 'not_a_task' };
  return { action: 'create', reason: verdict.reason || 'model_task' };
}

export function countInboxAutoTasks(decisions, { scopeRef, sinceMs = 0 } = {}) {
  if (typeof scopeRef !== 'string' || !Number.isSafeInteger(sinceMs) || sinceMs < 0) return 0;
  return (Array.isArray(decisions) ? decisions : []).filter((decision) => (
    decision?.status === 'task'
    && decision?.by === 'auto'
    && decision?.scopeRef === scopeRef
    && Number.isSafeInteger(decision?.decidedAtMs)
    && decision.decidedAtMs >= sinceMs
  )).length;
}

export function inboxAutoNote({ model = '', verdict = null, reason = '' } = {}) {
  const parts = [];
  const safeModel = clamp(model, 512);
  const safeReason = clamp(reason || verdict?.reason, INBOX_TRIAGE_LIMITS.reason);
  if (safeModel) parts.push(`разбор ${safeModel}`);
  if (Number.isFinite(verdict?.confidence)) parts.push(`уверенность ${verdict.confidence}`);
  if (safeReason) parts.push(safeReason);
  return parts.join(' · ');
}

export function buildInboxAutoTask({ item, verdict } = {}) {
  const title = clamp(verdict?.title, INBOX_DRAFT_LIMITS.title)
    || clamp(item?.draft?.title, INBOX_DRAFT_LIMITS.title);
  const summary = clamp(verdict?.description, INBOX_TRIAGE_LIMITS.summary);
  const label = clamp(item?.channelLabel || item?.channel, 256) || 'канал';
  const sourceUrl = clamp(
    item?.sourceUrl || item?.draft?.source?.url,
    INBOX_DRAFT_LIMITS.sourceUrlChars,
  );
  const source = sourceUrl ? `Источник · ${label}: ${sourceUrl}` : '';
  // Обычно summary обязана сформулировать модель. Исходный transcript нужен
  // лишь как fail-safe для некорректного, но принятого verdict без description.
  const statement = summary || clamp(item?.draft?.description, INBOX_TRIAGE_LIMITS.summary);
  return {
    title,
    description: [statement, source].filter(Boolean).join('\n\n'),
  };
}

/**
 * Разрешает модель только вместе с отдельным transport для недоверенного ввода.
 * Наличие обычного coding executor.run здесь недостаточно и fallback запрещён.
 */
export async function resolveInboxTriageTarget({
  modelRef,
  config = {},
  modelsRegistry = getModelsRegistry,
  executorResolver = getExecutor,
  requireImages = false,
} = {}) {
  const ref = normalizeInboxTriageModel(modelRef);
  if (!ref) return { ok: false, error: 'no_model' };

  let registry;
  try { registry = await modelsRegistry(config); } catch {
    return { ok: false, error: 'registry_failed' };
  }
  const resolved = resolveModelRef(ref, registry);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  let executor;
  try { executor = await executorResolver(resolved.modelRef.provider); } catch {
    return { ok: false, error: 'executor_unavailable' };
  }
  if (!executor) return { ok: false, error: 'executor_unavailable' };
  if (typeof executor.runUntrusted !== 'function' || executor.untrustedInput?.text !== true) {
    return { ok: false, error: 'unsafe_model_provider' };
  }
  if (requireImages) {
    const modalities = Array.isArray(resolved.model?.inputModalities)
      ? resolved.model.inputModalities
      : [];
    if (!modalities.includes('image')
        || executor.untrustedInput?.images !== true
        || !Number.isSafeInteger(executor.untrustedInput?.maxImages)
        || executor.untrustedInput.maxImages < 1
        || !Array.isArray(executor.untrustedInput?.mediaTypes)
        || executor.untrustedInput.mediaTypes.length === 0) {
      return { ok: false, error: 'unsupported_media' };
    }
  }
  return { ok: true, ref: resolved.modelRef, model: resolved.model, executor };
}

export async function runInboxTriage({
  item,
  attachmentAnalysis = null,
  modelRef,
  config = {},
  providerSettings = {},
  modelsRegistry = getModelsRegistry,
  executorResolver = getExecutor,
  log = console,
  signal,
} = {}) {
  const analysis = safeAttachmentAnalysis(attachmentAnalysis);
  if (analysis.visualInvalid) return { ok: false, error: 'invalid_attachment_path' };
  if (analysis.visualOverflow) return { ok: false, error: 'attachment_media_limit' };
  const hasVisuals = analysis.visualPaths.length > 0;
  const target = await resolveInboxTriageTarget({
    modelRef,
    config,
    modelsRegistry,
    executorResolver,
    requireImages: hasVisuals,
  });
  if (!target.ok) return target;
  const { provider, model } = target.ref;
  const { executor } = target;
  if (hasVisuals) {
    const maxImages = Number(executor.untrustedInput?.maxImages);
    if (maxImages < analysis.visualPaths.length) {
      return { ok: false, error: 'unsupported_media' };
    }
  }
  const loaded = await loadInboxVisualInputs(analysis.visualPaths, { config });
  if (!loaded.ok) return loaded;
  if (loaded.images.some((image) => !executor.untrustedInput.mediaTypes?.includes(image.mediaType))) {
    return { ok: false, error: 'unsupported_media' };
  }
  const prompt = buildInboxTriagePrompt(item, { attachmentAnalysis: analysis });
  let output;
  try {
    output = await executor.runUntrusted({
      config,
      message: `${prompt.system}\n\n${prompt.user}`,
      model,
      images: loaded.images,
      providerSettings: providerSettings?.[provider] || {},
      log,
      signal,
    });
  } catch (error) {
    if (['attachment_media_limit', 'invalid_attachment_media', 'unsupported_media']
      .includes(error?.code)) {
      return { ok: false, error: error.code };
    }
    return { ok: false, error: 'run_failed' };
  }
  const reply = text(output?.reply);
  if (!reply) return { ok: false, error: 'empty_reply' };
  return {
    ok: true,
    verdict: parseInboxTriageVerdict(reply),
    model: `${provider}/${model}`,
  };
}
