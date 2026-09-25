#!/usr/bin/env node

// Версионированный fake app-server по TypeScript-схеме `codex-cli 0.149.0`.
// Он закрепляет wire-форму JSON-RPC v2 без настоящего model call и аккаунта OpenAI.
import { appendFileSync, createReadStream, writeSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export const CODEX_APP_SERVER_COMPATIBILITY = Object.freeze({
  cli: 'codex-cli 0.149.0',
  protocol: 'app-server-v2',
  transport: 'stdio-jsonl',
  schemaSource: 'codex app-server generate-ts',
});

const THREAD_ID = '00000000-0000-7000-8000-000000000049';
const TURN_ID = '00000000-0000-7000-8000-00000000004a';
const FOREIGN_THREAD_ID = '00000000-0000-7000-8000-00000000004b';
const FOREIGN_TURN_ID = '00000000-0000-7000-8000-00000000004c';
const STALE_TURN_ID = '00000000-0000-7000-8000-00000000004d';
const UPDATE_DIFF = '@@ -1 +1 @@\n-export const answer = 41;\n+export const answer = 42;\n';
// Созданному файлу app-server кладёт в `diff` не patch, а само содержимое —
// unified-форма у него есть только в общем `turn/diff/updated`.
const ADD_CONTENT = 'export function ready() {\n  return true;\n}\n';
const ADD_DIFF = '@@ -0,0 +1,3 @@\n+export function ready() {\n+  return true;\n+}\n';

function runFixture() {
  const traceFile = process.env.COCKPIT_CODEX_FIXTURE_TRACE || '';
  const scenario = process.env.COCKPIT_CODEX_FIXTURE_SCENARIO || 'rich';
  // Базовая fixture остаётся снимком 0.149, а dynamic tool сценарии могут
  // проверить актуальный wire-контракт без дублирования всего app-server.
  const cliVersion = process.env.COCKPIT_CODEX_FIXTURE_CLI_VERSION || '0.149.0';
  const expectHook = process.env.COCKPIT_CODEX_FIXTURE_EXPECT_HOOK !== '0';
  const hookState = process.env.COCKPIT_CODEX_FIXTURE_HOOK_STATE || 'enabled';
  const argv = process.argv.slice(2);
  const hookConfigIndex = argv.findIndex((value, index) => (
    argv[index - 1] === '-c' && String(value).startsWith('hooks.PreToolUse=')
  ));
  const hookConfig = hookConfigIndex >= 0 ? String(argv[hookConfigIndex]) : '';
  const hookCommand = hookConfig.match(/command\s*=\s*"([^"]+)"/)?.[1] || '';
  const hookMatcher = hookConfig.match(/matcher\s*=\s*"([^"]+)"/)?.[1] || '';
  let phase = 'initialize';
  let resumed = false;
  let fixtureInput = null;

  function trace(entry) {
    if (!traceFile) return;
    appendFileSync(traceFile, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  function send(message) {
    trace({ direction: 'server', message });
    writeSync(1, `${JSON.stringify(message)}\n`);
  }

  function sendBatch(messages) {
    for (const message of messages) trace({ direction: 'server', message });
    writeSync(1, messages.map((message) => `${JSON.stringify(message)}\n`).join(''));
  }

  function fail(message) {
    trace({ direction: 'fixture-error', message });
    writeSync(2, `${message}\n`);
    process.exitCode = 64;
    fixtureInput?.destroy();
    process.stdin.destroy();
  }

  trace({ direction: 'process', argv, compatibility: CODEX_APP_SERVER_COMPATIBILITY, scenario });
  if (argv.at(-1) !== 'app-server') {
    fail(`Codex transport: последним аргументом требуется app-server, получено ${argv.join(' ')}`);
    return;
  }
  if (argv.includes('--strict-config')) {
    fail('Codex transport: chat policy не должна валидировать чужой config через --strict-config');
    return;
  }
  if (expectHook && (!argv.includes('--dangerously-bypass-hook-trust')
    || !hookConfig.includes('_direct-ssh-policy-hook.js'))) {
    fail('Codex transport: default-on запуск не получил доверенный server-owned SSH hook');
    return;
  }
  if (!expectHook && (argv.includes('--dangerously-bypass-hook-trust') || hookConfig)) {
    fail('Codex transport: explicit false не должен подключать SSH hook');
    return;
  }

  const thread = {
    id: THREAD_ID,
    extra: null,
    sessionId: THREAD_ID,
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: 'legacy',
    modelProvider: 'openai',
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    recencyAt: 1_700_000_000,
    status: { type: 'idle' },
    path: null,
    cwd: process.cwd(),
    cliVersion,
    source: 'appServer',
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
  const runningTurn = {
    id: TURN_ID,
    items: [],
    itemsView: 'full',
    status: 'inProgress',
    error: null,
    startedAt: 1_700_000_001,
    completedAt: null,
    durationMs: null,
  };

  // Собственные замеры идут до завершения хода и могут уменьшаться после сжатия.
  function emitContextUsage() {
    for (const inputTokens of [180_000, 60_000]) {
      send({ method: 'thread/tokenUsage/updated', params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        tokenUsage: {
          last: { inputTokens, cachedInputTokens: inputTokens - 1_000, outputTokens: 50 },
          total: { inputTokens: 900_000, cachedInputTokens: 850_000, outputTokens: 100 },
          modelContextWindow: 256_000,
        },
      } });
    }
  }

  // Расход хода: накопитель потока (`total`) растёт, а `last` у каждого обращения к модели
  // свой. Счётчик хода обязан брать прирост накопителя — по `last` цифра прыгала бы вниз.
  // Рассуждения в замере идут ВНУТРИ outputTokens (в аналитике они атрибут той же метрики),
  // поэтому отдельным слагаемым их прибавлять нельзя.
  function emitTokenProgressTurn() {
    for (const [lastOutput, totalOutput] of [[50, 100], [40, 350]]) {
      send({ method: 'thread/tokenUsage/updated', params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        tokenUsage: {
          last: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: lastOutput },
          total: {
            inputTokens: 5_000,
            cachedInputTokens: 0,
            outputTokens: totalOutput,
            reasoningOutputTokens: 120,
          },
          modelContextWindow: 256_000,
        },
      } });
    }
    const reply = 'Расход хода посчитан.';
    send({ method: 'item/completed', params: {
      threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 1_700_000_001_800,
      item: {
        type: 'agentMessage', id: 'answer-progress-1', text: reply, phase: 'final_answer',
        memoryCitation: null, delivery: null,
      },
    } });
    send({ method: 'turn/completed', params: {
      threadId: THREAD_ID,
      turn: {
        ...runningTurn,
        status: 'completed',
        completedAt: 1_700_000_002,
        durationMs: 1_000,
      },
    } });
    setTimeout(() => process.exit(0), 20);
  }

  function emitRichTurn() {
    send({ method: 'turn/plan/updated', params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      explanation: 'Сначала проверка, затем правка.',
      plan: [
        { step: 'Проверить текущее состояние', status: 'completed' },
        { step: 'Исправить два файла', status: 'inProgress' },
      ],
    } });

    send({ method: 'item/started', params: {
      threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: 1_700_000_001_100,
      item: {
        type: 'agentMessage', id: 'commentary-1', text: '', phase: 'commentary',
        memoryCitation: null, delivery: null,
      },
    } });
    send({ method: 'item/agentMessage/delta', params: {
      threadId: THREAD_ID, turnId: TURN_ID, itemId: 'commentary-1', delta: 'Проверяю ',
    } });
    send({ method: 'item/agentMessage/delta', params: {
      threadId: THREAD_ID, turnId: TURN_ID, itemId: 'commentary-1', delta: 'файлы перед правкой.',
    } });
    send({ method: 'item/completed', params: {
      threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 1_700_000_001_200,
      item: {
        type: 'agentMessage', id: 'commentary-1', text: 'Проверяю файлы перед правкой.',
        phase: 'commentary', memoryCitation: null, delivery: null,
      },
    } });

    send({ method: 'item/started', params: {
      threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: 1_700_000_001_300,
      item: {
        type: 'commandExecution', id: 'command-1', pluginId: null, scriptPath: null,
        command: 'git status --short', cwd: process.cwd(), processId: null,
        source: 'agent', status: 'inProgress', commandActions: [],
        aggregatedOutput: null, exitCode: null, durationMs: null,
      },
    } });
    send({ method: 'item/commandExecution/outputDelta', params: {
      threadId: THREAD_ID, turnId: TURN_ID, itemId: 'command-1', delta: ' M src/answer.js\n',
    } });
    send({ method: 'item/commandExecution/outputDelta', params: {
      threadId: THREAD_ID, turnId: TURN_ID, itemId: 'command-1', delta: '?? src/ready.js\n',
    } });
    send({ method: 'item/completed', params: {
      threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 1_700_000_001_400,
      item: {
        type: 'commandExecution', id: 'command-1', pluginId: null, scriptPath: null,
        command: 'git status --short', cwd: process.cwd(), processId: null,
        source: 'agent', status: 'completed', commandActions: [],
        aggregatedOutput: ' M src/answer.js\n?? src/ready.js\n', exitCode: 0, durationMs: 12,
      },
    } });

    const changes = [
      { path: 'src/answer.js', kind: { type: 'update', move_path: null }, diff: UPDATE_DIFF },
      { path: 'src/ready.js', kind: { type: 'add' }, diff: ADD_CONTENT },
    ];
    send({ method: 'item/started', params: {
      threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: 1_700_000_001_500,
      // В 0.149 started может прийти раньше готового patch. Cockpit не должен
      // зафиксировать пустую shallow-копию tool до rich patchUpdated.
      item: { type: 'fileChange', id: 'file-change-1', changes: [], status: 'inProgress' },
    } });
    send({ method: 'item/fileChange/patchUpdated', params: {
      threadId: THREAD_ID, turnId: TURN_ID, itemId: 'file-change-1', changes,
    } });
    send({ method: 'turn/diff/updated', params: {
      threadId: THREAD_ID, turnId: TURN_ID,
      diff: `diff --git a/src/answer.js b/src/answer.js\n${UPDATE_DIFF}diff --git a/src/ready.js b/src/ready.js\n${ADD_DIFF}`,
    } });
    send({ method: 'item/completed', params: {
      threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 1_700_000_001_600,
      item: { type: 'fileChange', id: 'file-change-1', changes, status: 'completed' },
    } });

    const reply = resumed ? 'Готово: продолжение сохранено.' : 'Готово: изменения сохранены.';
    send({ method: 'item/started', params: {
      threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: 1_700_000_001_700,
      item: {
        type: 'agentMessage', id: 'answer-1', text: '', phase: 'final_answer',
        memoryCitation: null, delivery: null,
      },
    } });
    send({ method: 'item/agentMessage/delta', params: {
      threadId: THREAD_ID, turnId: TURN_ID, itemId: 'answer-1', delta: reply,
    } });
    send({ method: 'item/completed', params: {
      threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 1_700_000_001_800,
      item: {
        type: 'agentMessage', id: 'answer-1', text: reply, phase: 'final_answer',
        memoryCitation: null, delivery: null,
      },
    } });
    send({ method: 'turn/completed', params: {
      threadId: THREAD_ID,
      turn: {
        ...runningTurn,
        status: 'completed',
        completedAt: 1_700_000_002,
        durationMs: 1_000,
      },
    } });
    setTimeout(() => process.exit(0), 20);
  }

  // Ход, где модель отчиталась только commentary и закрыла turn без final_answer.
  // Так заканчиваются ходы с делегированием суб-агентам: работа сделана, итог есть,
  // а явного финального сообщения нет.
  function emitCommentaryOnlyTurn() {
    const text = 'Прогнал тесты, все зелёные; продолжаю по плану.';
    send({ method: 'item/started', params: {
      threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: 1_700_000_001_100,
      item: {
        type: 'agentMessage', id: 'commentary-only-1', text: '', phase: 'commentary',
        memoryCitation: null, delivery: null,
      },
    } });
    send({ method: 'item/agentMessage/delta', params: {
      threadId: THREAD_ID, turnId: TURN_ID, itemId: 'commentary-only-1', delta: text,
    } });
    send({ method: 'item/completed', params: {
      threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 1_700_000_001_200,
      item: {
        type: 'agentMessage', id: 'commentary-only-1', text, phase: 'commentary',
        memoryCitation: null, delivery: null,
      },
    } });
    send({ method: 'turn/completed', params: {
      threadId: THREAD_ID,
      turn: {
        ...runningTurn, status: 'completed', completedAt: 1_700_000_002, durationMs: 1_000,
      },
    } });
    setTimeout(() => process.exit(0), 20);
  }

  function emitInterruptibleTurn() {
    send({ method: 'item/started', params: {
      threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: 1_700_000_001_100,
      item: {
        type: 'commandExecution', id: 'long-command-1', pluginId: null, scriptPath: null,
        command: 'node long-task.mjs', cwd: process.cwd(), processId: 'process-1',
        source: 'agent', status: 'inProgress', commandActions: [],
        aggregatedOutput: null, exitCode: null, durationMs: null,
      },
    } });
    send({ method: 'item/commandExecution/outputDelta', params: {
      threadId: THREAD_ID, turnId: TURN_ID, itemId: 'long-command-1', delta: 'работаю…\n',
    } });
  }

  /**
   * app-server публикует события субагентов в том же JSONL-потоке. Они обязаны
   * остаться видимыми самому Codex, но не могут завершить или загрязнить ход Cockpit.
   */
  function emitForeignTurn(status) {
    const text = `Чужой субагент: ${status}.`;
    const foreignThread = {
      ...thread,
      id: FOREIGN_THREAD_ID,
      sessionId: FOREIGN_THREAD_ID,
      parentThreadId: THREAD_ID,
    };
    const foreignTurn = {
      ...runningTurn,
      id: FOREIGN_TURN_ID,
    };

    send({ method: 'thread/started', params: { thread: foreignThread } });
    send({
      method: 'turn/started',
      params: { threadId: FOREIGN_THREAD_ID, turn: foreignTurn },
    });
    send({ method: 'item/agentMessage/delta', params: {
      threadId: FOREIGN_THREAD_ID,
      turnId: FOREIGN_TURN_ID,
      itemId: 'foreign-answer-1',
      delta: text,
    } });
    send({ method: 'item/completed', params: {
      threadId: FOREIGN_THREAD_ID,
      turnId: FOREIGN_TURN_ID,
      completedAtMs: 1_700_000_001_900,
      item: {
        type: 'agentMessage', id: 'foreign-answer-1', text, phase: 'final_answer',
        memoryCitation: null, delivery: null,
      },
    } });
    send({ method: 'thread/tokenUsage/updated', params: {
      threadId: FOREIGN_THREAD_ID,
      tokenUsage: {
        total: {
          inputTokens: 900_000,
          cachedInputTokens: 800_000,
          outputTokens: 2_000,
          reasoningOutputTokens: 1_000,
        },
        last: {
          inputTokens: 900_000,
          cachedInputTokens: 800_000,
          outputTokens: 2_000,
          reasoningOutputTokens: 1_000,
        },
        modelContextWindow: 1_000_000,
      },
    } });
    send({ method: 'turn/completed', params: {
      threadId: FOREIGN_THREAD_ID,
      turn: {
        ...foreignTurn,
        status,
        completedAt: 1_700_000_002,
        durationMs: 1_000,
      },
    } });

    // Позднее событие прежнего хода может назвать правильный thread, поэтому
    // одного threadId для маршрутизации недостаточно: обязан совпасть и turnId.
    const staleText = `Чужой субагент в текущем thread: ${status}.`;
    const staleTurn = { ...runningTurn, id: STALE_TURN_ID };
    send({ method: 'turn/started', params: { threadId: THREAD_ID, turn: staleTurn } });
    send({ method: 'item/agentMessage/delta', params: {
      threadId: THREAD_ID,
      turnId: STALE_TURN_ID,
      itemId: 'stale-answer-1',
      delta: staleText,
    } });
    send({ method: 'item/completed', params: {
      threadId: THREAD_ID,
      turnId: STALE_TURN_ID,
      completedAtMs: 1_700_000_001_950,
      item: {
        type: 'agentMessage', id: 'stale-answer-1', text: staleText, phase: 'final_answer',
        memoryCitation: null, delivery: null,
      },
    } });
    send({ method: 'turn/completed', params: {
      threadId: THREAD_ID,
      turn: {
        ...staleTurn,
        status,
        completedAt: 1_700_000_002,
        durationMs: 1_000,
      },
    } });
    emitRichTurn();
  }

  function dynamicToolPayload(message, expectedSuccess) {
    const result = message?.result;
    const contentItems = result?.contentItems;
    if (message?.error || result?.success !== expectedSuccess
      || !Array.isArray(contentItems) || contentItems.length !== 1
      || contentItems[0]?.type !== 'inputText'
      || typeof contentItems[0]?.text !== 'string') {
      fail('item/tool/call получил невалидный DynamicToolCallResponse');
      return null;
    }
    try {
      return JSON.parse(contentItems[0].text);
    } catch {
      fail('DynamicToolCallResponse обязан содержать JSON broker-result');
      return null;
    }
  }

  function validElicitationResponse(message) {
    const result = message?.result;
    const content = result?.content;
    if (message?.id !== 91009 || message?.method || result?.action !== 'accept'
      || result?._meta !== null || content?.file_key !== 'file-42'
      || content?.include_hidden !== false || Object.keys(content || {}).length !== 2) {
      fail('MCP elicitation получил неточный JSON-RPC ответ');
      return false;
    }
    return true;
  }

  // В Node 22 fd 0 дочернего процесса с socketpair превращается в уже завершённый
  // `process.stdin`. Отдельный fs-stream сохраняет настоящий pipe до первой записи.
  fixtureInput = createReadStream(null, { fd: 0, autoClose: false });
  const lines = createInterface({ input: fixtureInput });
  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail('клиент прислал невалидный JSONL');
      return;
    }
    trace({ direction: 'client', message });

    if (phase === 'initialize') {
      if (message.method !== 'initialize' || message.id === undefined) {
        fail('первым должен прийти initialize request');
        return;
      }
      send({ id: message.id, result: {
        userAgent: `codex-cli/${cliVersion}`, codexHome: '/tmp/codex-home',
        platformFamily: 'unix', platformOs: 'linux',
      } });
      phase = 'initialized';
      return;
    }

    if (phase === 'initialized') {
      if (message.method !== 'initialized' || message.id !== undefined
        || Object.hasOwn(message, 'params')) {
        fail('после initialize response нужна initialized notification без params');
        return;
      }
      phase = expectHook ? 'policy' : 'thread';
      return;
    }

    if (phase === 'policy') {
      if (message.method !== 'hooks/list' || message.id === undefined) {
        fail('после handshake default-on запуск обязан проверить hooks/list до thread');
        return;
      }
      send({ id: message.id, result: {
        data: [{
          cwd: process.cwd(),
          hooks: hookState === 'enabled' ? [{
            key: '/<session-flags>/config.toml:pre_tool_use:0:0',
            eventName: 'preToolUse',
            handlerType: 'command',
            command: hookCommand,
            async: false,
            matcher: hookMatcher,
            timeoutSec: 5,
            statusMessage: null,
            additionalContextLimit: null,
            sourcePath: '/<session-flags>/config.toml',
            source: 'sessionFlags',
            pluginId: null,
            displayOrder: 0,
            enabled: true,
            isManaged: false,
            currentHash: 'sha256:fixture',
            trustStatus: 'untrusted',
          }] : [],
          warnings: [],
          errors: [],
        }],
      } });
      phase = 'thread';
      return;
    }

    if (phase === 'thread') {
      if (!['thread/start', 'thread/resume'].includes(message.method) || message.id === undefined) {
        fail('после handshake нужен thread/start или thread/resume');
        return;
      }
      resumed = message.method === 'thread/resume';
      // Настоящий app-server на resume по неизвестному id отвечает JSON-RPC ошибкой и
      // ПРОДОЛЖАЕТ жить: процесс не завершается, handshake остаётся незакрытым.
      if (scenario === 'resume-missing') {
        if (!resumed) {
          fail('сценарий resume-missing ждёт thread/resume');
          return;
        }
        send({ id: message.id, error: {
          code: -32600,
          message: `no rollout found for thread id ${message.params?.threadId}`,
        } });
        return;
      }
      if (resumed && message.params?.threadId !== THREAD_ID) {
        fail('thread/resume получил неверный threadId');
        return;
      }
      if (scenario === 'early-thread-notification') {
        send({ method: 'thread/started', params: { thread } });
      }
      send({ id: message.id, result: {
        thread,
        model: 'gpt-contract-0.149',
        modelProvider: 'openai',
        cwd: process.cwd(),
        instructionSources: [],
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: {
          type: 'workspaceWrite', writableRoots: [process.cwd()], networkAccess: true,
          excludeTmpdirEnvVar: false, excludeSlashTmp: false,
        },
        activePermissionProfile: null,
        reasoningEffort: 'medium',
        multiAgentMode: 'explicitRequestOnly',
        ...(resumed && {
          initialTurnsPage: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null,
        }),
      } });
      if (scenario !== 'early-thread-notification') {
        send({ method: 'thread/started', params: { thread } });
      }
      phase = 'turn';
      return;
    }

    if (phase === 'turn') {
      if (message.method !== 'turn/start' || message.id === undefined) {
        fail('после thread response нужен turn/start');
        return;
      }
      if (message.params?.threadId !== THREAD_ID) {
        fail('turn/start получил неверный threadId');
        return;
      }
      if (scenario === 'work-routing') {
        sendBatch([
          { id: message.id, result: { turn: runningTurn } },
          {
            id: 91010,
            method: 'item/tool/call',
            params: {
              threadId: THREAD_ID,
              turnId: TURN_ID,
              callId: 'reused-work-call',
              tool: 'sample_lookup',
              arguments: { action: 'search', query: 'figma', limit: 3 },
            },
          },
        ]);
        phase = 'work-routing';
        return;
      }
      send({ id: message.id, result: { turn: runningTurn } });
      send({ method: 'turn/started', params: { threadId: THREAD_ID, turn: runningTurn } });
      phase = ['interrupt', 'context-interrupt'].includes(scenario)
        ? 'interrupt'
        : ['ssh-tool', 'lookup-tool', 'mcp-elicitation', 'mcp-resolved'].includes(scenario)
          ? scenario
          : 'complete';
      if (scenario === 'context-usage') {
        emitContextUsage();
        emitRichTurn();
      }
      else if (scenario === 'context-interrupt') {
        emitContextUsage();
        emitInterruptibleTurn();
      }
      else if (scenario === 'interrupt') emitInterruptibleTurn();
      else if (scenario === 'token-progress') emitTokenProgressTurn();
      else if (scenario === 'commentary-only') emitCommentaryOnlyTurn();
      else if (scenario === 'foreign-completed') emitForeignTurn('completed');
      else if (scenario === 'foreign-interrupted') emitForeignTurn('interrupted');
      else if (scenario === 'ssh-tool') {
        send({ method: 'item/started', params: {
          threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: 1_700_000_001_050,
          item: {
            type: 'dynamicToolCall', id: 'ssh-call-1', namespace: null,
            tool: 'supervised_ssh',
            arguments: { action: 'exec', label: 'Боевой код', role: 'code', command: 'id' },
            status: 'inProgress', contentItems: null, success: null, durationMs: null,
          },
        } });
        send({
          id: 91006,
          method: 'item/tool/call',
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            callId: 'ssh-call-1',
            tool: 'supervised_ssh',
            arguments: {
              action: 'exec', label: 'Боевой код', role: 'code', command: 'id',
            },
          },
        });
      }
      else if (scenario === 'lookup-tool') {
        send({ method: 'item/started', params: {
          threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: 1_700_000_001_050,
          item: {
            type: 'dynamicToolCall', id: 'lookup-call-1', namespace: null,
            tool: 'sample_lookup',
            arguments: { action: 'search', query: 'деплой', limit: 3 },
            status: 'inProgress', contentItems: null, success: null, durationMs: null,
          },
        } });
        send({
          id: 91008,
          method: 'item/tool/call',
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            callId: 'lookup-call-1',
            tool: 'sample_lookup',
            arguments: { action: 'search', query: 'деплой', limit: 3 },
          },
        });
      }
      else if (scenario === 'mcp-elicitation') {
        send({
          id: 91009,
          method: 'mcpServer/elicitation/request',
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            serverName: 'figma',
            mode: 'form',
            _meta: null,
            message: 'Какие данные макета использовать?',
            requestedSchema: {
              type: 'object',
              required: ['file_key', 'include_hidden'],
              properties: {
                file_key: {
                  type: 'string',
                  title: 'Ключ файла Figma',
                  minLength: 2,
                },
                include_hidden: {
                  type: 'boolean',
                  title: 'Включить скрытые слои',
                  default: false,
                },
              },
            },
          },
        });
      }
      else if (scenario === 'mcp-resolved') {
        send({
          id: 91013,
          method: 'mcpServer/elicitation/request',
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            serverName: 'figma',
            mode: 'url',
            _meta: null,
            message: 'Подключи Figma в браузере.',
            url: 'https://www.figma.com/oauth?state=opaque',
            elicitationId: 'figma-connect',
          },
        });
        send({
          method: 'serverRequest/resolved',
          params: { threadId: THREAD_ID, requestId: 91013 },
        });
        phase = 'complete';
        setTimeout(() => emitRichTurn(), 10);
      }
      else emitRichTurn();
      return;
    }

    if (phase === 'mcp-elicitation') {
      if (!validElicitationResponse(message)) return;
      phase = 'complete';
      emitRichTurn();
      return;
    }

    if (phase === 'work-routing') {
      const payload = dynamicToolPayload(message, true);
      if (!payload || payload.items?.[0]?.title !== 'Figma MCP') return;
      send({ method: 'turn/started', params: { threadId: THREAD_ID, turn: runningTurn } });
      send({
        id: 91011,
        method: 'item/tool/call',
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          callId: 'reused-work-call',
          tool: 'sample_lookup',
          arguments: { action: 'search', query: 'figma', limit: 3 },
        },
      });
      phase = 'work-duplicate';
      return;
    }

    if (phase === 'work-duplicate') {
      const payload = dynamicToolPayload(message, true);
      if (!payload || payload.items?.[0]?.title !== 'Figma MCP') return;
      send({
        id: 91012,
        method: 'item/tool/call',
        params: {
          threadId: FOREIGN_THREAD_ID,
          turnId: FOREIGN_TURN_ID,
          callId: 'foreign-work-call',
          tool: 'sample_lookup',
          arguments: { action: 'search', query: 'чужой ход', limit: 3 },
        },
      });
      phase = 'work-foreign';
      return;
    }

    if (phase === 'work-foreign') {
      if (message.id !== 91012 || message.error?.code !== -32602) {
        fail('чужой item/tool/call обязан получить -32602 без падения родительского хода');
        return;
      }
      phase = 'complete';
      emitRichTurn();
      return;
    }

    if (phase === 'ssh-tool') {
      if (message.id !== 91006 || message.method) {
        fail('item/tool/call ожидает ровно один JSON-RPC ответ');
        return;
      }
      const payload = dynamicToolPayload(message, false);
      if (!payload) return;
      if (payload.error !== 'denied') {
        fail('supervised_ssh обязан вернуть типизированный broker-result');
        return;
      }
      send({ method: 'item/completed', params: {
        threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 1_700_000_001_075,
        item: {
          type: 'dynamicToolCall', id: 'ssh-call-1', namespace: null,
          tool: 'supervised_ssh',
          arguments: { action: 'exec', label: 'Боевой код', role: 'code', command: 'id' },
          status: 'failed', contentItems: message.result.contentItems,
          success: false, durationMs: 25,
        },
      } });
      phase = 'complete';
      emitRichTurn();
      return;
    }

    if (phase === 'lookup-tool') {
      if (message.id !== 91008 || message.method) {
        fail('item/tool/call образца ожидает ровно один JSON-RPC ответ');
        return;
      }
      const payload = dynamicToolPayload(message, true);
      if (!payload) return;
      if (payload.items?.[0]?.title !== 'Очередь деплоя') {
        fail('sample_lookup обязан вернуть результат вызова');
        return;
      }
      send({ method: 'item/completed', params: {
        threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 1_700_000_001_075,
        item: {
          type: 'dynamicToolCall', id: 'lookup-call-1', namespace: null,
          tool: 'sample_lookup',
          arguments: { action: 'search', query: 'деплой', limit: 3 },
          status: 'completed', contentItems: message.result.contentItems,
          success: true, durationMs: 25,
        },
      } });
      phase = 'complete';
      emitRichTurn();
      return;
    }

    if (phase === 'interrupt') {
      if (message.method !== 'turn/interrupt' || message.id === undefined) {
        fail('активный ход ожидает turn/interrupt');
        return;
      }
      if (message.params?.threadId !== THREAD_ID || message.params?.turnId !== TURN_ID) {
        fail('turn/interrupt получил неверные threadId/turnId');
        return;
      }
      send({ id: message.id, result: {} });
      send({ method: 'turn/completed', params: {
        threadId: THREAD_ID,
        turn: {
          ...runningTurn,
          status: 'interrupted',
          completedAt: 1_700_000_002,
          durationMs: 1_000,
        },
      } });
      phase = 'complete';
      setTimeout(() => process.exit(0), 20);
    }
  });
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) runFixture();
