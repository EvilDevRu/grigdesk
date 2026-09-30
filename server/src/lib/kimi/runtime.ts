import type { ChatRunMetadata } from '../../../../shared/chatRun.ts';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import type { ChildProcess } from 'node:child_process';

import { createStepSink } from '../chat/streamSteps.ts';
import type { ChatStep } from '../chat/streamSteps.ts';
import { contextCacheStatus } from '../chat/contextCache.ts';
import { createKimiStepNormalizer } from '../executors/_kimiSteps.ts';
import type { KimiUpdate } from '../executors/_kimiSteps.ts';
import { defaultWorkToolDescriptors } from '../executors/work-tools/index.ts';
import { createAcpClient, initializeKimiAcp } from './acpClient.ts';
import { stageKimiAttachments } from './attachments.ts';
import {
  createKimiEgressProxy,
  KIMI_EGRESS_ALLOWLIST_VERSION,
} from './egressProxy.ts';
import { buildKimiHostLaunch } from './hostLaunch.ts';
import { buildKimiHostWebHome } from './hostWebHome.ts';
import { runKimiServerTurn } from './serverTurn.ts';
import { startKimiServer } from './serverRuntime.ts';
import type {
  InTurnAssistantEvent,
  InTurnPort,
  InTurnUnavailableReason,
} from '../../../../shared/chatInTurnContracts.ts';
import { KIMI_MODELS } from './profile.ts';
import { inspectKimiRuntimeHost } from './runtimePreflight.ts';
import {
  buildKimiSandboxLaunch,
  KIMI_EGRESS_SOCKET_FILE,
  KIMI_SANDBOX_NODE,
  KIMI_SANDBOX_WORK_MCP,
  KIMI_SANDBOX_WORK_SOCKET,
  kimiSystemdClientEnv,
  stopKimiUnit,
} from './sandbox.ts';
import type { KimiSandboxConfig } from './sandbox.ts';

const REQUIRED_KIMI_VERSION = '0.31.1';
// Режим кокпита → режим ACP-сессии. Не перечисленное остаётся в `default`.
const ACP_MODE_BY_PERMISSION: Record<string, string> = { plan: 'plan', yolo: 'yolo' };

// Серверный config в объёме этого хода: контракт песочницы плюс режим запуска
// и бинарь systemctl, которым останавливают юнит.
type KimiRuntimeConfig = KimiSandboxConfig & {
  chatsDir: string;
  kimiLaunchMode?: string;
  kimiSystemctlBin?: string;
};

// Готовый запуск: чем стартовать, где и в каком окружении. Contained добавляет имя
// systemd-юнита и отчёт о каталогах, которые смонтировать не удалось.
interface KimiLaunch {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwdReal: string;
  unit?: string | null;
  rejectedExtraDirs?: Array<{ reason?: unknown }>;
  maskedWorkspacePaths?: readonly unknown[];
}

// Вариант ответа ACP-запроса разрешения: идентификатор, подпись и класс кнопки.
interface AcpPermissionOption {
  optionId?: string;
  name?: string;
  kind?: string;
}

// Сам запрос разрешения: варианты и вызов, ради которого он задан.
interface AcpPermissionParams {
  options?: unknown;
  toolCall?: {
    title?: string;
    toolCallId?: string;
    content?: unknown;
  };
}

// Что кокпит запомнил про вызов из notification того же toolCallId.
interface ToolCallContext {
  kind?: unknown;
  title?: unknown;
  rawInput?: unknown;
}

// Ответ всплывашки: либо готовый ACP-outcome, либо решение человека.
interface PermissionAnswer {
  outcome?: { outcome?: string };
  choice?: unknown;
  selected?: unknown[];
  allow?: unknown;
  remember?: unknown;
  comment?: string;
  text?: string;
  rawAnswers?: Array<{ selected?: string[]; text?: string }>;
}

// Запись MCP-сервера сессии в том виде, в котором её передаёт чат.
interface KimiMcpServerSpec {
  name?: string;
  command?: string;
  args?: string[];
  [field: string]: unknown;
}

// Журнал сервера в том минимуме, который использует ход.
interface KimiRuntimeLog {
  info?: (fields: Record<string, unknown>, message: string) => void;
  warn?: (fields: Record<string, unknown>, message: string) => void;
  error?: (fields: Record<string, unknown>, message: string) => void;
}

// Подменяемые в тестах соседи. Умолчание каждого — настоящая реализация рядом,
// поэтому и тип берётся у неё: стенд обязан отвечать тем же контрактом.
interface KimiRuntimeDeps {
  spawn?: typeof spawn;
  createProxy?: typeof createKimiEgressProxy;
  buildLaunch?: typeof buildKimiSandboxLaunch;
  buildHostLaunch?: typeof buildKimiHostLaunch;
  preflight?: typeof inspectKimiRuntimeHost;
  stopUnit?: typeof stopKimiUnit;
  assertVersion?: typeof assertPinnedVersion;
  startServer?: typeof startKimiServer;
}
const MAX_REPLY_BYTES = 8 * 1024 * 1024;
const MAX_STATUS_BYTES = 64 * 1024;

function commandOutput(bin: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, [...args], { timeout: 10_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout || '').trim());
    });
  });
}

