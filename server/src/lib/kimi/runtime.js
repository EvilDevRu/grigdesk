import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { createStepSink } from '../chat/stream-steps.js';
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

function permissionPresentation(params) {
  const options = Array.isArray(params?.options) ? params.options : [];
  const question = options.some((option) => /^q\d+_/.test(option?.optionId || ''));
  const content = Array.isArray(params?.toolCall?.content)
    ? params.toolCall.content.map((entry) => textOfContent(entry?.content)).filter(Boolean).join('\n')
    : '';
  if (question) {
    return {
      isQuestion: true,
      questions: [{
        header: 'Kimi',
        question: content || 'Выберите ответ',
        multiSelect: false,
        options: options.filter((option) => option.kind !== 'reject_once').map((option) => ({
          label: option.name,
          description: '',
        })),
      }],
    };
  }
  return {
    isQuestion: false,
    tool: params?.toolCall?.title || 'Действие Kimi',
    input: {
      description: content,
      toolCallId: params?.toolCall?.toolCallId || '',
      options: options.map((option) => ({
        id: option.optionId, label: option.name, kind: option.kind,
      })),
    },
  };
}

function selectPermissionOutcome(params, answer) {
  if (answer?.outcome?.outcome === 'selected' || answer?.outcome?.outcome === 'cancelled') return answer;
  const options = Array.isArray(params?.options) ? params.options : [];
  const questionOptions = options.filter((option) => /^q\d+_opt_/.test(option.optionId || ''));
  if (questionOptions.length) {
    const selected = answer?.selected?.[0] || answer?.text || '';
    const option = questionOptions.find((candidate) => candidate.name === selected);
    const skip = options.find((candidate) => /_skip$/.test(candidate.optionId || ''));
    return option || skip
      ? { outcome: { outcome: 'selected', optionId: (option || skip).optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }
  const wantedKind = answer?.allow ? 'allow_once' : 'reject_once';
  const option = options.find((candidate) => candidate.kind === wantedKind)
    || (!answer?.allow ? options.find((candidate) => candidate.kind === 'reject_always') : null);
  return option
    ? { outcome: { outcome: 'selected', optionId: option.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

function parseStatus(text, fallbackWindow) {
  const match = String(text || '').match(/- Context:\s*([\d,]+)\s*\/\s*([\d,]+)/i);
  const model = String(text || '').match(/- Model:\s*(.+)/i)?.[1]?.trim() || '';
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
  signal,
  onStep,
  onProgress,
  onPermission,
  onSessionCreated,
  chatKey,
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
    const client = createAcpClient(child, {
      onNotification(method, params) {
        if (method !== 'session/update') return;
        const update = params?.update;
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
        const presentation = permissionPresentation(params);
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
      await client.request('session/resume', { sessionId: currentSession, cwd: launch.cwdReal, mcpServers: [] }, 30_000);
    } else {
      const created = await client.request('session/new', { cwd: launch.cwdReal, mcpServers: [] }, 30_000);
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
    // ACP-режимов два: default и plan. Кокпит-режим «auto» сюда не маппится: это
    // политика ответов на permission-запросы (auto-approve.js), сам ACP остаётся
    // в default и продолжает спрашивать. ACP auto/yolo заблокированы security gate.
    const acpMode = permissionMode === 'plan' ? 'plan' : 'default';
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
    if (promptResult?.stopReason === 'cancelled' || signal?.aborted) stopped = true;

    // Локальная ACP-команда: модель не вызывается, зато получаем точный размер
    // контекста из уже открытой session.
    captureStatus = true;
    await client.request('session/prompt', {
      sessionId: currentSession,
      prompt: [{ type: 'text', text: '/status' }],
    }, 15_000).catch(() => {});
    captureStatus = false;
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
      emptyRun,
      retryState: promptState,
    };
  } catch (error) {
    error.retryState ||= promptState;
    if (signal?.aborted && !error.stopped) {
      error.stopped = true;
      error.steps = stepSink.steps;
      error.sessionId = sessionId || null;
    }
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
