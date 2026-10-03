import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ChildProcess } from 'node:child_process';

import { resolveDeepSeekRuntimeAsync } from '../../server/src/lib/deepseek/runtimeProcess.ts';
import { glmCompatibilityIdentity } from '../../server/src/lib/glm/contract.ts';
import { buildGlmChildEnv } from '../../server/src/lib/glm/env.ts';
import { describeGlmGeneration } from '../../server/src/lib/glm/generation.ts';
import { prepareGlmLaunch, startGlmProcess } from '../../server/src/lib/glm/launch.ts';
import type { GlmLaunchOptions } from '../../server/src/lib/glm/launch.ts';

export const GLM_SERVICE_KEY = 'synthetic-zai-service-key';

/**
 * Плагин запрета внешнего fetch для подмены адреса модели (Р16): только loopback.
 * Пишется рядом со стендом и передаётся launcher-у как egressGuard.
 */
export async function writeGlmEgressGuard(root: string): Promise<string> {
  const guard = path.join(root, 'glm-egress-guard.mjs');

  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(guard, [
    'export const name = "cockpit-glm-egress-guard";',
    'export function apply() {',
    '  const original = globalThis.fetch;',
    '  globalThis.fetch = (input, ...args) => {',
    '    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));',
    '    if (url.hostname !== "127.0.0.1") {',
    '      throw new Error("Стенд GLM допускает только loopback fetch");',
    '    }',
    '    return original(input, ...args);',
    '  };',
    '}',
  ].join('\n') + '\n', { mode: 0o600 });

  return guard;
}

/**
 * Production-путь запуска на настоящей generation: identity, подготовка запуска,
 * окружение allowlist и web-процесс. Подменены только адрес модели и сторож fetch.
 */
export async function startGlmProductionProcess(options: {
  artifact: string;
  root: string;
  cwd: string;
  projectRoot?: string;
  endpoint: string;
  chatKey?: string;
  source?: Record<string, string | undefined>;
  beforeLaunch?: (paths: { dshHome: string }) => Promise<void>;
  launch?: Partial<GlmLaunchOptions>;
}) {
  const config = { deepseekArtifactDir: options.artifact, deepseekRuntimeMode: 'embedded' as const };
  const generation = describeGlmGeneration(config);
  const identity = glmCompatibilityIdentity(generation.runtime, 'api');
  const runtime = await resolveDeepSeekRuntimeAsync(config);
  const runtimeHome = path.join(options.root, 'glm-runtime');
  const warnings: string[] = [];
  const children: ChildProcess[] = [];
  const base = {
    runtimeHome,
    identity,
    chatKey: options.chatKey ?? 'fixture-chat',
    cwd: options.cwd,
    workspaceRoot: options.cwd,
    projectRoot: options.projectRoot ?? options.cwd,
    accessMode: 'api' as const,
    model: 'glm-5.3',
    transport: 'web' as const,
    hooks: {
      ssh: true,
      db: false,
      strictDb: false,
    },
    modelEndpoint: options.endpoint,
    egressGuard: await writeGlmEgressGuard(path.join(options.root, 'guard')),
    warn: (message: string) => warnings.push(message),
  };

  if (options.beforeLaunch) {
    const { glmChatHome } = await import('../../server/src/lib/glm/launch.ts');
    const dshHome = glmChatHome(runtimeHome, identity, base.chatKey);

    await fs.mkdir(dshHome, { recursive: true, mode: 0o700 });
    await options.beforeLaunch({ dshHome });
  }

  const launch = await prepareGlmLaunch({ ...base, ...options.launch });
  const env = buildGlmChildEnv({
    source: {
      PATH: process.env.PATH,
      HOME: options.root,
      ZAI_API_KEY: GLM_SERVICE_KEY,
      ...options.source,
    },
    dshHome: launch.dshHome,
    mode: 'api',
  });
  let diagnostics = '';
  const server = await startGlmProcess({
    runtime,
    launch,
    cwd: options.cwd,
    env,
    spawnProcess: ((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);

      children.push(child);
      child.stderr?.on('data', (chunk) => {
        diagnostics = (diagnostics + String(chunk)).slice(-16_384);
      });

      return child;
    }) as typeof spawn,
  }).catch((error: Error) => {
    throw new Error(`${error.message}\n${diagnostics.replace(/token=\S+/gu, 'token=<redacted>')}`);
  });

  return {
    server,
    launch,
    identity,
    warnings,
    children,
  };
}

/**
 * Ответ модели с вызовом инструмента; аргументы дробятся на два кусочка, как у Z.ai.
 * id вызова задаётся тестом для сверки с событиями DSH.
 */
export function glmToolCall(name: string, args: Record<string, unknown>, id = 'call-1') {
  const encoded = JSON.stringify(args);
  const half = Math.floor(encoded.length / 2);

  return {
    kind: 'stream' as const,
    deltas: [
      {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: encoded.slice(0, half) },
        }],
      },
      { tool_calls: [{ index: 0, function: { arguments: encoded.slice(half) } }] },
    ],
    finishReason: 'tool_calls',
  };
}

/**
 * Текстовый ответ модели одной дельтой; поток закрывается штатным stop.
 * Используется как последний шаг сценария после вызовов инструментов.
 */
export function glmTextReply(text = 'glm-ok') {
  return {
    kind: 'stream' as const,
    deltas: [{ role: 'assistant', content: text }],
  };
}

/**
 * Записи hook из событий хода: stderr лежит в hook/result.stderrSummary.
 * Строка с префиксом GLM-POLICY (или GLM-HOOK) — JSON, индекс события сохраняется.
 */
export function glmHookEntries(events: readonly Record<string, any>[]) {
  const entries: Record<string, any>[] = [];

  events.forEach((event, index) => {
    const summary = String(event.data?.stderrSummary ?? '');
    const line = summary.split('\n').find((item) => /^GLM-(HOOK|POLICY) /u.test(item));

    if (event.type === 'hook/result') {
      entries.push({
        index,
        point: event.data.point,
        exitCode: event.data.exitCode,
        decision: event.data.decision,
        ...(line ? JSON.parse(line.slice(line.indexOf(' ') + 1)) : {}),
      });
    }
  });

  return entries;
}