async function assertPinnedVersion(config: { kimiBin: string }, run = commandOutput) {
  const output = await run(config.kimiBin, ['--version']);
  const version = output.match(/\d+\.\d+\.\d+/)?.[0] || '';
  if (version !== REQUIRED_KIMI_VERSION) {
    throw new Error(`Kimi ${version || 'unknown'} не прошёл ACP contract gate: ожидается ${REQUIRED_KIMI_VERSION}`);
  }
  return version;
}

function textOfContent(value: unknown) {
  const content = value as { type?: unknown; text?: unknown } | null;
  if (content?.type === 'text') return String(content.text || '');
  return '';
}

// optionId ACP-запроса разрешения (сверено с бинарём 0.33.0): вопрос агента —
// `q<N>_opt_<i>`/`q<N>_skip`, план — `plan_opt_<i>`/`plan_approve`/`plan_revise`/
// `plan_reject_and_exit`, обычное действие — approve_once/approve_always/reject.
const QUESTION_OPTION = /^q\d+_/;
const QUESTION_CHOICE = /^q\d+_opt_/;
const PLAN_OPTION = /^plan_/;

/**
 * Блоки content запроса разрешения. Kimi кладёт туда текст и структурный diff
 * `{type:'diff', path, oldText, newText}`; раньше читался только текст, поэтому
 * правка файла доезжала до всплывашки пустой, а всё остальное — служебным JSON.
 */
function permissionContent(toolCall: AcpPermissionParams['toolCall']) {
  const list = (Array.isArray(toolCall?.content) ? toolCall.content : []) as Array<{
    type?: unknown;
    path?: unknown;
    oldText?: unknown;
    newText?: unknown;
    content?: unknown;
  } | null>;
  const texts: string[] = [];
  let diff: { path: string; old: string; new: string } | null = null;
  for (const entry of list) {
    if (entry?.type === 'diff') {
      diff = {
        path: String(entry.path || ''),
        old: String(entry.oldText ?? ''),
        new: String(entry.newText ?? ''),
      };
      continue;
    }
    const text = textOfContent(entry?.content);
    if (text.trim()) texts.push(text);
  }
  return { texts, diff };
}

function firstString(...values: unknown[]) {
  return values.find((value) => typeof value === 'string' && value.trim()) || '';
}

/**
 * Вопрос агента поверх ACP. Мост Kimi несёт только optionId, поэтому пояснений
 * к вариантам нет, свой текст доехать не может, а мультивыбор сам мост сводит
 * к одному варианту (его же телеметрия зовёт это question_degraded). Врать
 * человеку чекбоксами нельзя — говорим об ограничении прямо.
 */
function questionPresentation(options: AcpPermissionOption[], question: string) {
  const choices = options.filter((option) => QUESTION_CHOICE.test(option?.optionId || ''));
  return {
    isQuestion: true,
    acceptsText: false,
    questions: [{
      header: 'Kimi',
      question: question || 'Выберите ответ',
      multiSelect: false,
      allowFreeText: false,
      hint: 'ACP-мост Kimi принимает ровно один вариант: ни нескольких отметок, ни своего текста он не передаёт',
      options: choices.map((option) => ({ label: String(option.name || ''), description: '' })),
    }],
  };
}

/**
 * ACP-запрос разрешения → нейтральное представление всплывашки.
 * `context` — то, что кокпит запомнил по этому же toolCallId из notification
 * tool_call/tool_call_update: сам запрос разрешения не несёт ни `kind`, ни
 * аргументов вызова (buildPermissionToolCallUpdate кладёт только title и content).
 */
function permissionPresentation(value: unknown, context: ToolCallContext = {}) {
  const params = value as AcpPermissionParams | null;
  const options = (Array.isArray(params?.options) ? params.options : []) as AcpPermissionOption[];
  const toolCall = params?.toolCall || {};
  const { texts, diff } = permissionContent(toolCall);
  if (options.some((option) => QUESTION_OPTION.test(option?.optionId || ''))) {
    return questionPresentation(options, texts.join('\n\n'));
  }

  // Последний текстовый блок — всегда «Requesting approval to <действие>»,
  // всё перед ним ACP отдаёт как человекочитаемую шапку (план, описание правки).
  const action = texts.length ? texts[texts.length - 1] : '';
  const headline = texts.slice(0, -1).join('\n\n');
  const isPlan = options.some((option) => PLAN_OPTION.test(option?.optionId || ''));
  const raw = (context.rawInput && typeof context.rawInput === 'object'
    ? context.rawInput
    : {}) as Record<string, unknown>;
  const command = firstString(raw.command, raw.cmd, raw.script);
  const filePath = firstString(diff?.path, raw.path, raw.file_path, raw.filePath);
  // Стандартную тройку allow/allow_always/reject рисует сама всплывашка кнопками;
  // отдельным списком идут только специфические варианты — выбор по плану.
  const choices = options
    .filter((option) => PLAN_OPTION.test(option?.optionId || ''))
    .map((option) => ({ id: option.optionId, label: String(option.name || ''), kind: option.kind }));

  return {
    isQuestion: false,
    // ACP-outcome текста не несёт: пояснение к отказу кокпит отправит отдельным
    // сообщением (флаг commentDelivered в modules/chat).
    acceptsComment: false,
    tool: firstString(toolCall.title, context.title) || 'Действие Kimi',
    input: {
      kind: String(context.kind || ''),
      description: action,
      ...(isPlan ? { plan: headline || action } : {}),
      ...(!isPlan && headline ? { details: headline } : {}),
      ...(command ? { command } : {}),
      ...(filePath ? { file_path: filePath } : {}),
      ...(diff ? { diff: { old: diff.old, new: diff.new } } : {}),
      ...(choices.length ? { choices } : {}),
    },
  };
}

