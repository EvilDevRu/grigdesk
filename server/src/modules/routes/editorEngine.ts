import { spawn } from 'node:child_process';

import { isRecord } from '../../../../shared/lib/objects.ts';

import { ROUTES_EDITOR_LIMITS } from '../../../../shared/pipeline/routesEditorContracts.ts';
import type {
  RouteDraft, RouteSimulationStepRequest, RouteSimulationStepResponse,
} from '../../../../shared/pipeline/routesEditorContracts.ts';

import { factoryHelper, factoryRuntimePaths } from '../../lib/factoryRuntime.ts';
import type { FactoryCommands } from '../../lib/factoryRuntime.ts';
import { runtimeKind, runtimeRoot } from '../../lib/runtimePaths.ts';

interface EditorOptions {
  runtime?: FactoryCommands;
  toolPath?: string;
  timeoutMs?: number;
}

/**
 * Строит argv редактора для уже выбранной установки.
 * Прямой вызов без descriptor берёт текущую Go-фабрику checkout или поставки.
 */
export function editorRouteCommand(runtime: FactoryCommands | undefined, args: string[]) {
  const selected = runtime ?? factoryRuntimePaths({
    kind: runtimeKind(),
    root: runtimeRoot(),
    env: process.env,
  });

  return factoryHelper(selected, 'route', args);
}

const MAX_OUTPUT = 16 * 1024 * 1024;

export class RoutesEditorEngineError extends Error {
  readonly code = 'routes_engine_unavailable';
}

export interface EditorPreviewRequest {
  scope: 'route' | 'bootstrap';
  routeId: string | null;
  nodeId: string;
  context: Record<string, unknown>;
}

export interface EditorPreviewResult {
  text: string;
  includedBlocks: string[];
  excludedBlocks: string[];
  issues: Array<{ code: string; path: string; message: string; severity?: string }>;
}

/**
 * Вызывает фиксированную чистую команду движка через stdin без shell.
 * Таймаут и лимиты не позволяют зависшему дочернему процессу выдать успех.
 */
function invokeEditorTool(
  draft: RouteDraft,
  command: 'editor-check' | 'editor-render' | 'editor-step',
  request: object,
  options: EditorOptions = {},
): Promise<{ code: number; value: unknown }> {
  const catalogInput = {
    profile: draft.profile,
    routes: draft.routes,
    bootstrap: draft.bootstrap,
    bootstrapPrompts: draft.bootstrapPrompts,
  };
  const payload = JSON.stringify(command === 'editor-check' ? catalogInput : { catalogInput, ...request });
  if (Buffer.byteLength(payload) > ROUTES_EDITOR_LIMITS.draftBytes) {
    throw new RoutesEditorEngineError('Вход движка превышает лимит');
  }

  return new Promise((resolve, reject) => {
    const args = ['--profile', draft.profile, command];
    const helper = options.toolPath ? { command: options.toolPath, args }
      : editorRouteCommand(options.runtime, args);
    const child = spawn(helper.command, helper.args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const rejectUnavailable = (reason: string) => {
      if (failed) return;
      failed = true;
      child.kill('SIGKILL');
      reject(new RoutesEditorEngineError(reason));
    };
    const timer = setTimeout(() => rejectUnavailable('Движок превысил срок ответа'),
      options.timeoutMs ?? 10_000);
    child.stdout.on('data', (part: Buffer) => {
      size += part.length;
      if (size > MAX_OUTPUT) {
        rejectUnavailable('Ответ движка превышает лимит');
      } else {
        chunks.push(part);
      }
    });
    child.stderr.resume();
    child.on('error', () => rejectUnavailable('Движок недоступен'));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failed) return;
      try {
        if (code !== 0 && code !== 78) throw new Error('Неверный код');
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve({ code, value });
      } catch {
        reject(new RoutesEditorEngineError('Неверный ответ движка'));
      }
    });
    child.stdin.on('error', () => rejectUnavailable('Движок не принял запрос'));
    child.stdin.end(payload);
  });
}

/**
 * Рендерит текст из точной ревизии черновика.
 * Проверяет формат текста и диагностики перед передачей редактору.
 */
export async function renderDraftPreview(
  draft: RouteDraft,
  request: EditorPreviewRequest,
  options: EditorOptions = {},
): Promise<EditorPreviewResult> {
  const { code, value } = await invokeEditorTool(draft, 'editor-render', request, options);
  if (!isRecord(value) || typeof value.text !== 'string'
    || !Array.isArray(value.includedBlocks)
    || value.includedBlocks.some((item) => typeof item !== 'string')
    || !Array.isArray(value.excludedBlocks)
    || value.excludedBlocks.some((item) => typeof item !== 'string')
    || !Array.isArray(value.issues)
    || value.issues.some((item) => !isRecord(item) || typeof item.code !== 'string'
      || typeof item.path !== 'string' || typeof item.message !== 'string')
    || (code === 0 && value.text.length === 0)
    || (code === 78 && (value.issues.length === 0 || value.text.length > 0))) {
    throw new RoutesEditorEngineError('Неверный ответ движка');
  }
  return value as unknown as EditorPreviewResult;
}

/**
 * Вычисляет один переход той же машиной, что проверяет опубликованный маршрут.
 * Команда читает черновик и возвращает симуляцию без создания попытки.
 */
export async function stepDraftSimulation(
  draft: RouteDraft,
  request: Omit<RouteSimulationStepRequest, 'expectedRevision'>,
  options: EditorOptions = {},
): Promise<Omit<RouteSimulationStepResponse, 'draftRevision'>> {
  const { code, value } = await invokeEditorTool(draft, 'editor-step', request, options);
  if (!isRecord(value) || typeof value.ok !== 'boolean'
    || !Array.isArray(value.issues)
    || value.issues.some((item) => !isRecord(item)
      || typeof item.code !== 'string' || typeof item.path !== 'string'
      || typeof item.message !== 'string')
    || (code === 0 && value.ok !== true)
    || (code === 78 && (value.ok !== false || value.issues.length === 0))
    || (value.ok && (!isRecord(value.cursor) || !isRecord(value.counters)
      || !isRecord(value.action) || !Array.isArray(value.reset)
      || typeof value.requiresHuman !== 'boolean'))) {
    throw new RoutesEditorEngineError('Неверный ответ движка');
  }
  return value as unknown as Omit<RouteSimulationStepResponse, 'draftRevision'>;
}


/**
 * Проверяет снимок черновика перед записью бандлов.
 * Публикация требует подтверждения выбранного движка.
 */
export async function checkDraftEngine(draft: RouteDraft, runtime?: FactoryCommands): Promise<void> {
  const { code, value } = await invokeEditorTool(draft, 'editor-check', {}, { runtime });

  if (code !== 0 || !isRecord(value) || value.ok !== true) {
    throw new RoutesEditorEngineError('Движок не подтвердил черновик');
  }
}
