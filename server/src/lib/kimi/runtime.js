import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { createStepSink } from '../chat/stream-steps.js';
import { contextCacheStatus } from '../chat/context-cache.js';
import { createKimiStepNormalizer } from '../executors/_kimi-steps.js';
import { createAcpClient, initializeKimiAcp } from './acp-client.js';
import { stageKimiAttachments } from './attachments.js';
import {
  createKimiEgressProxy,
  KIMI_EGRESS_ALLOWLIST_VERSION,
} from './egress-proxy.js';
import { buildKimiHostLaunch } from './host-launch.js';
import { KIMI_MODELS } from './profile.js';
import { inspectKimiRuntimeHost } from './runtime-preflight.js';
import {
  buildKimiSandboxLaunch,
  KIMI_EGRESS_SOCKET_FILE,
  kimiSystemdClientEnv,
  stopKimiUnit,
} from './sandbox.js';

const REQUIRED_KIMI_VERSION = '0.31.1';
// Режим кокпита → режим ACP-сессии. Не перечисленное остаётся в `default`.
const ACP_MODE_BY_PERMISSION = { plan: 'plan', yolo: 'yolo' };
const MAX_REPLY_BYTES = 8 * 1024 * 1024;
const MAX_STATUS_BYTES = 64 * 1024;

function commandOutput(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 10_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout || '').trim());
    });
  });
}

async function assertPinnedVersion(config, run = commandOutput) {
  const output = await run(config.kimiBin, ['--version']);
  const version = output.match(/\d+\.\d+\.\d+/)?.[0] || '';
  if (version !== REQUIRED_KIMI_VERSION) {
    throw new Error(`Kimi ${version || 'unknown'} не прошёл ACP contract gate: ожидается ${REQUIRED_KIMI_VERSION}`);
  }
  return version;
}

function textOfContent(content) {
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
function permissionContent(toolCall) {
  const list = Array.isArray(toolCall?.content) ? toolCall.content : [];
  const texts = [];
  let diff = null;
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

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim()) || '';
}

/**
 * Вопрос агента поверх ACP. Мост Kimi несёт только optionId, поэтому пояснений
 * к вариантам нет, свой текст доехать не может, а мультивыбор сам мост сводит
 * к одному варианту (его же телеметрия зовёт это question_degraded). Врать
 * человеку чекбоксами нельзя — говорим об ограничении прямо.
 */
