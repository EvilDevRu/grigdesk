import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ROUTES_EDITOR_LIMITS } from '../../../../shared/routesEditorContracts.ts';
import type {
  RouteDraft, RouteSimulationStepRequest, RouteSimulationStepResponse,
} from '../../../../shared/routesEditorContracts.ts';

const ROUTE_TOOL = fileURLToPath(new URL('../../../../engine/bin/factory-route', import.meta.url));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Вызывает фиксированную чистую команду движка через stdin без shell.
 * Таймаут и лимиты не позволяют зависшему дочернему процессу выдать успех.
 */
function invokeEditorTool(
  draft: RouteDraft,
  command: 'editor-render' | 'editor-step',
  request: object,
  options: { toolPath?: string; timeoutMs?: number } = {},
): Promise<{ code: number; value: unknown }> {
  const payload = JSON.stringify({
    catalogInput: {
      profile: draft.profile,
      routes: draft.routes,
      bootstrap: draft.bootstrap,
      bootstrapPrompts: draft.bootstrapPrompts,
    },
    ...request,
  });
  if (Buffer.byteLength(payload) > ROUTES_EDITOR_LIMITS.draftBytes) {
    throw new RoutesEditorEngineError('Вход движка превышает лимит');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(options.toolPath ?? ROUTE_TOOL, [
      '--profile', draft.profile, command,
    ], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
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

/** Рендерит точный текст из сохранённой ревизии черновика. */
export async function renderDraftPreview(
  draft: RouteDraft,
  request: EditorPreviewRequest,
  options: { toolPath?: string; timeoutMs?: number } = {},
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

/** Вычисляет один переход без создания runtime-попытки и профильных команд. */
export async function stepDraftSimulation(
  draft: RouteDraft,
  request: Omit<RouteSimulationStepRequest, 'expectedRevision'>,
  options: { toolPath?: string; timeoutMs?: number } = {},
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
