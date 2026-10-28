import { createHash } from 'node:crypto';
import { canonicalJson } from '../lib/canonicalJson.ts';

export const GLM_GATE_REVISION = 'grigdesk-glm-gate-v1';
export const GLM_GATE_LIMIT = 16384;
export const GLM_SESSION_EVENTS = [
  'grigdesk/glm-ready',
  'grigdesk/glm-policy',
  'grigdesk/glm-policy-error',
  'grigdesk/glm-delegation',
] as const;

export interface GlmGateBinding {
  format: 1;
  consumer: 'chat';
  launchId: string;
  policyHash: string;
  sessionId: string;
  agentId: string;
  turn: number;
  callId: string;
  name: string;
  sha256: string;
}
export interface GlmGateProof extends GlmGateBinding {
  decision: 'allow' | 'deny';
  kind: string;
  reason: string;
}

const BINDING_KEYS = [
  'format', 'consumer', 'launchId', 'policyHash', 'sessionId', 'agentId', 'turn', 'callId', 'name', 'sha256',
] as const;
const PROOF_KEYS = [...BINDING_KEYS, 'decision', 'kind', 'reason'].sort();
/**
 * Runtime, helper и сервер хэшируют аргументы одной канонизацией.
 * Порядок ключей не влияет на разрешение, порядок элементов массива влияет.
 */
export function glmGateHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
/**
 * Проверяет точную привязку без преобразования типов и неизвестных полей.
 * Подтверждение другого запуска, сессии или вызова не получает повторного действия.
 */
export function parseGlmGateBinding(value: unknown): GlmGateBinding {
  const raw = value as Record<string, unknown> | null;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).sort().join(',') !== [...BINDING_KEYS].sort().join(',')
    || raw.format !== 1 || raw.consumer !== 'chat'
    || !Number.isSafeInteger(raw.turn) || Number(raw.turn) < 0 || Object.is(raw.turn, -0)
    || BINDING_KEYS.filter((key) => key !== 'format' && key !== 'turn')
      .some((key) => typeof raw[key] !== 'string' || !raw[key])
    || !/^[a-f0-9]{64}$/u.test(String(raw.sha256))
    || !/^[a-f0-9]{64}$/u.test(String(raw.policyHash))) {
    throw new TypeError('Повреждена привязка native gate GLM');
  }

  return raw as unknown as GlmGateBinding;
}
/**
 * Принимает один небольшой JSON-документ от helper с полным совпадением binding.
 * Вывод shell или старый журнал не могут заменить подтверждение текущего execution.
 */
export function parseGlmGateProof(body: string, expected: GlmGateBinding): GlmGateProof {
  if (Buffer.byteLength(body, 'utf8') > GLM_GATE_LIMIT) {
    throw new TypeError('Дескриптор native gate GLM превышает предел');
  }

  const value = JSON.parse(body) as GlmGateProof | null;
  // Helper пишет компактный JSON; обратная сериализация исключает повтор ключей
  // и неоднозначные escape/числа, которые JSON.parse иначе незаметно нормализует.
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(value) !== body.trim()
    || Object.keys(value).sort().join(',') !== PROOF_KEYS.join(',')
    || !['allow', 'deny'].includes(value.decision)
    || typeof value.kind !== 'string' || typeof value.reason !== 'string') {
    throw new TypeError('Повреждён дескриптор native gate GLM');
  }

  const binding = Object.fromEntries(BINDING_KEYS.map((key) => [key, value[key]]));

  parseGlmGateBinding(binding);

  if (BINDING_KEYS.some((key) => value[key] !== expected[key])) {
    throw new TypeError('Дескриптор native gate GLM относится к другому вызову');
  }

  return value;
}