function selectPermissionOutcome(value: unknown, answer: PermissionAnswer | null | undefined) {
  if (answer?.outcome?.outcome === 'selected' || answer?.outcome?.outcome === 'cancelled') return answer;
  const params = value as AcpPermissionParams | null;
  const options = (Array.isArray(params?.options) ? params.options : []) as AcpPermissionOption[];
  const byId = (id: string) => options.find((candidate) => candidate.optionId === id);
  const byKind = (kind: string) => options.find((candidate) => candidate.kind === kind);
  const pick = (option: AcpPermissionOption | undefined) => (option
    ? { outcome: { outcome: 'selected', optionId: option.optionId } }
    : { outcome: { outcome: 'cancelled' } });

  // Нажатая кнопка конкретного варианта (план) сильнее общего «разрешить/отклонить».
  if (answer?.choice) return pick(byId(String(answer.choice)));

  const questionOptions = options.filter((option) => QUESTION_CHOICE.test(option.optionId || ''));
  if (questionOptions.length) {
    const selected = answer?.selected?.[0] || '';
    const option = questionOptions.find((candidate) => candidate.name === selected);
    // Свой текст ACP не принимает. Подменять его «похожим» вариантом нельзя —
    // отвечаем «пропустить», а текст кокпит отправит обычным сообщением.
    return pick(option || options.find((candidate) => /_skip$/.test(candidate.optionId || '')));
  }
  if (answer?.allow) {
    // «Не спрашивать до конца сессии» — это ровно allow_always у ACP: раньше галка
    // жила только в памяти вкладки, и агент спрашивал снова из каждого окна.
    return pick((answer.remember && byKind('allow_always')) || byKind('allow_once') || byKind('allow_always'));
  }
  return pick(byKind('reject_once') || byKind('reject_always'));
}

function parseStatus(text: unknown, fallbackWindow: number) {
  // Формат 0.31: «- Context: 1,234 / 262,144 (0.5%)» строкой в /status.
  // Формат 0.33+: «Context: 1,234 / 262,144 tokens (0%)» строкой в /usage.
  const match = String(text || '').match(/-?\s*Context:\s*([\d,]+)\s*\/\s*([\d,]+)/i);
  // 0.33+ убрал маркер «- » и добавляет суффикс «(thinking: on)».
  const model = String(text || '').match(/-?\s*Model:\s*(.+)/i)?.[1]?.trim()
    .replace(/\s*\(thinking:[^)]*\)\s*$/i, '') || '';
  const contextTokens = match ? Number((match[1] || '').replaceAll(',', '')) : null;
  const contextWindow = match ? Number((match[2] || '').replaceAll(',', '')) : null;

  if (contextTokens === null || contextWindow === null
    || !Number.isSafeInteger(contextTokens) || !Number.isSafeInteger(contextWindow)
    || contextWindow <= 0) return {
    contextTokens: 0,
    contextWindow: fallbackWindow || 0,
    contextMetric: 'unavailable',
    contextIsEstimate: true,
    actualModel: model,
  };
  return {
    contextTokens,
    contextWindow,
    contextMetric: 'kimi-session-status',
    contextIsEstimate: false,
    actualModel: model,
  };
}

function replaceAttachmentPaths(
  message: unknown,
  staged: { files: ReadonlyArray<{ sandboxPath: string }> },
  sourcePaths: readonly string[],
) {
  let result = String(message || '');
  staged.files.forEach((file, index) => {
    const source = sourcePaths[index];
    if (!source) return;
    result = result.split(source).join(file.sandboxPath);
  });
  return result;
}

