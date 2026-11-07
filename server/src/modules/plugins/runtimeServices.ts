import { createHash } from 'node:crypto';

import type {
  PluginModelRef, PluginModelTextInput, PluginModelReceipt, PluginRuntimeServices,
} from '../../../../packages/plugin-types/src/coreRuntime.ts';
import { canonicalJson } from '../../../../shared/lib/canonicalJson.ts';
import { acquireDirectoryLock } from '../../../../shared/node/directoryLock.ts';
import { readContainedText } from '../../../../shared/node/readContainedText.ts';
import { resolveInboxTriageTarget } from '../../lib/inbox/triage.ts';

export interface PluginRuntimePorts {
  config: unknown;
  project: PluginRuntimeServices['project'];
  listProjects: PluginRuntimeServices['listProjects'];
  environment: PluginRuntimeServices['environment'];
  sandboxes: PluginRuntimeServices['sandboxes'];
  holdSandbox: PluginRuntimeServices['holdSandbox'];
  resolveTarget?: typeof resolveInboxTriageTarget;
  log?: { warn?: (details: unknown, message: string) => void };
}

/**
 * Общие серверные сервисы v1 используют живые экземпляры приложения.
 * Регистрация не читает проекты, файлы и каталог моделей и не запускает исполнителя.
 */
export function createPluginRuntimeServices(ports: PluginRuntimePorts): PluginRuntimeServices {
  const resolveTarget = ports.resolveTarget ?? resolveInboxTriageTarget;
  const config = ports.config as Record<string, unknown>;

  /**
   * Каталог и model-only capability проверяются до оплачиваемого вызова.
   * Исполнитель остаётся внутри ядра, а изменение выбранного effort запрещает запуск.
   */
  async function resolveSelected(ref: PluginModelRef) {
    const target = await resolveTarget({
      modelRef: ref,
      config,
      log: ports.log,
    });

    if (!target.ok || !target.ref || typeof target.executor?.runUntrusted !== 'function') {
      throw new Error(target.error || 'model_unavailable');
    }

    if (ref.effort && ref.effort !== target.effort) {
      throw new Error('model_selection_changed');
    }

    return {
      ref: target.ref,
      effort: target.effort || null,
      run: target.executor.runUntrusted.bind(target.executor),
    };
  }

  return Object.freeze({
    project: ports.project,
    listProjects: ports.listProjects,
    environment: ports.environment,
    sandboxes: ports.sandboxes,
    holdSandbox: ports.holdSandbox,
    readSourceText: readContainedText,
    async validateModel(ref: PluginModelRef) {
      const selected = await resolveSelected(ref);

      return { ref: selected.ref, effort: selected.effort };
    },
    lock: (directory: string) => acquireDirectoryLock(directory, { waitMs: 1000 }),
    digest: (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex'),
    /**
     * Model-only вызов не получает tools, cwd или сессию coding-агента.
     * Квитанция фиксируется до разбора ответа, включая неверный оплаченный результат.
     */
    async modelText(input: PluginModelTextInput) {
      if (!input.modelRef?.provider || !input.modelRef.model
        || typeof input.message !== 'string' || input.message.length > 131072) {
        throw new Error('model_input_invalid');
      }

      const timeoutMs = input.timeoutMs ?? 300000;

      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
        throw new Error('model_timeout_invalid');
      }

      input.signal?.throwIfAborted();

      const target = await resolveSelected(input.modelRef);

      input.signal?.throwIfAborted();

      const signal = AbortSignal.any([
        ...(input.signal ? [input.signal] : []),
        AbortSignal.timeout(timeoutMs),
      ]);

      input.beforeCall?.();
      signal.throwIfAborted();

      const output = await target.run({
        config,
        model: target.ref.model,
        effort: target.effort || undefined,
        message: input.message,
        images: [],
        providerSettings: {},
        timeoutMs,
        signal,
        log: ports.log,
      }) as Record<string, unknown>;
      const safe = output && typeof output === 'object' ? output : {};
      const receipt: PluginModelReceipt = {
        resolvedRef: target.ref,
        effort: target.effort,
        reportedModel: typeof safe.actualModel === 'string' && safe.actualModel.trim()
          ? safe.actualModel.trim().slice(0, 200) : null,
        modelEvidence: 'executor_reported',
        cost: typeof safe.cost === 'number' && Number.isFinite(safe.cost) && safe.cost >= 0
          ? safe.cost : null,
      };

      input.onReceipt?.(receipt);

      if (typeof safe.reply !== 'string' || safe.reply.length > 131072) {
        throw new Error('model_output_invalid');
      }

      return { reply: safe.reply, ...receipt };
    },
  });
}
