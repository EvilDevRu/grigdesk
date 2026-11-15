import { createHash } from 'node:crypto';
import { execFile, externalCliProcessFingerprint } from '../providerInstall/externalCliProcess.ts';
import { executableIdentity, executableIdentitySync } from '../providerInstall/executableIdentity.ts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { isRecord } from '../../../../shared/lib/objects.ts';
import { settingsFingerprint as fingerprint } from '../executorSettings/fingerprint.ts';
import { isChatModeSelection } from '../../../../shared/chat/chatPermissionModes.ts';
import type { PermissionModeContext } from './index.ts';
import { ExecutorRuntimeError } from './errors.ts';
import { withSettingsStdioProbe } from '../executorSettings/probe.ts';
import { prepareOwnedProcessScope, type PreparedProcessScopeOwner }
  from '../providerInstall/ownedProcessScope.ts';

const execute = promisify(execFile);
const SCHEMA_FILES = ['ThreadStartParams', 'ThreadResumeParams', 'TurnStartParams', 'ThreadStartResponse',
  'ConfigRequirementsReadResponse', 'ConfigRequirements', 'AskForApproval', 'SandboxPolicy',
  'ApprovalsReviewer'];
const schemaCache = new Map<string, Promise<string>>();
const handles = new WeakMap<object, RuntimeState>();

interface CodexModeAdmission {
  admissionRevision: number;
  codecRevision: number;
  version: string;
  schemaFingerprint: string;
  nativePaths: readonly string[];
}

export const CODEX_MODE_ADMISSION: CodexModeAdmission = Object.freeze({
  admissionRevision: 1,
  codecRevision: 1,
  version: '0.164.0',
  schemaFingerprint: 'c1a49972d4fdb1b2a7f0869fd04c43a6100308799bd6201ca0a62ba92f635abd',
  nativePaths: Object.freeze(['code-mode/exec_command', 'code-mode/apply_patch']),
});

/**
 * Отдельный допуск Host и возврата в песочницу на проверенной установке 0.167.1.
 * Схема получена настоящим CLI; legacy-допуск 0.164.0 не объявляет Host проверенным.
 */
export const CODEX_HOST_MODE_ADMISSION: CodexModeAdmission = Object.freeze({
  admissionRevision: 1,
  codecRevision: 2,
  version: '0.167.1',
  schemaFingerprint: 'ae89726268e386a2c43092158c9876e240ae256601f5fe7717f4714e197a747e',
  nativePaths: Object.freeze(['code-mode/exec_command', 'code-mode/apply_patch']),
});

/**
 * Эффективный Host-профиль: без sandbox-границы прежние запросы её расширения не
 * возникают, поэтому never/user описан честно и не обещает проверки каждой команды.
 */
export const CODEX_HOST_PROFILE = Object.freeze({
  sandbox: 'danger-full-access',
  approvalPolicy: 'never',
  approvalsReviewer: 'user',
  enabled: true,
  reason: '',
});

/**
 * Менеджер процессов Codex переопределяется только окружением теста.
 * Значения читаются лениво при каждом вызове, продукт остаётся на системных путях.
 */
const codexScopeOptions = {
  unitPrefix: 'grigdesk-codex',
  label: 'Codex',
  unavailableCode: 'codex_host_scope_unavailable',
  systemdRunBin: () => process.env.GRIGDESK_CODEX_SYSTEMD_RUN_BIN || '/usr/bin/systemd-run',
  systemctlBin: () => process.env.GRIGDESK_CODEX_SYSTEMCTL_BIN || '/usr/bin/systemctl',
  probeBus: true,
};

const profiles = Object.freeze({
  plan: Object.freeze({
    sandbox: 'read-only',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    enabled: false,
    reason: 'Не доказана изоляция MCP, hooks, приложений и маршрута авторизации.'
  }),
  manual: Object.freeze({
    sandbox: 'read-only',
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    enabled: false,
    reason: 'Native policy не подтверждает каждый Bash при внешнем allow-rule.'
  }),
  auto: Object.freeze({
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    enabled: true,
    reason: ''
  }),
  acceptEdits: Object.freeze({
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    enabled: false,
    reason: 'Native policy допускает Bash и создание .env без отдельного подтверждения.'
  }),
  dontAsk: Object.freeze({
    sandbox: 'workspace-write',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    enabled: true,
    reason: ''
  }),
  bypassPermissions: Object.freeze({
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    enabled: false,
    reason: 'Native cleanup не отзывает отсоединённые процессы полного доступа.'
  }),
});