function waitForExit(child: ChildProcess): Promise<{
  code: number | null;
  signal: string | null;
}> {
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

/**
 * Один ACP-ход. Реальный prompt отправляется только когда этот executor вызвал чат;
 * probe/catalog/tests сюда не заходят и квоту не расходуют.
 */
export async function runContainedKimi({
  config,
  env,
  message,
  cwd,
  extraDirs = [],
  attachmentPaths = [],
  model,
  effort,
  sessionId,
  permissionMode,
  providerSettings,
  signal,
  onStep,
  onProgress,
  onPermission,
  onSessionCreated,
  onRunMetadata,
  onInTurnReady,
  onInTurnAvailability,
  onAssistantMessage,
  transport = 'acp',
  chatKey,
  mcpServers = [],
  workTools,
  log,
  deps = {},
}: {
  config: KimiRuntimeConfig;
  env?: NodeJS.ProcessEnv;
  message?: unknown;
  cwd?: string;
  extraDirs?: readonly string[];
  attachmentPaths?: readonly string[];
  model?: string;
  effort?: string;
  sessionId?: string | null;
  permissionMode?: string;
  providerSettings?: {
    blockDirectSsh?: unknown;
    blockDirectDb?: unknown;
  } | null;
  signal?: AbortSignal;
  onStep?: (step: ChatStep) => void;
  onProgress?: (tokens: number, info?: Record<string, unknown>) => void;
  onPermission?: (ask: Record<string, unknown>) => Promise<PermissionAnswer | null | undefined>;
  onSessionCreated?: (sessionId: string) => unknown;
  onRunMetadata?: (metadata: ChatRunMetadata) => void;
  onInTurnReady?: (port: InTurnPort) => void;
  onInTurnAvailability?: (status: { available: boolean; reason?: InTurnUnavailableReason }) => void;
  onAssistantMessage?: (event: InTurnAssistantEvent) => void | Promise<void>;
  transport?: 'acp' | 'server';
  chatKey?: string;
  mcpServers?: readonly KimiMcpServerSpec[];
  workTools?: { descriptors?: unknown } | null;
  log?: KimiRuntimeLog;
  deps?: KimiRuntimeDeps;
}) {
  const spawnProcess = deps.spawn || spawn;
  const makeProxy = deps.createProxy || createKimiEgressProxy;
  const buildLaunch = deps.buildLaunch || buildKimiSandboxLaunch;
  const buildHost = deps.buildHostLaunch || buildKimiHostLaunch;
  const preflight = deps.preflight || inspectKimiRuntimeHost;
  const stopUnit = deps.stopUnit || stopKimiUnit;
  // Режимы запуска: host (умолчание конфига) — прямой хост-процесс, contained —
  // прежний bwrap-профиль. Отсутствие ключа трактуем как contained: старые вызовы
  // и тесты без обновлённого конфига получают прежнее, более строгое поведение.
  const launchMode = config.kimiLaunchMode === 'host' ? 'host' : 'contained';
  if (launchMode === 'host' && providerSettings?.blockDirectSsh !== false) {
    throw Object.assign(new Error(
      'Kimi host не умеет обеспечить запрет прямого SSH: включи contained '
      + 'или подтверждённо выключи настройку.',
    ), { code: 'direct_ssh_policy_unavailable' });
  }
  if (launchMode === 'host' && providerSettings?.blockDirectDb === true) {
    throw Object.assign(new Error(
      'Kimi host не умеет обеспечить запрет прямых подключений к БД: включи contained.',
    ), { code: 'direct_db_policy_unavailable' });
  }
  const checkVersion = deps.assertVersion || assertPinnedVersion;
  if (launchMode === 'host') {
    // Host CLI обновляется пользователем: жёсткий пин ломал бы чат при любом
    // апгрейде. Protocol gate в initializeKimiAcp остаётся обязательным.
    await checkVersion(config).catch((error: unknown) => {
      log?.warn?.(
        { reason: (error as Error)?.message },
        'Kimi host: pinned version gate пропущен, продолжаю по ACP protocol gate',
      );
    });
  } else {
    await checkVersion(config);
  }

  const modelInfo = KIMI_MODELS.find((entry) => entry.id === model);
  if (!modelInfo) throw new Error(`Kimi model не прошла pinned catalog gate: ${model}`);
  if (effort && !(modelInfo.efforts as readonly string[]).includes(effort)) {
    throw new Error(`Kimi effort не поддерживается: ${effort}`);
  }

  // contained-only состояние: per-chat KIMI_CODE_HOME, broker, egress socket,
  // staging вложений. Host-режим пишет сессии в реальный kimiHome и ничего из
  // этого не создаёт.
  let runtimeHome = '';
  let brokerHome = '';
  let runId = '';
  let runDir = '';
  let stagingParent = '';
  let egressSocketPath = '';
  let controlDir = '';
  let proxy: ReturnType<typeof createKimiEgressProxy> | null = null;
  if (launchMode === 'contained') {
    const runtimeBase = path.resolve(config.kimiRuntimeHome);
    if (!String(chatKey || '').trim()) throw new Error('Kimi runtime требует server-owned chatKey');
    const chatHash = createHash('sha256').update(String(chatKey)).digest('hex');
    // Каждому чату — отдельный KIMI_CODE_HOME: shell/tool одной модели физически
    // не может прочитать transcript/session state другого чата.
    runtimeHome = path.join(runtimeBase, 'chats', chatHash);
    brokerHome = path.join(runtimeBase, 'broker');
    // Unix socket path на Linux ограничен 107 байтами. Короткий 80-bit id
    // сохраняет уникальность запуска, не протаскивая UUID и длинные имена каталогов
    // в оба socket path.
    runId = randomUUID().replaceAll('-', '').slice(0, 20);
    runDir = path.join(brokerHome, 'r', runId);
    const egressDir = runDir;
    stagingParent = path.join(runDir, 'a');
    controlDir = path.join(runDir, 'c');
    await Promise.all([runtimeHome, brokerHome, egressDir, stagingParent, controlDir]
      .map((dir) => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
    egressSocketPath = path.join(egressDir, KIMI_EGRESS_SOCKET_FILE);
    proxy = makeProxy({ socketPath: egressSocketPath });
  }
  let staged: Awaited<ReturnType<typeof stageKimiAttachments>> | null = null;
  let hostWebHome: Awaited<ReturnType<typeof buildKimiHostWebHome>> | null = null;
  let child: ChildProcess | null = null;
  let launch: KimiLaunch | null = null;
  let stderrTail = '';
  let stopped = false;
  let promptState = 'pre_prompt';
  const stepSink = createStepSink(onStep);
  const normalizeStep = createKimiStepNormalizer({ model, cwd, mode: permissionMode || 'manual' });
  let sessionMcpServers: readonly KimiMcpServerSpec[] = mcpServers;
  const descriptors = (Array.isArray(workTools?.descriptors)
    ? workTools.descriptors
    : defaultWorkToolDescriptors('kimi')) as Array<{
      name?: string;
      function?: { name?: string };
    }>;
  const workNames = new Set(descriptors
    .map((descriptor) => descriptor?.name || descriptor?.function?.name)
    .filter(Boolean));
  let containedWorkMcp: { scriptPath: string; socketPath: string } | null = null;
  if (launchMode === 'contained') {
    const work = mcpServers.find((entry) => entry?.name === 'cockpit-work');
    if (work) {
      const socketAt = work.args?.indexOf('--socket') ?? -1;
      const nonceAt = work.args?.indexOf('--nonce') ?? -1;
      const scriptPath = work.args?.[0];
      const socketPath = socketAt >= 0 ? work.args?.[socketAt + 1] : '';
      const nonce = nonceAt >= 0 ? work.args?.[nonceAt + 1] : '';
      if (!scriptPath || !socketPath || !nonce) throw new Error('kimi_work_mcp_invalid');
      containedWorkMcp = { scriptPath, socketPath };
      sessionMcpServers = mcpServers.map((entry) => (entry === work ? {
        ...entry,
        // Внутри песочницы работает Node кокпита, смонтированный сборкой запуска:
        // хостового `/usr/bin/node` на машине может не быть вовсе.
        command: KIMI_SANDBOX_NODE,
        args: [
          KIMI_SANDBOX_WORK_MCP,
          '--socket', KIMI_SANDBOX_WORK_SOCKET,
          '--nonce', nonce,
        ],
      } : entry));
    }
  }

  try {
    if (proxy) {
      await proxy.start();
      const gate = await preflight({
        bubblewrap: { bwrapBin: config.kimiBwrapBin },
        systemd: { systemdRunBin: config.kimiSystemdRunBin, systemctlBin: config.kimiSystemctlBin },
        egress: { socketPath: egressSocketPath, allowlistVersion: KIMI_EGRESS_ALLOWLIST_VERSION },
      });
      if (gate.decision !== 'GO_CONTAINED_MVP') {
        log?.error?.({ checks: gate.checks }, 'Kimi runtime security gate: NO_GO');
        throw new Error('Kimi не запущен: security gate NO_GO');
      }
    }

    if (attachmentPaths.length) {
      const allowedRoot = path.resolve(config.chatsDir, 'attachments');
      if (launchMode === 'host') {
        // Host-процесс читает вложения по исходным путям; staging не нужен, но
        // корень всё равно проверяем — пути приходят от chat-модуля.
        for (const sourcePath of attachmentPaths) {
          const resolved = path.resolve(sourcePath);
          if (resolved !== allowedRoot && !resolved.startsWith(`${allowedRoot}${path.sep}`)) {
            throw new Error('kimi_attachment_outside_root');
          }
        }
      } else {
        staged = await stageKimiAttachments({
          allowedRoot,
          stagingParent,
          manifest: attachmentPaths.map((sourcePath, index) => ({
            id: `attachment-${index}`,
            sourcePath,
            name: path.basename(sourcePath),
          })),
        });
      }
    }
    if (launchMode === 'host') {
      // extraDirs намеренно не передаются: у `kimi acp` нет --add-dir, а у ACP нет
      // additionalDirs. Доступ за пределами cwd закрывает permission-система Kimi.
      launch = await buildHost({ config, cwd, env });

      if (transport === 'server') {
        hostWebHome = await buildKimiHostWebHome({
          kimiHome: config.kimiHome,
          runtimeHome: config.kimiRuntimeHome,
          mcpServers: sessionMcpServers,
        });
      }
    } else {
      const safeExtraDirs = extraDirs.filter((dir) => path.resolve(dir) !== path.resolve(config.chatsDir, 'attachments'));
      let serverMcpFile = '';

      if (transport === 'server' && sessionMcpServers.length) {
        serverMcpFile = path.join(runDir, 'mcp.json');

        const mcpConfig = Object.fromEntries(sessionMcpServers
          .filter((entry) => typeof entry.name === 'string' && typeof entry.command === 'string')
          .map((entry) => [entry.name, {
            command: entry.command,
            args: Array.isArray(entry.args) ? entry.args : [],
          }]));

        await fs.writeFile(serverMcpFile, JSON.stringify({ mcpServers: mcpConfig }), { mode: 0o600 });
      }

      launch = await buildLaunch({
        config: { ...config, kimiRuntimeHome: runtimeHome, kimiRuntimeBroker: brokerHome },
        cwd,
        extraDirs: safeExtraDirs,
        attachmentDir: staged?.stagingDir,
        egressSocketPath,
        workMcp: containedWorkMcp,
        ...(transport === 'server' ? { serverControlDir: controlDir } : {}),
        ...(serverMcpFile ? { serverMcpFile } : {}),
        unit: `cockpit-kimi-${runId}.service`,
      });
    }
    if (launch.rejectedExtraDirs?.length) {
      log?.warn?.({
        count: launch.rejectedExtraDirs.length,
        reasons: [...new Set(launch.rejectedExtraDirs.map((entry) => entry.reason))],
      }, 'Kimi runtime: небезопасные дополнительные каталоги не смонтированы');
    }
    if (launch.maskedWorkspacePaths?.length) {
      log?.info?.({
        paths: launch.maskedWorkspacePaths,
      }, 'Kimi runtime: control state внутри доверенных каталогов замаскирован');
    }
    if (transport === 'server') {
      const result = await runKimiServerTurn({
        bin: config.kimiBin,
        home: launchMode === 'host' ? hostWebHome?.home || config.kimiHome : runtimeHome,
        cwd: launch.cwdReal,
        env: launchMode === 'host' ? launch.env : kimiSystemdClientEnv(),
        model,
        effort,
        permissionMode: permissionMode === 'yolo' ? 'yolo' : 'manual',
        planMode: permissionMode === 'plan',
        message: staged ? replaceAttachmentPaths(message, staged, attachmentPaths) : String(message || ''),
        sessionId,
        signal,
        onStep,
        onProgress,
        onSessionCreated: async (id) => {
          await onSessionCreated?.(id);
        },
        onInTurnReady,
        onInTurnAvailability,
        onAssistantMessage,
        onApproval: async (approval, respond) => {
          const tool = String(approval.tool_name || approval.tool || 'Действие агента');
          const answer = await onPermission?.({
            tool,
            input: {
              command: String(approval.tool_input_display || approval.command || ''),
              description: String(approval.description || approval.tool_input_display || ''),
              kind: String(approval.kind || approval.action || ''),
            },
            acceptsComment: true,
            canRemember: true,
            raw: approval,
            signal,
          });

          await respond({
            decision: answer?.allow === true ? 'approved' : 'rejected',
            ...(answer?.remember === true ? { scope: 'session' } : {}),
            ...(typeof answer?.comment === 'string' ? { feedback: answer.comment } : {}),
            ...(typeof answer?.choice === 'string' && answer.choice
              ? { selectedLabel: answer.choice } : {}),
          });
        },
        onQuestion: async (question, respond) => {
          const rawQuestions = Array.isArray(question.questions) ? question.questions : [];
          const questions = rawQuestions.map((entry, index) => {
            const item = entry as Record<string, unknown>;
            const options = Array.isArray(item.options) ? item.options : [];

            return {
              key: String(item.id || `q_${index}`),
              header: String(item.header || item.title || `Вопрос ${index + 1}`),
              question: String(item.question || item.text || ''),
              options,
              multiSelect: item.multi_select === true || item.multiSelect === true,
              allowFreeText: true,
            };
          });
          const answer = await onPermission?.({
            tool: 'Вопрос агента',
            isQuestion: true,
            questions,
            prompt: String(question.prompt || question.text || ''),
            source: 'Kimi',
            acceptsText: true,
            raw: question,
            signal,
          });
          const answers: Record<string, unknown> = {};

          for (let index = 0; index < questions.length; index += 1) {
            const current = questions[index];

            if (!current) {
              continue;
            }

            const questionAnswer = answer?.rawAnswers?.[index];
            const selected = Array.isArray(questionAnswer?.selected) ? questionAnswer.selected : [];
            const ownText = String(questionAnswer?.text || '').trim();
            const options = current.options as Array<{ id?: unknown; label?: unknown }>;
            const selectedIds = selected.map((label) => String(
              options.find((option) => option.label === label)?.id || label,
            ));
            const key = current.key;

            if (selectedIds.length && ownText) {
              answers[key] = {
                kind: 'multi_with_other',
                option_ids: selectedIds,
                other_text: ownText,
              };
            } else if (ownText) {
              answers[key] = { kind: 'other', text: ownText };
            } else if (selectedIds.length > 1 || current.multiSelect) {
              answers[key] = selectedIds.length
                ? { kind: 'multi', option_ids: selectedIds }
                : { kind: 'skipped' };
            } else {
              answers[key] = selectedIds.length
                ? { kind: 'single', option_id: selectedIds[0] }
                : { kind: 'skipped' };
            }
          }

          await respond({ answers, method: 'click' });
        },
        startServer: launchMode === 'contained'
          ? (input) => (deps.startServer || startKimiServer)({
            ...input,
            launch: {
              command: launch!.command,
              args: launch!.args,
              cwd: launch!.cwdReal,
              env: kimiSystemdClientEnv(),
            },
            socketPath: path.join(controlDir, 's'),
          })
          : deps.startServer,
        log,
      });

      return {
        ...result,
        cost: null,
        contextCache: contextCacheStatus('unavailable'),
        emptyRun: !result.reply && result.steps.length === 0,
        retryState: 'post_prompt',
      };
    }
    child = spawnProcess(launch.command, launch.args, {
      cwd: launch.cwdReal,
      env: launchMode === 'host' ? launch.env : kimiSystemdClientEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exit = waitForExit(child);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${String(chunk || '')}`.slice(-8_000);
    });

    let reply = '';
    let statusText = '';
    let replyTruncated = false;
    let captureStatus = false;
    // Запрос разрешения не несёт ни kind, ни аргументов вызова — их несёт
    // notification того же toolCallId. Без этой памяти всплывашка показывала
    // действие без команды, а кокпит-режим «Авто» fail-closed спрашивал человека
    // про каждое чтение файла: классификатор решает как раз по kind.
    const toolCalls = new Map<string, ToolCallContext>();
    const rememberToolCall = (update: KimiUpdate) => {
      const id = String(update?.toolCallId || '');
      if (!id) return;
      const prev = toolCalls.get(id) || {};
      toolCalls.set(id, {
        kind: update.kind || prev.kind || '',
        title: update.title || prev.title || '',
        rawInput: update.rawInput ?? prev.rawInput,
      });
      const oldest = toolCalls.size > 200 ? toolCalls.keys().next().value : '';
      if (oldest) toolCalls.delete(oldest);
    };
    const client = createAcpClient(child, {
      onNotification(method, params) {
        if (method !== 'session/update') return;
        const notification = params as { update?: KimiUpdate } | null;
        const update = notification?.update;
        if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
          rememberToolCall(update);
        }
        if (update?.sessionUpdate === 'agent_message_chunk') {
          const text = textOfContent(update.content);
          if (captureStatus) statusText = `${statusText}${text}`.slice(0, MAX_STATUS_BYTES);
          else if (reply.length < MAX_REPLY_BYTES) {
            const next = `${reply}${text}`;
            replyTruncated ||= next.length > MAX_REPLY_BYTES;
            reply = next.slice(0, MAX_REPLY_BYTES);
          } else {
            replyTruncated = true;
          }
        }
        if (!captureStatus) stepSink.emitAll(normalizeStep(notification));
        if (update?.sessionUpdate === 'agent_message_chunk' || update?.sessionUpdate === 'tool_call') {
          promptState = 'post_prompt';
        }
      },
      async onReverseRequest(method, value) {
        if (method !== 'session/request_permission') throw new Error(`ACP reverse method не разрешён: ${method}`);
        const params = value as AcpPermissionParams | null;
        const workPrefix = 'mcp__cockpit-work__';
        const title = String(params?.toolCall?.title || '');
        if (title.startsWith(workPrefix) && workNames.has(title.slice(workPrefix.length))) {
          return selectPermissionOutcome(params, { allow: true });
        }
        // Размышление, за которым последовал спрос, должно быть уже в ленте:
        // человек решает по нему, а не по одной строке действия.
        stepSink.emitAll(normalizeStep.flush());
        const context = toolCalls.get(String(params?.toolCall?.toolCallId || '')) || {};
        const presentation = permissionPresentation(params, context);
        const answer = onPermission
          ? await onPermission({ ...presentation, raw: params })
          : { allow: false };
        return selectPermissionOutcome(params, answer);
      },
    });

    const abort = async () => {
      if (stopped) return;
      stopped = true;
      if (sessionId) {
        try { client.notify('session/cancel', { sessionId }); } catch { /* transport уже закрыт */ }
      }
      setTimeout(() => {
        if (launch?.unit) stopUnit(launch.unit, { systemctlBin: config.kimiSystemctlBin }).catch(() => {});
        child?.kill('SIGTERM');
      }, 1_500).unref?.();
    };
    if (signal?.aborted) await abort();
    signal?.addEventListener('abort', abort, { once: true });

    const initialized = await initializeKimiAcp(client) as {
      agentInfo?: { version?: string };
      protocolVersion?: number;
    } | null;
    // В host-режиме patch-версия host CLI не пинится (обновляет пользователь):
    // проверяем только протокол. contained держит полный pinned contract.
    const versionMatches = launchMode === 'host'
      || initialized?.agentInfo?.version === REQUIRED_KIMI_VERSION;
    if (initialized?.protocolVersion !== 1 || !versionMatches) {
      throw new Error('Kimi ACP protocol/version не совпал с pinned contract');
    }
    let currentSession = sessionId || '';
    if (currentSession) {
      await client.request('session/resume', {
        sessionId: currentSession,
        cwd: launch.cwdReal,
        mcpServers: sessionMcpServers,
      }, 30_000);
    } else {
      const created = await client.request('session/new', {
        cwd: launch.cwdReal,
        mcpServers: sessionMcpServers,
      }, 30_000);
      currentSession = String((created as { sessionId?: unknown } | null)?.sessionId || '');
      if (!currentSession) throw new Error('Kimi ACP не вернул sessionId');
      // Binding сохраняется ДО config/prompt: окно/поддельный клиент не сможет
      // присвоить эту provider session другому чату.
      await onSessionCreated?.(currentSession);
      sessionId = currentSession;
    }
    const setConfigOption = (configId: string, value: unknown) => client.request(
      'session/set_config_option',
      { sessionId: currentSession, configId, value },
      15_000,
    );
    if (launchMode === 'host') {
      // Host config может не определять pinned id вида kimi-code/k3: модель/effort —
      // best-effort, фактическую покажет /status. Отказ не должен валить ход.
      await setConfigOption('model', model).catch((error: unknown) => {
        log?.warn?.(
          { model, reason: (error as Error)?.message },
          'Kimi host: модель не принята host config, остаётся default',
        );
      });
      if (effort) {
        await setConfigOption('thinking', effort).catch((error: unknown) => {
          log?.warn?.(
            { effort, reason: (error as Error)?.message },
            'Kimi host: effort не принят host config',
          );
        });
      }
    } else {
      await setConfigOption('model', model);
      if (effort) await setConfigOption('thinking', effort);
    }
    // ACP-режимы Kimi (сверено с бинарём 0.33.0, ACP_MODES): default | plan | auto | yolo.
    // Кокпит-режим «Авто» сюда НЕ маппится намеренно: это политика ОТВЕТОВ на
    // permission-запросы (auto-approve.js), и ACP обязан продолжать спрашивать —
    // иначе классификатору кокпита нечего решать. А «yolo» — именно ACP-режим:
    // агент не спрашивает вовсе, границу держит runtime (contained) либо доверие
    // человека (host), поэтому в кокпите он отдельный пункт списка режимов.
    const acpMode = ACP_MODE_BY_PERMISSION[String(permissionMode)] || 'default';
    await client.request('session/set_config_option', {
      sessionId: currentSession, configId: 'mode', value: acpMode,
    }, 15_000);

    if (signal?.aborted) await abort();
    if (stopped) {
      throw Object.assign(new Error('Ход остановлен.'), {
        stopped: true,
        steps: stepSink.steps,
        sessionId: currentSession,
      });
    }
    const safeMessage = staged
      ? replaceAttachmentPaths(message, staged, attachmentPaths)
      : String(message || '');
    promptState = 'prompt_sent';
    const promptResult = await client.request('session/prompt', {
      sessionId: currentSession,
      prompt: [{ type: 'text', text: safeMessage }],
    });
    promptState = 'post_prompt';
    // Хвост размышления, за которым не последовало действия: агент подумал и
    // ответил текстом. Без явного flush он пропал бы вместе с нормализатором.
    stepSink.emitAll(normalizeStep.flush());
    const stopReason = (promptResult as { stopReason?: unknown } | null)?.stopReason;
    if (stopReason === 'cancelled' || signal?.aborted) stopped = true;

    // Локальные ACP-команды: модель не вызывается, зато получаем точный размер
    // контекста из уже открытой session. На 0.31 размер строкой «- Context:» даёт
    // /status; с 0.33 его вынесли в /usage, а /status оставили без него.
    const runLocalCommand = async (command: string) => {
      captureStatus = true;
      try {
        await client.request('session/prompt', {
          sessionId: currentSession,
          prompt: [{ type: 'text', text: command }],
        }, 15_000).catch(() => {});
      } finally {
        captureStatus = false;
      }
    };
    await runLocalCommand('/status');
    if (parseStatus(statusText, 0).contextMetric === 'unavailable') await runLocalCommand('/usage');
    client.close();
    const ended = await Promise.race([
      exit,
      new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        const timer = setTimeout(() => resolve({ code: null, signal: 'TIMEOUT' }), 8_000);
        timer.unref?.();
      }),
    ]);
    if (ended.signal === 'TIMEOUT') {
      if (launch?.unit) await stopUnit(launch.unit, { systemctlBin: config.kimiSystemctlBin });
      child?.kill('SIGTERM');
    }

    if (stopped) {
      const stoppedStatus = parseStatus(statusText, modelInfo.context);
      throw Object.assign(new Error('Ход остановлен.'), {
        stopped: true,
        steps: stepSink.steps,
        sessionId: currentSession,
        contextTokens: stoppedStatus.contextTokens,
        contextWindow: stoppedStatus.contextWindow,
        contextMetric: stoppedStatus.contextMetric,
        contextIsEstimate: stoppedStatus.contextIsEstimate,
        contextCache: contextCacheStatus('unavailable'),
      });
    }
    const status = parseStatus(statusText, modelInfo.context);

    if (status.actualModel) {
      onRunMetadata?.({ actualModelId: status.actualModel, modelSource: 'session' });
    }

    const emptyRun = !reply.trim() && stepSink.steps.length === 0;
    if (emptyRun && ended.code && ended.code !== 0) {
      throw Object.assign(
        new Error(stderrTail.trim().slice(-800) || `Kimi ACP завершился с кодом ${ended.code}`),
        { retryState: promptState },
      );
    }
    try {
      onProgress?.(0, {
        contextTokens: status.contextTokens,
        contextWindow: status.contextWindow,
        contextMetric: status.contextMetric,
        contextIsEstimate: status.contextIsEstimate,
        contextCache: contextCacheStatus('unavailable'),
      });
    } catch { /* UI callback не влияет на ход */ }
    return {
      reply: `${reply.trim()}${replyTruncated ? '\n\n[Ответ Kimi сокращён: превышен лимит вывода Cockpit.]' : ''}`,
      sessionId: currentSession,
      cost: null,
      steps: stepSink.steps,
      actualModel: status.actualModel || model,
      contextTokens: status.contextTokens,
      contextWindow: status.contextWindow,
      contextMetric: status.contextMetric,
      contextIsEstimate: status.contextIsEstimate,
      contextCache: contextCacheStatus('unavailable'),
      emptyRun,
      retryState: promptState,
    };
  } catch (thrown) {
    // Состояние хода дописываем прямо на ошибке: выше по стеку читают именно эти
    // поля, и потерять их значит показать человеку голое «сбой».
    const error = thrown as {
      retryState?: string;
      stopped?: boolean;
      sessionId?: string | null;
      steps?: unknown;
    };
    error.retryState ||= promptState;
    // Остановленный ход тоже показывает, до чего агент додумался: недособранное
    // размышление отдаём в ленту, иначе «стоп» стирает последние минуты работы.
    if (error.stopped || signal?.aborted) {
      try { stepSink.emitAll(normalizeStep.flush()); } catch { /* лента не роняет ход */ }
    }
    if (signal?.aborted && !error.stopped) {
      error.stopped = true;
      error.sessionId = sessionId || null;
    }
    if (error.stopped) error.steps = stepSink.steps;
    throw error;
  } finally {
    if (transport === 'server' && launch?.unit) {
      await stopUnit(launch.unit, { systemctlBin: config.kimiSystemctlBin });
    }
    if (child && !child.killed && child.exitCode === null) {
      if (launch?.unit) await stopUnit(launch.unit, { systemctlBin: config.kimiSystemctlBin });
      child.kill('SIGTERM');
    }
    await proxy?.close().catch(() => {});
    await staged?.cleanup?.().catch(() => {});
    await hostWebHome?.cleanup().catch(() => {});
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}

export {
  assertPinnedVersion,
  parseStatus,
  permissionPresentation,
  selectPermissionOutcome,
};