function questionPresentation(options, question) {
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
function permissionPresentation(params, context = {}) {
  const options = Array.isArray(params?.options) ? params.options : [];
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
  const raw = context.rawInput && typeof context.rawInput === 'object' ? context.rawInput : {};
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

function selectPermissionOutcome(params, answer) {
  if (answer?.outcome?.outcome === 'selected' || answer?.outcome?.outcome === 'cancelled') return answer;
  const options = Array.isArray(params?.options) ? params.options : [];
  const byId = (id) => options.find((candidate) => candidate.optionId === id);
  const byKind = (kind) => options.find((candidate) => candidate.kind === kind);
  const pick = (option) => (option
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

function parseStatus(text, fallbackWindow) {
  // Формат 0.31: «- Context: 1,234 / 262,144 (0.5%)» строкой в /status.
  // Формат 0.33+: «Context: 1,234 / 262,144 tokens (0%)» строкой в /usage.
  const match = String(text || '').match(/-?\s*Context:\s*([\d,]+)\s*\/\s*([\d,]+)/i);
  // 0.33+ убрал маркер «- » и добавляет суффикс «(thinking: on)».
  const model = String(text || '').match(/-?\s*Model:\s*(.+)/i)?.[1]?.trim()
    .replace(/\s*\(thinking:[^)]*\)\s*$/i, '') || '';
  if (!match) return {
    contextTokens: 0,
    contextWindow: fallbackWindow || 0,
    contextMetric: 'unavailable',
    contextIsEstimate: true,
    actualModel: model,
  };
  return {
    contextTokens: Number(match[1].replaceAll(',', '')) || 0,
    contextWindow: Number(match[2].replaceAll(',', '')) || fallbackWindow || 0,
    contextMetric: 'kimi-session-status',
    contextIsEstimate: false,
    actualModel: model,
  };
}

function replaceAttachmentPaths(message, staged, sourcePaths) {
  let result = String(message || '');
  staged.files.forEach((file, index) => {
    result = result.split(sourcePaths[index]).join(file.sandboxPath);
  });
  return result;
}

function waitForExit(child) {
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
  chatKey,
  mcpServers = [],
  log,
  deps = {},
} = {}) {
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
    const error = new Error(
      'Kimi host не умеет обеспечить запрет прямого SSH: включи contained '
      + 'или подтверждённо выключи настройку.',
    );
    error.code = 'direct_ssh_policy_unavailable';
    throw error;
  }
  const checkVersion = deps.assertVersion || assertPinnedVersion;
  if (launchMode === 'host') {
    // Host CLI обновляется пользователем: жёсткий пин ломал бы чат при любом
    // апгрейде. Protocol gate в initializeKimiAcp остаётся обязательным.
    await checkVersion(config).catch((error) => {
      log?.warn({ reason: error?.message }, 'Kimi host: pinned version gate пропущен, продолжаю по ACP protocol gate');
    });
  } else {
    await checkVersion(config);
  }

  const modelInfo = KIMI_MODELS.find((entry) => entry.id === model);
  if (!modelInfo) throw new Error(`Kimi model не прошла pinned catalog gate: ${model}`);
  if (effort && !modelInfo.efforts.includes(effort)) throw new Error(`Kimi effort не поддерживается: ${effort}`);

  // contained-only состояние: per-chat KIMI_CODE_HOME, broker, egress socket,
  // staging вложений. Host-режим пишет сессии в реальный kimiHome и ничего из
  // этого не создаёт.
  let runtimeHome = null;
  let brokerHome = null;
  let runId = null;
  let runDir = null;
  let stagingParent = null;
  let egressSocketPath = null;
  let proxy = null;
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
    await Promise.all([runtimeHome, brokerHome, egressDir, stagingParent]
      .map((dir) => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
    egressSocketPath = path.join(egressDir, KIMI_EGRESS_SOCKET_FILE);
    proxy = makeProxy({ socketPath: egressSocketPath });
  }
  let staged = null;
  let child = null;
  let launch = null;
  let stderrTail = '';
  let stopped = false;
  let promptState = 'pre_prompt';
  const stepSink = createStepSink(onStep);
  const normalizeStep = createKimiStepNormalizer({ model, cwd, mode: permissionMode || 'manual' });
  let sessionMcpServers = mcpServers;
  let containedWorkMcp = null;
  if (launchMode === 'contained') {
    const work = mcpServers.find((entry) => entry?.name === 'cockpit-work');
    if (work) {
      const socketAt = work.args?.indexOf('--socket') ?? -1;
      const nonceAt = work.args?.indexOf('--nonce') ?? -1;
      const scriptPath = work.args?.[0];
      const socketPath = socketAt >= 0 ? work.args[socketAt + 1] : '';
      const nonce = nonceAt >= 0 ? work.args[nonceAt + 1] : '';
      if (!scriptPath || !socketPath || !nonce) throw new Error('kimi_work_mcp_invalid');
      containedWorkMcp = { scriptPath, socketPath };
      sessionMcpServers = mcpServers.map((entry) => (entry === work ? {
        ...entry,
        command: '/usr/bin/node',
        args: [
          '/opt/cockpit/work-mcp.js',
          '--socket', '/run/cockpit-work/work.sock',
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
        log?.error({ checks: gate.checks }, 'Kimi runtime security gate: NO_GO');
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
    } else {
      const safeExtraDirs = extraDirs.filter((dir) => path.resolve(dir) !== path.resolve(config.chatsDir, 'attachments'));
      launch = await buildLaunch({
        config: { ...config, kimiRuntimeHome: runtimeHome, kimiRuntimeBroker: brokerHome },
        cwd,
        extraDirs: safeExtraDirs,
        attachmentDir: staged?.stagingDir,
        egressSocketPath,
        workMcp: containedWorkMcp,
        unit: `cockpit-kimi-${runId}.service`,
      });
    }
    if (launch.rejectedExtraDirs?.length) {
      log?.warn({
        count: launch.rejectedExtraDirs.length,
        reasons: [...new Set(launch.rejectedExtraDirs.map((entry) => entry.reason))],
      }, 'Kimi runtime: небезопасные дополнительные каталоги не смонтированы');
    }
    if (launch.maskedWorkspacePaths?.length) {
      log?.info({
        paths: launch.maskedWorkspacePaths,
      }, 'Kimi runtime: control state внутри доверенных каталогов замаскирован');
    }
    child = spawnProcess(launch.command, launch.args, {
      cwd: launch.cwdReal,
      env: launchMode === 'host' ? launch.env : kimiSystemdClientEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exit = waitForExit(child);
    child.stderr?.on('data', (chunk) => {
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
    const toolCalls = new Map();
    const rememberToolCall = (update) => {
      const id = String(update?.toolCallId || '');
      if (!id) return;
      const prev = toolCalls.get(id) || {};
      toolCalls.set(id, {
        kind: update.kind || prev.kind || '',
        title: update.title || prev.title || '',
        rawInput: update.rawInput ?? prev.rawInput,
      });
      if (toolCalls.size > 200) toolCalls.delete(toolCalls.keys().next().value);
    };
    const client = createAcpClient(child, {
      onNotification(method, params) {
        if (method !== 'session/update') return;
        const update = params?.update;
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
        if (!captureStatus) stepSink.emitAll(normalizeStep(params));
        if (update?.sessionUpdate === 'agent_message_chunk' || update?.sessionUpdate === 'tool_call') {
          promptState = 'post_prompt';
        }
      },
      async onReverseRequest(method, params) {
        if (method !== 'session/request_permission') throw new Error(`ACP reverse method не разрешён: ${method}`);
        if (params?.toolCall?.title === 'mcp__cockpit-work__supervised_ssh') {
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
        child.kill('SIGTERM');
      }, 1_500).unref?.();
    };
    if (signal?.aborted) await abort();
    signal?.addEventListener('abort', abort, { once: true });

    const initialized = await initializeKimiAcp(client);
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
      currentSession = String(created?.sessionId || '');
      if (!currentSession) throw new Error('Kimi ACP не вернул sessionId');
      // Binding сохраняется ДО config/prompt: окно/поддельный клиент не сможет
      // присвоить эту provider session другому чату.
      await onSessionCreated?.(currentSession);
      sessionId = currentSession;
    }
    const setConfigOption = (configId, value) => client.request('session/set_config_option', {
      sessionId: currentSession, configId, value,
    }, 15_000);
    if (launchMode === 'host') {
      // Host config может не определять pinned id вида kimi-code/k3: модель/effort —
      // best-effort, фактическую покажет /status. Отказ не должен валить ход.
      await setConfigOption('model', model).catch((error) => {
        log?.warn({ model, reason: error?.message }, 'Kimi host: модель не принята host config, остаётся default');
      });
      if (effort) {
        await setConfigOption('thinking', effort).catch((error) => {
          log?.warn({ effort, reason: error?.message }, 'Kimi host: effort не принят host config');
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
    const acpMode = ACP_MODE_BY_PERMISSION[permissionMode] || 'default';
    await client.request('session/set_config_option', {
      sessionId: currentSession, configId: 'mode', value: acpMode,
    }, 15_000);

    if (signal?.aborted) await abort();
    if (stopped) {
      const error = new Error('Ход остановлен.');
      error.stopped = true;
      error.steps = stepSink.steps;
      error.sessionId = currentSession;
      throw error;
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
    if (promptResult?.stopReason === 'cancelled' || signal?.aborted) stopped = true;

    // Локальные ACP-команды: модель не вызывается, зато получаем точный размер
    // контекста из уже открытой session. На 0.31 размер строкой «- Context:» даёт
    // /status; с 0.33 его вынесли в /usage, а /status оставили без него.
    const runLocalCommand = async (command) => {
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
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ code: null, signal: 'TIMEOUT' }), 8_000);
        timer.unref?.();
      }),
    ]);
    if (ended.signal === 'TIMEOUT') {
      if (launch?.unit) await stopUnit(launch.unit, { systemctlBin: config.kimiSystemctlBin });
      child.kill('SIGTERM');
    }

    if (stopped) {
      const error = new Error('Ход остановлен.');
      error.stopped = true;
      error.steps = stepSink.steps;
      error.sessionId = currentSession;
      const status = parseStatus(statusText, modelInfo.context);
      error.contextTokens = status.contextTokens;
      error.contextIsEstimate = status.contextIsEstimate;
      error.contextCache = contextCacheStatus('unavailable');
      throw error;
    }
    const status = parseStatus(statusText, modelInfo.context);
    const emptyRun = !reply.trim() && stepSink.steps.length === 0;
    if (emptyRun && ended.code && ended.code !== 0) {
      const error = new Error(stderrTail.trim().slice(-800) || `Kimi ACP завершился с кодом ${ended.code}`);
      error.retryState = promptState;
      throw error;
    }
    try { onProgress?.(0); } catch { /* UI callback не влияет на ход */ }
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
  } catch (error) {
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
    if (child && !child.killed && child.exitCode === null) {
      if (launch?.unit) await stopUnit(launch.unit, { systemctlBin: config.kimiSystemctlBin });
      child.kill('SIGTERM');
    }
    await proxy?.close().catch(() => {});
    await staged?.cleanup?.().catch(() => {});
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}

export {
  assertPinnedVersion,
  parseStatus,
  permissionPresentation,
  selectPermissionOutcome,
};