export type CodexPermissionMode = keyof typeof profiles;

interface CodexNativeProfile {
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy: string;
  approvalsReviewer: string;
  enabled: boolean;
  reason: string;
}

interface RuntimeState {
  bin: string;
  identity: string;
  mode: CodexPermissionMode;
  context: PermissionModeContext;
  fingerprint: string;
  requirements: string;
  nativeConfig: string;
  processFingerprint: string;
  hostAccess: boolean;
  effectiveProfile: CodexNativeProfile;
  owner: PreparedProcessScopeOwner | null;
}

/**
 * Нормализация не предоставляет разрешения: она сохраняет известный выбранный ID.
 * Контекст, admission и требования проверяются асинхронно перед рабочим spawn.
 */
export function normalizeCodexPermissionMode(value: unknown) {
  if (value === undefined || value === null || value === '') {
    return { ok: true as const, mode: 'auto' as CodexPermissionMode };
  }
  if (typeof value === 'string' && Object.hasOwn(profiles, value)) {
    return { ok: true as const, mode: value as CodexPermissionMode };
  }

  return { ok: false as const, message: 'Неизвестный режим разрешений Codex.' };
}

/**
 * Все известные профили неизменяемы; отключённый ID никогда не становится Auto.
 * Служебный workspaceAccess сохраняет свой прежний профиль отдельно от UI.
 */
export function codexModeProfile(mode: unknown, workspaceAccess?: unknown): CodexNativeProfile {
  if (workspaceAccess) {
    return Object.freeze({
      ...profiles.auto,
      approvalPolicy: 'never',
      approvalsReviewer: 'user'
    });
  }

  const normalized = normalizeCodexPermissionMode(mode);

  if (!normalized.ok) {
    throw new ExecutorRuntimeError('invalid_permission_mode', normalized.message);
  }

  const profile = profiles[normalized.mode];

  if (!profile.enabled) {
    throw new ExecutorRuntimeError('mode_unavailable', profile.reason);
  }

  return profile;
}

/**
 * Nullable managed-списки не ограничивают профиль, пустые запрещают любой выбор.
 * Ошибочный RPC и пропущенная структура не подменяются отсутствием требований.
 * Сверяется эффективный tuple: при Host это danger-full-access/never/user, а не
 * запрошенный режим меню, который общий профиль перекрывает.
 */
export function validateCodexRequirements(value: unknown, mode: CodexPermissionMode,
  effective?: CodexNativeProfile) {
  if (!isRecord(value) || !Object.hasOwn(value, 'requirements')) {
    throw new ExecutorRuntimeError('mode_unavailable', 'Codex не сообщил управляемые требования.');
  }
  if (value.requirements === null) {
    return;
  }
  if (!isRecord(value.requirements)) {
    throw new ExecutorRuntimeError('mode_unavailable', 'Некорректные управляемые требования Codex.');
  }

  const profile = effective ?? profiles[mode];
  const fields = {
    allowedApprovalPolicies: profile.approvalPolicy,
    allowedApprovalsReviewers: profile.approvalsReviewer,
    allowedSandboxModes: profile.sandbox,
  };
  const enums: Record<string, readonly string[]> = {
    allowedApprovalPolicies: ['untrusted', 'on-request', 'never'],
    allowedApprovalsReviewers: ['user', 'auto_review', 'guardian_subagent'],
    allowedSandboxModes: ['read-only', 'workspace-write', 'danger-full-access'],
  };

  for (const [key, expected] of Object.entries(fields)) {
    const list = value.requirements[key];

    if (list === null) {
      continue;
    }

    const valid = (entry: unknown) => {
      if (typeof entry === 'string') {
        return enums[key]?.includes(entry) === true;
      }

      return key === 'allowedApprovalPolicies' && isRecord(entry) && isRecord(entry.granular)
        && ['sandbox_approval', 'rules', 'skill_approval', 'request_permissions', 'mcp_elicitations']
          .every((field) => typeof (entry.granular as Record<string, unknown>)[field] === 'boolean');
    };

    if (!Array.isArray(list) || !list.every(valid)
      || !list.includes(expected)) {
      throw new ExecutorRuntimeError('mode_unavailable', 'Управляемая политика запрещает режим Codex.');
    }
  }
}

/**
 * Список меню отражает исходный admission; запуск всё равно проверяет живой runtime.
 * Полный доступ помечен как выбор только данного чата и не становится default.
 */
