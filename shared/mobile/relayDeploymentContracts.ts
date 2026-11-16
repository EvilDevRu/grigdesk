import { contractDecoders, type Decoder } from '../lib/contractDecoders.ts';

export type DeploymentState =
  | 'draft' | 'awaiting_host_key' | 'awaiting_credentials' | 'preflight'
  | 'awaiting_confirmation' | 'installing' | 'verifying' | 'ready'
  | 'awaiting_dns' | 'waiting_vpn' | 'failed' | 'interrupted' | 'recovery_required';

export interface DeploymentInput {
  requestId: string;
  expectedServerFp: string;
  mode: 'setup' | 'restore';
  name?: string;
  relayId?: string;
  ssh: {
    host: string;
    port: number;
    user: string;
  };
  public: { host: string; port: number };
  candidateHost: string;
}

export interface DeploymentJob extends DeploymentInput {
  id: string;
  revision: number;
  state: DeploymentState;
  relayId?: string;
  hostKey?: {
    challengeId?: string;
    decision: string;
    fingerprint: string;
    revision: number;
  };
  preview?: {
    digest: string;
    changes: string[];
    artifact: { version: string; digest: string };
  };
  steps: { name: string; state: 'completed' | 'failed' | 'running' }[];
  error?: { code: string };
  routeUpdateRequired?: boolean;
  service?: { state: 'pending' | 'running' | 'unknown' };
  channel?: { state: 'verified' | 'unverified'; address?: string };
}

const response = contractDecoders((path) => {
  throw new Error(`invalid_deployment:${path}`);
});

function optional<Value>(decode: Decoder<Value>): Decoder<Value | undefined> {
  return (value, path) => value == null ? undefined : decode(value, path);
}

const routeDecoder = response.objectOf({ host: response.text, port: response.wholeNumber });
const snapshotDecoder = response.objectOf({
  id: response.text,
  revision: response.wholeNumber,
  state: response.oneOf('draft', 'awaiting_host_key', 'awaiting_credentials', 'preflight',
    'awaiting_confirmation', 'installing', 'verifying', 'ready', 'awaiting_dns', 'waiting_vpn',
    'failed', 'interrupted', 'recovery_required'),
  requestId: optional(response.text),
  expectedServerFp: optional(response.text),
  mode: optional(response.oneOf('setup', 'restore')),
  name: optional(response.text),
  relayId: optional(response.text),
  ssh: optional(response.objectOf({
    host: response.text,
    port: response.wholeNumber,
    user: response.text,
  })),
  public: optional(routeDecoder),
  candidateHost: optional(response.text),
  hostKey: optional(response.objectOf({
    challengeId: optional(response.text),
    decision: response.text,
    fingerprint: response.text,
    revision: response.wholeNumber,
  })),
  preview: optional(response.objectOf({
    digest: response.text,
    changes: response.listOf(response.text),
    artifact: response.objectOf({ version: response.text, digest: response.text }),
  })),
  steps: response.listOf(response.objectOf({
    name: response.text,
    state: response.oneOf('completed', 'failed', 'running'),
  })),
  error: optional(response.objectOf({ code: response.text })),
  routeUpdateRequired: optional(response.boolean),
  service: optional(response.objectOf({ state: response.oneOf('pending', 'running', 'unknown') })),
  channel: optional(response.objectOf({
    state: response.oneOf('verified', 'unverified'),
    address: optional(response.text),
  })),
});

export type DeploymentSnapshot = ReturnType<typeof snapshotDecoder>;

/**
 * Клиенты читают полный ответ либо краткий снимок списка, не сохраняя неизвестные поля.
 * Вложенные SSH и preview также собираются по схеме: секрет не проникает в состояние клиента.
 */
export function decodeDeploymentSnapshot(value: unknown): DeploymentSnapshot {
  const envelope = response.record(value, 'deployment');

  return snapshotDecoder('job' in envelope ? envelope.job : envelope, 'deployment');
}

/**
 * Закрывает вход мастера до чтения секретов и внешних подключений.
 * Публичный маршрут телефона принимает DNS/IPv4; SSH дополнительно допускает IPv6.
 */
export function decodeDeploymentInput(value: unknown): DeploymentInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('bad_deployment_input');
  }

  const input = value as Record<string, unknown>;
  const allowed = ['requestId', 'expectedServerFp', 'mode', 'name', 'relayId',
    'ssh', 'public', 'candidateHost'];

  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new Error('bad_deployment_input');
  }

  const ssh = input.ssh as Record<string, unknown> | undefined;
  const route = input.public as Record<string, unknown> | undefined;
  const host = (raw: unknown, ipv6 = false): string => {
    if (typeof raw !== 'string' || raw.length > 253
      || !(ipv6 && /^[a-fA-F0-9:]+$/.test(raw) || /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(raw))) {
      throw new Error('bad_deployment_address');
    }

    return raw;
  };
  const port = (raw: unknown, fallback: number): number => {
    const selected = raw ?? fallback;

    if (!Number.isSafeInteger(selected) || Number(selected) < 1 || Number(selected) > 65535) {
      throw new Error('bad_deployment_port');
    }

    return Number(selected);
  };

  if (typeof input.requestId !== 'string' || !/^[\w-]{1,128}$/.test(input.requestId)
    || typeof input.expectedServerFp !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedServerFp)
    || !['setup', 'restore'].includes(String(input.mode))
    || !ssh || typeof ssh.user !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(ssh.user)
    || input.mode === 'setup' && (typeof input.name !== 'string' || !input.name.trim())
    || input.mode === 'restore' && (typeof input.relayId !== 'string'
      || !/^r[a-f0-9]{8,32}$/.test(input.relayId))) {
    throw new Error('bad_deployment_input');
  }

  const sshHost = host(ssh.host, true);

  return {
    requestId: input.requestId,
    expectedServerFp: input.expectedServerFp,
    mode: input.mode as DeploymentInput['mode'],
    ...(input.mode === 'setup' ? { name: String(input.name).trim() } : { relayId: String(input.relayId) }),
    ssh: {
      host: sshHost,
      port: port(ssh.port, 22),
      user: ssh.user,
    },
    public: { host: host(route?.host ?? sshHost), port: port(route?.port, 443) },
    candidateHost: host(input.candidateHost ?? sshHost, true),
  };
}
