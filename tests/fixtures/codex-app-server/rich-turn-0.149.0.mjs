#!/usr/bin/env node

// Версионированный fake app-server по TypeScript-схеме `codex-cli 0.149.0`.
// Он закрепляет wire-форму JSON-RPC v2 без настоящего model call и аккаунта OpenAI.
import { appendFileSync } from 'node:fs';
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
const UPDATE_DIFF = '@@ -1 +1 @@\n-export const answer = 41;\n+export const answer = 42;\n';
const ADD_DIFF = '@@ -0,0 +1,2 @@\n+export function ready() {\n+  return true;\n+}\n';

function runFixture() {
  const traceFile = process.env.COCKPIT_CODEX_FIXTURE_TRACE || '';
  const scenario = process.env.COCKPIT_CODEX_FIXTURE_SCENARIO || 'rich';
  const argv = process.argv.slice(2);
  let phase = 'initialize';
  let resumed = false;

  function trace(entry) {
    if (!traceFile) return;
    appendFileSync(traceFile, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  function send(message) {
    trace({ direction: 'server', message });
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  function fail(message) {
    trace({ direction: 'fixture-error', message });
    process.stderr.write(`${message}\n`);
    process.exitCode = 64;
    process.stdin.destroy();
  }

  trace({ direction: 'process', argv, compatibility: CODEX_APP_SERVER_COMPATIBILITY, scenario });
  if (argv.length !== 1 || argv[0] !== 'app-server') {
    fail(`Codex transport: получена подкоманда ${argv[0] || '<пусто>'}; требуется app-server`);
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
    cliVersion: '0.149.0',
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
      { path: 'src/ready.js', kind: { type: 'add' }, diff: ADD_DIFF },
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

  const lines = createInterface({ input: process.stdin });
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
        userAgent: 'codex-cli/0.149.0', codexHome: '/tmp/codex-home',
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
      phase = 'thread';
      return;
    }

    if (phase === 'thread') {
      if (!['thread/start', 'thread/resume'].includes(message.method) || message.id === undefined) {
        fail('после handshake нужен thread/start или thread/resume');
        return;
      }
      resumed = message.method === 'thread/resume';
      if (resumed && message.params?.threadId !== THREAD_ID) {
        fail('thread/resume получил неверный threadId');
        return;
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
      send({ method: 'thread/started', params: { thread } });
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
      send({ id: message.id, result: { turn: runningTurn } });
      send({ method: 'turn/started', params: { threadId: THREAD_ID, turn: runningTurn } });
      phase = scenario === 'interrupt' ? 'interrupt' : 'complete';
      if (scenario === 'interrupt') emitInterruptibleTurn();
      else if (scenario === 'commentary-only') emitCommentaryOnlyTurn();
      else emitRichTurn();
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