export function codexPermissionModes() {
  return Object.entries(profiles).filter(([, profile]) => profile.enabled).map(([id]) => ({
    id,
    label: {
      auto: 'Авто',
      dontAsk: 'Не спрашивать',
      bypassPermissions: 'Без ограничений'
    }[id],
    labelKey: `core.codexMode${id.slice(0, 1).toUpperCase()}${id.slice(1)}Label`,
    hintKey: `core.codexMode${id.slice(0, 1).toUpperCase()}${id.slice(1)}Hint`,
    ...(id === 'bypassPermissions' ? { persistAsDefault: false, requiresExplicitSelection: true } : {}),
  }));
}

/**
 * Меню сверяется с живым CLI и managed policy, не считая сам каталог разрешением.
 * Неизвестная версия закрывает новые профили; legacy Auto проверяет свой handshake.
 */
export async function availableCodexPermissionModes(config: { codexBin: string; rootDir?: string }) {
  const descriptors = codexPermissionModes();
  const legacy = descriptors.filter((mode) => mode.id === 'auto');

  try {
    const signal = AbortSignal.timeout(15_000);
    const identity = await executableIdentity(config.codexBin);
    const schema = await schemaFingerprint(config.codexBin, identity, signal, CODEX_MODE_ADMISSION);

    if (schema !== CODEX_MODE_ADMISSION.schemaFingerprint) {
      return legacy;
    }

    const metadata = await runtimeMetadata(config.codexBin, config.rootDir || process.cwd(), signal);

    return descriptors.filter((descriptor) => {
      try {
        validateCodexRequirements(metadata.requirements, descriptor.id as CodexPermissionMode);

        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return legacy;
  }
}

/**
 * Схема кэшируется по точной identity executable и версии допуска; временный каталог
 * удаляется. Неизвестная версия или codec не получает право использовать профиль.
 */
async function schemaFingerprint(bin: string, identity: string, signal: AbortSignal,
  admission: CodexModeAdmission) {
  const cacheKey = `${identity}@${admission.version}`;

  if (!schemaCache.has(cacheKey)) {
    const pending = (async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-codex-modes-'));

      try {
        const version = await execute(bin, ['--version'], { signal, maxBuffer: 16_384 });

        if (!version.stdout.includes(`codex-cli ${admission.version}`)) {
          throw new ExecutorRuntimeError('mode_unavailable', 'Версия Codex не прошла допуск режимов.');
        }

        await execute(bin, ['app-server', 'generate-ts', '--experimental', '--out', directory],
          { signal, maxBuffer: 2_097_152 });

        const hash = createHash('sha256');

        for (const file of SCHEMA_FILES) {
          hash.update(file).update(await readFile(path.join(directory, 'v2', `${file}.ts`)));
        }

        return hash.digest('hex');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    })();

    schemaCache.set(cacheKey, pending);
    pending.catch(() => schemaCache.delete(cacheKey));
  }

  return schemaCache.get(cacheKey)!;
}

/**
 * Возврат в песочницу допускается на legacy-установке 0.164.0 и на проверенной
 * 0.167.1; неизвестная версия не получает молчаливого fallback на другой профиль.
 */
async function admittedSandboxSchema(bin: string, identity: string, signal: AbortSignal) {
  let lastError: unknown = new ExecutorRuntimeError('mode_unavailable',
    'Схема Codex не прошла допуск режимов.');

  for (const admission of [CODEX_MODE_ADMISSION, CODEX_HOST_MODE_ADMISSION]) {
    try {
      const schema = await schemaFingerprint(bin, identity, signal, admission);

      if (schema === admission.schemaFingerprint) {
        return { schema, admission };
      }

      lastError = new ExecutorRuntimeError('mode_unavailable', 'Схема Codex не прошла допуск режимов.');
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

/**
 * Probe читает только requirements/config, не создавая рабочего thread или turn.
 * Приватные настройки остаются внутри процесса: handle хранит только их отпечаток.
 */
async function runtimeMetadata(bin: string, cwd: string, signal: AbortSignal) {
  return withSettingsStdioProbe({
    bin,
    cwd,
    signal,
    args: ['app-server']
  }, async (probe) => {
    let id = 0;
    /**
     * Ответ probe сопоставляется с точным ID текущего read-only RPC.
     * Ошибочный envelope не превращается в отсутствие managed requirements.
     */
    const rpc = async (method: string, params: Record<string, unknown>) => {
      const current = ++id;
      const reply = await probe.request({
        id: current,
        method,
        params
      }, (item) => item.id === current);

      if (reply.error) {
        throw new ExecutorRuntimeError('mode_unavailable', 'Codex отклонил проверку режима.');
      }

      return reply.result;
    };

    await rpc('initialize', { clientInfo: { name: 'grigdesk-modes', version: '1' },
      capabilities: { experimentalApi: true } });
    probe.send({ method: 'initialized' });

    return { requirements: await rpc('configRequirements/read', {}),
      config: await rpc('config/read', { cwd, includeLayers: false }) };
  });
}

/**
 * Host допускается только серверным контекстом обычного чата: потребитель создан
 * сервером, workspaceAccess отсутствует, настройка — строгий boolean true.
 * Присланный boolean/JSON в теле хода или marker чата основанием не являются.
 */
function ordinaryHostAccess(context: PermissionModeContext): boolean {
  return context.consumer === 'ordinary-chat' && !context.workspaceAccess
    && isRecord(context.providerSettings) && context.providerSettings.allowHostAccess === true;
}

/**
 * Только адаптер выдаёт брендированный frozen handle из серверного контекста.
 * Legacy Auto сохраняет handshake, новые режимы требуют точной схемы и свежих requirements.
 * Host фиксирует эффективный профиль и подготовленного OS-владельца в состоянии handle.
 */
export async function prepareCodexPermissionRuntime(config: { codexBin: string }, options: {
  signal: AbortSignal;
  permissionModeContext?: PermissionModeContext;
}) {
  const context = structuredClone(options.permissionModeContext || {
    mode: 'auto',
    provider: 'codex',
    chatId: '',
    cwd: '',
    extraDirs: []
  });
  const normalized = normalizeCodexPermissionMode(context.mode);

  if (!normalized.ok) {
    throw new ExecutorRuntimeError('invalid_permission_mode', normalized.message);
  }

  const mode = normalized.mode;

  if (context.provider !== 'codex') {
    throw new ExecutorRuntimeError('invalid_permission_mode', 'Контекст принадлежит другому исполнителю.');
  }

  if (context.modeSelection !== undefined && (!isChatModeSelection(context.modeSelection)
    || context.modeSelection.provider !== 'codex' || context.modeSelection.id !== mode
    || context.modeSelection.chatId !== context.chatId || context.modeSelection.revision !== 1)) {
    throw new ExecutorRuntimeError('invalid_permission_mode', 'Выбор режима не принадлежит этому чату.');
  }
  if (mode === 'bypassPermissions' && !context.modeSelection && !context.workspaceAccess) {
    throw new ExecutorRuntimeError('invalid_permission_mode', 'Полный доступ требует явного выбора в чате.');
  }

  codexModeProfile(mode, context.workspaceAccess);

  const hostAccess = ordinaryHostAccess(context);
  const identity = await executableIdentity(config.codexBin);
  let requirements = '';
  let nativeConfig = '';
  let schema = '';
  let admission = CODEX_MODE_ADMISSION;
  let effectiveProfile: CodexNativeProfile = codexModeProfile(mode, context.workspaceAccess);

  if (hostAccess) {
    admission = CODEX_HOST_MODE_ADMISSION;
    effectiveProfile = CODEX_HOST_PROFILE;
    schema = await schemaFingerprint(config.codexBin, identity, options.signal, admission);

    if (schema !== admission.schemaFingerprint) {
      throw new ExecutorRuntimeError('mode_unavailable', 'Схема Codex не прошла допуск Host.');
    }

    const metadata = await runtimeMetadata(config.codexBin, context.cwd, options.signal);

    validateCodexRequirements(metadata.requirements, mode, effectiveProfile);
    requirements = fingerprint(metadata.requirements);
    nativeConfig = fingerprint(metadata.config);
  } else if (mode !== 'auto' && !context.workspaceAccess) {
    const admitted = await admittedSandboxSchema(config.codexBin, identity, options.signal);

    schema = admitted.schema;
    admission = admitted.admission;

    const metadata = await runtimeMetadata(config.codexBin, context.cwd, options.signal);

    validateCodexRequirements(metadata.requirements, mode);
    requirements = fingerprint(metadata.requirements);
    nativeConfig = fingerprint(metadata.config);
  }

  // Обычный чат владеет собственным scope в обоих профилях: отсутствие менеджера
  // даёт явную причину отказа, а не слабый fallback без владения процессами.
  let owner: PreparedProcessScopeOwner | null = null;

  if (context.consumer === 'ordinary-chat' && !context.workspaceAccess) {
    try {
      owner = await prepareOwnedProcessScope(codexScopeOptions);
    } catch (error) {
      throw new ExecutorRuntimeError('codex_host_scope_unavailable',
        error instanceof Error ? error.message : 'Codex: user bus процессов недоступен.');
    }
  }

  const state: RuntimeState = {
    bin: config.codexBin,
    identity,
    context,
    mode,
    requirements,
    nativeConfig,
    processFingerprint: externalCliProcessFingerprint(),
    hostAccess,
    effectiveProfile,
    owner,
    fingerprint: fingerprint([identity, context, schema, requirements, nativeConfig,
      externalCliProcessFingerprint(), admission])
  };
  const handle = Object.freeze({});

  handles.set(handle, state);

  return handle;
}

/**
 * Сериализуемое описание эффективного профиля для снимка хода; это не handle и не
 * допуск. Подтверждение приходит только после успешного readback живого runtime.
 */
export function codexRuntimePermissionProfile(handle: object | undefined) {
  const state = handle && handles.get(handle);

  if (!state) {
    return null;
  }

  return {
    id: state.hostAccess ? 'host' : state.mode,
    sandbox: state.effectiveProfile.sandbox,
    approvalPolicy: state.effectiveProfile.approvalPolicy,
    approvalsReviewer: state.effectiveProfile.approvalsReviewer,
    confirmed: false,
  };
}

/**
 * Непрозрачный handle не сериализуется и не принимается от клиента.
 * Getter отвергает подделку даже при совпадающем содержимом объекта.
 */
export function codexRuntimeFingerprint(handle: object) {
  const state = handles.get(handle);

  if (!state) {
    throw new ExecutorRuntimeError('mode_unavailable', 'Недействительная подготовка Codex.');
  }

  return state.fingerprint;
}

/**
 * Проверка до spawn сверяет владельца, профиль, roots и изменения executable.
 * Повторная проверка перед send обнаруживает изменение requirements и настроек.
 */
export function assertCodexRuntimeBeforeSpawn(handle: object | undefined, input: {
  config: { codexBin: string };
  permissionMode?: string;
  cwd?: string;
  extraDirs?: readonly string[];
  modeSelection?: unknown;
  workspaceAccess?: unknown;
  runtimeProfileFingerprint?: string;
}) {
  const mode = normalizeCodexPermissionMode(input.permissionMode);

  codexModeProfile(input.permissionMode, input.workspaceAccess);

  if (!handle && (input.workspaceAccess || (mode.ok && mode.mode === 'auto'))) {
    return;
  }

  const state = handle && handles.get(handle);

  if (!state || !mode.ok || state.mode !== mode.mode || state.bin !== input.config.codexBin
    || state.fingerprint !== input.runtimeProfileFingerprint || state.context.cwd !== (input.cwd || '')
    || fingerprint(state.context.extraDirs || []) !== fingerprint(input.extraDirs || [])
    || fingerprint(state.context.modeSelection) !== fingerprint(input.modeSelection)
    || fingerprint(state.context.workspaceAccess) !== fingerprint(input.workspaceAccess)
    || state.processFingerprint !== externalCliProcessFingerprint()
    || state.identity !== executableIdentitySync(state.bin)) {
    throw new ExecutorRuntimeError('mode_unavailable', 'Подготовка Codex устарела; повторите отправку.');
  }

  return state;
}

/**
 * Повторный send получает свежий handle с тем же fingerprint живого процесса.
 * Managed requirements перечитываются независимо от кэша схемы перед каждым turn
 * и сверяются с эффективным профилем, зафиксированным при подготовке.
 */
export async function assertCodexRuntime(handle: object | undefined,
  input: Parameters<typeof assertCodexRuntimeBeforeSpawn>[1], refresh = false) {
  const state = assertCodexRuntimeBeforeSpawn(handle, input);

  if (refresh && state?.requirements) {
    const metadata = await runtimeMetadata(state.bin, state.context.cwd, AbortSignal.timeout(15_000));

    validateCodexRequirements(metadata.requirements, state.mode, state.effectiveProfile);

    if (fingerprint(metadata.requirements) !== state.requirements
      || fingerprint(metadata.config) !== state.nativeConfig) {
      throw new ExecutorRuntimeError('mode_unavailable', 'Политика Codex изменилась до запуска хода.');
    }
  }
}
